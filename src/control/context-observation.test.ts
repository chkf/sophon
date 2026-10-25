import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextObservationCollector, persistContextObservation, readContextObservation, type ContextObservation } from "./context-observation.js";
import { ControlData } from "./data.js";
import { initializeGateway } from "../setup.js";
import { SessionStore } from "../sessions/store.js";
import { LocalCoreContextProvider } from "../core/context.js";
import { Gateway } from "../gateway.js";
import { mainPath, openDatabase } from "../state/database.js";
import type { ChatRuntime } from "../runtime/types.js";
import { tagInboundRetryability } from "../runtime/retry-policy.js";

async function fixture(run: (root: string, sessions: SessionStore, context: LocalCoreContextProvider) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "sophon-context-observation-"));
  const root = join(directory, "data");
  await initializeGateway(root);
  const sessions = new SessionStore(root), context = new LocalCoreContextProvider(root);
  try { await run(root, sessions, context); }
  finally { sessions.close(); await rm(directory, { recursive: true, force: true }); }
}

test("context observation records final actual model call, ignores content, and preserves missing fields", () => {
  let time = 1_000;
  const collector = new ContextObservationCollector(() => new Date(time));
  assert.equal(collector.captureContent, false);
  const first = collector.start({ kind: "model", name: "fixture", provider: "api", model: "requested-model",
    get input() { throw new Error("must never inspect prompt"); } });
  time += 10;
  collector.finish(first, { status: "completed", usage: { inputTokens: 100, outputTokens: 20 },
    get output() { throw new Error("must never inspect output"); } });
  const tool = collector.start({ kind: "tool", name: "synthetic_tool" });
  collector.finish(tool, { status: "completed" });
  const last = collector.start({ kind: "model", name: "fixture", provider: "api", model: "requested-model" });
  time += 20;
  collector.finish(last, { status: "completed", model: "actual-model", usage: { inputTokens: 0, outputTokens: 4 } });
  const observation = collector.completed({ contextEffect: "none" })!;
  assert.equal(observation.model, "actual-model");
  assert.equal(observation.durationMs, 20);
  assert.deepEqual(observation.usage, { inputTokens: 0, outputTokens: 4 });
  assert.equal("cachedInputTokens" in observation.usage!, false);
  assert.equal("output" in observation, false);
  assert.equal(new ContextObservationCollector().completed({}), null, "journal replay has no fresh request metrics");
});

test("observation persistence keeps only allowlisted metadata and never reinterprets unknown usage as zero", () => fixture(async (root, sessions, context) => {
  const collector = new ContextObservationCollector();
  const id = collector.start({ kind: "model", name: "fixture", provider: "siwc", model: "fixture-model" });
  collector.finish(id, { status: "completed" });
  const observation = collector.completed({ contextEffect: "checkpoint_compacted" })!;
  persistContextObservation(root, { ...observation, instructions: "synthetic-secret-not-for-storage" } as ContextObservation);
  const db = openDatabase(mainPath(root), true);
  try {
    assert.equal(readContextObservation(db)?.usage, null);
    assert.equal(JSON.stringify(db.prepare("SELECT value FROM gateway_state WHERE key LIKE 'diagnostic/control/%'").all())
      .includes("synthetic-secret-not-for-storage"), false);
  } finally { db.close(); }
  const data = new ControlData(root, { sessions, context });
  try { assert.equal(data.context().lastRequest?.model, "fixture-model"); assert.equal(data.context().usage.supported, false); }
  finally { data.close(); }
}));

