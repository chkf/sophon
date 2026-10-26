import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApiRuntime } from "./api.js";
import { SiwcRuntime } from "./siwc/index.js";
import { responseTools } from "./siwc/responses-codec.js";
import type { ChatRequest } from "./types.js";

const review: ChatRequest = { purpose: "recent_review", sessionId: "review-fixture", operationId: "review-1",
  text: '{"messages":[],"entries":[]}', imageOutputAllowed: false, tools: [] };

test("Recent review runs independently of proactive spending settings with no tools", async t => {
  const root = await mkdtemp(join(tmpdir(), "sophon-review-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  const config = { dataDir: root, baseUrl: "https://api.example/v1", defaultModel: "fixture-model", stream: false,
    fetch: async (_url: unknown, init?: RequestInit) => {
      requests++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.tools, undefined);
      assert.equal(body.messages.at(-1).content, review.text);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"changes":[],"creates":[],"deletes":[]}' }, finish_reason: "stop" }] }));
    } };
  assert.equal((await new ApiRuntime({ ...config, heartbeat: false }).reply({...review, purpose: "heartbeat_decision"})).skipped, "background_disabled");
  assert.equal(requests, 0);
  assert.equal((await new ApiRuntime({ ...config, heartbeat: false }).reply(review)).skipped, undefined);
  assert.equal(requests, 1);
  const result = await new ApiRuntime({ ...config, heartbeat: true }).reply(review);
  assert.equal(result.skipped, undefined);
  assert.equal(requests, 1);
});

test("SIWC review disables hosted search and releases its isolated background lane", async t => {
  const root = await mkdtemp(join(tmpdir(), "sophon-review-siwc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, "credentials");
  await mkdir(storage);
  const payload = { version: 2, activeProfileId: "fixture-profile", profiles: [{ id: "fixture-profile", status: "connected",
    scopes: ["chatgpt.tokens.use.direct"], credentials: { accessToken: "synthetic-access-token", expiresAt: Date.now() + 60_000 } }] };
  await writeFile(join(storage, "chatgpt-auth.json"), JSON.stringify({ version: 3, provider: "fixture",
    ciphertext: Buffer.from(JSON.stringify(payload)).toString("base64") }));
  const runtime = new SiwcRuntime({ signIn: async () => ({ status: "connected", sharing: true }),
    getSession: async () => ({ status: "connected", sharing: true }),
    listModels: async () => [{ slug: "fixture-model", displayName: "Fixture Model" }],
    streamResponse: async () => { throw new Error("Unexpected transport"); } }, storage, root,
    { id: "fixture", isAvailable: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => Buffer.from(bytes).toString("utf8") }, "fixture-model");
  let lane = "";
  let closed = "";
  Object.assign(runtime, { statefulResponses: {
    async reply(options: any) {
      lane = options.sessionId;
      assert.ok(lane.startsWith("background:"));
      assert.equal(options.webSearchAllowed, false);
      assert.deepEqual(responseTools(options.tools ?? [], options.webSearchAllowed), []);
      return { text: '{"changes":[],"creates":[],"deletes":[]}', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } };
    }, async resetSession(id: string) { closed = id; },
  } });
  await runtime.reply(review);
  assert.equal(closed, lane);
  assert.notEqual(lane, review.sessionId);
});
