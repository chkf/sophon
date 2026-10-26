import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRuntime } from "./runtime/providers.js";
import { Gateway } from "./gateway.js";
import { SessionStore } from "./sessions/store.js";
import { GatewayService } from "./service.js";
import { loadConfig } from "./config/index.js";
import { localContext } from "./core/context-fixture.js";
import { ImageTool } from "./runtime/images/tool.js";
import { assertRequestBudget, historyWindow, estimatedTextTokens } from "./runtime/context-budget.js";
import { ProviderDeliveryStore } from "./runtime/delivery-store.js";
import { LaneStore } from "./runtime/siwc/lane-store.js";
import { replyOutcome } from "./channels/reply.js";
import { initializeGateway } from "./setup.js";

test("Heartbeat and CLI have no imports from the Gateway chat orchestrator", async () => {
  for (const file of ["main.ts", "heartbeat/runner.ts", "heartbeat/planner.ts", "heartbeat/policy.ts"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /(?:from|import\s*\()\s*["'][^"']*gateway\.js["']/);
  }
});

const inbound = { channel: "telegram" as const, conversationId: "42", senderId: "42", messageId: "1", text: "hello", receivedAt: "2026-10-09T00:00:00Z", attachments: [] };
async function temp(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "gateway-refactoring-"));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("proactive photo acknowledgement cannot settle an ordinary Provider reply", () => temp(async root => {
  let commits = 0;
  const sdk = { async reply() { return { text: "尚未交付的文字" }; }, async commitSession() { commits++; } };
  const runtime = new ProviderRuntime(root, { siwc: sdk, openrouter: {} } as never);
  await runtime.reply({ sessionId: "telegram:42", text: "你好", purpose: "chat", deferAssistantCommit: true, deliveryId: "ordinary" } as never);
  const config = loadConfig(); config.dataDir = root; config.ilink = undefined; config.memoryGraphEnabled = false;
  config.telegram = { token: "fixture", ownerId: "42" }; config.heartbeat.enabled = false;
  const service = new GatewayService(config, runtime);
  const adapter = (service as any).telegram;
  adapter.api = { async call() { return true; } };
  const bytes = Buffer.from("synthetic photo"); const imagePath = join(root, "photo.png");
  await writeFile(imagePath, bytes);
  await adapter.sendImages("42", [{ kind: "image", path: imagePath, size: bytes.length, width: 1, height: 1,
    sha256: createHash("sha256").update(bytes).digest("hex"), prompt: "fixture", model: "fixture" }], "proactive");
  assert.equal(commits, 0, "proactive acknowledgement must use history-only delivery entry");
  const view=new SessionStore(root);
  try {assert.equal((await view.get("telegram", "42"))?.messages.length, 1);}
  finally {view.close();await service.stop();}
}));

test("standalone service is ready with initialized local Core",()=>temp(async root=>{
  const dataDir=join(root,"initialized");await initializeGateway(dataDir);
  const config=loadConfig();config.dataDir=dataDir;config.ilink=undefined;
  config.telegram={token:"fixture",ownerId:"42"};config.heartbeat.enabled=false;
  let closed=false;
  const runtime={getSession:async()=>({status:"connected",sharing:true}),getProvider:async()=>"openrouter",close:async()=>{closed=true;}};
  const service=await GatewayService.create(config,runtime as never);
  try {
    const health=await (service as any).healthSnapshot();
    assert.equal(health.ok,true);assert.equal(health.localCore,true);
    assert.equal((await (service as any).healthSnapshot(false)).localCore,true);
  } finally {await service.stop();}
  assert.equal(closed,true);
}));

test("history windowing and opaque compaction retain the same local Core source", async () => {
  for (const effect of ["history_windowed", "checkpoint_compacted"] as const) {
    const loads: unknown[] = [];
    const gateway = new Gateway({ async reply() { return { text: "ok", contextEffect: effect }; } },
      { async get() {}, async append() {} } as never,
      { async load(options: unknown) { loads.push(options); return { available: true, data: localContext().data }; } } as never);
    await gateway.handle(inbound);
    assert.equal(loads.length, effect === "checkpoint_compacted" ? 2 : 1);
  }
});

test("image tool rejects nonboolean references before charging and never retries that turn", async () => {
  let paid = 0;
  const tool = new ImageTool({ sessionId: "42", operationId: "image-1" }, false, async () => { paid++; throw new Error("paid"); });
  assert.equal((await tool.execute({ prompt: "cat", use_input_image: "false" })).response, undefined);
  await tool.execute({ prompt: "cat" });
  assert.equal(paid, 0); assert.equal(tool.attempted, true);
});

test("image tool forwards only an actual image and narrow visual fields", async () => {
  const image = { kind: "image" as const, path: "image", size: 1, width: 1, height: 1, sha256: "hash", prompt: "cat", model: "image" };
  let paid: any;
  const tool = new ImageTool({ sessionId: "42", operationId: "operation", instructions: "PRIVATE",
    attachments: [{ kind: "file", path: "document" }, image] }, false,
    async request => { paid = request; return { text: "", images: [image] }; });
  const result = await tool.execute({ prompt: "cat", use_input_image: true });
  assert.deepEqual(Object.keys(paid).sort(), ["autonomous", "operationId", "prompt", "reference"]);
  assert.equal(paid.reference.path, "image"); assert.equal(result.response?.images?.[0], image);
});