test("formal reply stores observed usage without changing history or adding provider requests", () => fixture(async (root, sessions, context) => {
  let calls = 0;
  const runtime: ChatRuntime = { reply: async request => {
    calls++;
    assert.equal(request.purpose, "chat");
    const id = request.trace?.start({ kind: "model", name: "fixture", provider: "api", model: "fixture-model" });
    request.trace?.finish(id, { status: "completed", usage: { inputTokens: 42, outputTokens: 5 } });
    return { text: "文档已整理。", model: "fixture-model", contextEffect: "none",
      usage: { inputTokens: 999, outputTokens: 999, cachedInputTokens: 0 } };
  } };
  const gateway = new Gateway(runtime, sessions, context, 0, "UTC", undefined, undefined, undefined, undefined,
    undefined, observation => persistContextObservation(root, observation));
  const result = await gateway.handle({ channel: "telegram", conversationId: "123", senderId: "123", messageId: "fixture",
    text: "整理文档", attachments: [] });
  assert.equal(result.kind, "model_reply");
  assert.equal(calls, 1);
  const db = openDatabase(mainPath(root), true);
  try { assert.deepEqual(readContextObservation(db)?.usage, { inputTokens: 42, outputTokens: 5 }); }
  finally { db.close(); }
  assert.equal((await sessions.view("telegram", "123")).history.count, 1, "observation does not write chat history");
}));

test("failed observation callback cannot turn a successful reply into failure", () => fixture(async (_root, sessions, context) => {
  let observed = 0;
  const runtime: ChatRuntime = { reply: async request => {
    const id = request.trace?.start({ kind: "model", name: "fixture", model: "fixture-model" });
    request.trace?.finish(id, { status: "completed", usage: { inputTokens: 12 } });
    return { text: "检查完成。" };
  } };
  const gateway = new Gateway(runtime, sessions, context, 0, "UTC", undefined, undefined, undefined, undefined, undefined,
    async () => { observed++; throw new Error("synthetic-observation-storage-error"); });
  const result = await gateway.handle({ channel: "telegram", conversationId: "123", senderId: "123", messageId: "fixture",
    text: "检查文档", attachments: [] });
  assert.equal(observed, 1);
  assert.equal(result.kind, "model_reply");
  if (result.kind === "model_reply") assert.equal(result.text, "检查完成。");
  assert.equal((await sessions.view("telegram", "123")).history.count, 1);
}));

test("failed actual model call replaces old metrics while preserving original retry and replay behavior", () => fixture(async (root, sessions, context) => {
  let calls = 0, observations = 0;
  const original = tagInboundRetryability(new Error("synthetic model connection loss"), true);
  const runtime: ChatRuntime = { reply: async request => {
    calls++;
    if (calls === 3) return { text: "从已完成记录恢复的回复。" }; // No model request on a journal replay.
    const id = request.trace?.start({ kind: "model", name: "fixture", provider: "api", model: "fixture-model" });
    if (calls === 2) {
      request.trace?.finish(id, { status: "failed", error: "synthetic transport failure" });
      throw original;
    }
    request.trace?.finish(id, { status: "completed", usage: { inputTokens: 42, outputTokens: 5 } });
    return { text: "第一次检查完成。" };
  } };
  const gateway = new Gateway(runtime, sessions, context, 0, "UTC", undefined, undefined, undefined, undefined, undefined,
    observation => {
      observations++;
      persistContextObservation(root, observation);
      if (observations === 2) throw new Error("synthetic observation callback failure after persistence");
    });
  const inbound = { channel: "telegram" as const, conversationId: "123", senderId: "123", text: "检查文档", attachments: [] };
  assert.equal((await gateway.handle({ ...inbound, messageId: "success" })).kind, "model_reply");
  const failed = await gateway.handle({ ...inbound, messageId: "failure" });
  assert.deepEqual(failed, { kind: "retry", retryAfterMs: 5000 }, "observation error must not replace the runtime retry hint");
  const db = openDatabase(mainPath(root), true);
  try {
    const saved = readContextObservation(db);
    assert.equal(saved?.status, "failed");
    assert.equal(saved?.usage, null, "failed request cannot retain the previous successful usage");
    assert.equal((await sessions.view("telegram", "123")).history.count, 1, "retry remains pending without transcript writes");
    assert.equal((await gateway.handle({ ...inbound, messageId: "replay" })).kind, "model_reply");
    assert.equal(observations, 2, "journal replay adds no fresh observation");
    assert.deepEqual(readContextObservation(db), saved);
  } finally { db.close(); }
}));