test("history budget distinguishes UTF-8 estimates from characters and fails before overflow", () => {
  assert.ok(estimatedTextTokens("你好") > estimatedTextTokens("hi"));
  const messages = Array.from({ length: 40 }, () => ({ role: "user" as const, content: "x".repeat(1000) }));
  const start = historyWindow(messages, 128_000, "rules", [], 0);
  assert.equal(start, 16);
  assert.throws(() => historyWindow(messages, 4096, "rules", [], 0), /预算/);
  assert.throws(() => historyWindow([{ role: "user", content: "x".repeat(24_001) }], 128_000, "", [], 0), /预算/);
});

test("delivery tickets read legacy state and reject invalid providers without fallback", () => temp(async root => {
  const store = new ProviderDeliveryStore(root);
  await store.write("chat", { provider: "siwc", id: "chat:provider:siwc:1" });
  assert.equal((await store.read("chat"))?.version, 1);
  await store.remove("chat"); assert.equal(await store.read("chat"), undefined);
  const { createHash } = await import("node:crypto");
  const path = join(root, createHash("sha256").update("chat").digest("hex") + ".json");
  await writeFile(path, JSON.stringify({ provider: "siwc", id: "legacy" }));
  assert.equal((await store.read("chat"))?.id, "legacy");
  await writeFile(path, JSON.stringify({ provider: "automatic-paid", id: "invalid" }));
  await assert.rejects(store.read("chat"), /Invalid delivery/);
}));

test("invalid v2 checkpoint metadata fails closed without deleting retained evidence", () => temp(async root => {
  const store = new LaneStore(root); const path = store.path("chat");
  await mkdir(join(root, "runtime", "context"), { recursive: true });
  const content = JSON.stringify({ version: 2, model: "test", contextItems: [{ type: "function_call_output", output: "uncertain" }] });
  await writeFile(path, content);
  await assert.rejects(store.read("chat"), /invalid/);
  assert.equal(await readFile(path, "utf8"), content);
}));

test("future lane checkpoint versions must not be quarantined or downgraded", () => temp(async root => {
  const store = new LaneStore(root); const path = store.path("chat");
  await mkdir(join(root, "runtime", "context"), { recursive: true });
  const content = JSON.stringify({ version: 3, model: "test", contextItems: [{ role: "user", content: "retain" }] });
  await writeFile(path, content);
  let failure: unknown;
  try { await store.read("chat"); } catch (error) { failure = error; }
  assert.match(String(failure), /Unsupported or invalid lane checkpoint/);
  assert.equal(await store.quarantineRecoverable("chat", failure), false);
  assert.equal(await readFile(path, "utf8"), content);
}));

test("canonical reply outcomes reject retry and delivery mixed together", () => {
  assert.equal(replyOutcome({ text: "", retryAfterMs: 5000 }).kind, "retry");
  assert.equal(replyOutcome({ text: "ok", commitAssistant: true }).kind, "model_reply");
  assert.throws(() => replyOutcome({ text: "ok", retryAfterMs: 5000 }), /Retry/);
});

test("shutdown closes runtime and releases lock even if channel draining fails", () => temp(async root => {
  const config = loadConfig(); config.dataDir = root; config.wechat = undefined; config.memoryGraphEnabled = false;
  config.telegram = { token: "fixture", ownerId: "42" }; config.heartbeat.enabled = false;
  const events: string[] = [];
  const service = new GatewayService(config, { async close() { events.push("runtime"); } } as never);
  const internals = service as any;
  internals.telegram = { async stop() { events.push("telegram"); throw new Error("channel failure"); } };
  internals.instanceLock = { async release() { events.push("lock"); } };
  await assert.rejects(service.stop(), AggregateError);
  await assert.rejects(service.stop(), AggregateError);
  assert.deepEqual(events, ["telegram", "runtime", "lock"]);
}));

test("tool budget includes schemas and growing results but not base64 bytes", () => {
  assert.doesNotThrow(() => assertRequestBudget([{ content: [{ image_url: { url: "data:image/png;base64," + "x".repeat(100000) } }] }], [], 20000));
  assert.throws(() => assertRequestBudget([{ content: "x".repeat(100000) }], [], 20000), /预算/);
  assert.throws(() => assertRequestBudget([], [{ schema: "x".repeat(100000) }], 20000), /预算/);
});
test("provider close waits for all cleanup even if one fails", async () => {
  await temp(async root => {
    let finish!: () => void; let settled = false;
    const runtime = new ProviderRuntime(root, { siwc: { async close() { throw new Error("siwc close"); } },
      openrouter: { async close() { await new Promise<void>(resolve => { finish = resolve; }); } } } as any);
    const closing = runtime.close().catch(error => { settled = true; assert.ok(error instanceof AggregateError); });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); finish(); await closing; assert.equal(settled, true);
  });
});
