import { selectTestTurn } from "../testing/turn-decision.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { initializeGateway } from "../setup.js";
import { GatewayService } from "../service.js";
import { loadConfig } from "../config/index.js";
import { LocalKnowledgeStore } from "../knowledge/store.js";
import type { InboundMessage } from "../channels/types.js";
import type { ChatRequest, ManagedChatRuntime } from "../runtime/types.js";

test("legacy disabled settings automatically prepare memory, expose files and run silent review", async t => {
  const root = await mkdtemp(join(tmpdir(), "sophon-features-"));
  const data = join(root, "state");
  await initializeGateway(data);
  const settings = { GATEWAY_DATA_DIR: data, TELEGRAM_BOT_TOKEN: "70001:synthetic", TELEGRAM_OWNER_ID: "70001",
    GATEWAY_FILES_ENABLED: "false", GATEWAY_GENERATED_FILES_DIR: join(root, "documents"),
    GATEWAY_RECENT_REVIEW_ENABLED: "false", GATEWAY_CONTROL_TUNNEL: "off", GATEWAY_HEARTBEAT_ENABLED: "false", GATEWAY_MEMORY_GRAPH_ENABLED: "false" };
  const previous = { ...process.env };
  Object.assign(process.env, settings);
  t.after(() => { for (const key of Object.keys(settings)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const config = loadConfig();
  assert.equal(config.heartbeat.enabled, false);
  let reviews = 0;
  let handler: ((message: InboundMessage) => Promise<unknown>) | undefined;
  let documentCount = 0;
  const runtime = { getSession: async () => ({ status: "connected", sharing: true }),
    async reply(request: ChatRequest) {
      if (request.purpose === "recent_review") { reviews++; return { text: '{"changes":[],"creates":[],"deletes":[]}' }; }
      await selectTestTurn(request, {groups:["files"]});
      assert.ok(request.tools?.some(tool => tool.name === "telegram_send_document"));
      await request.executeTool!("telegram_send_document", { mode: "save", filename: "result.txt", content: "Synthetic result" });
      return { text: "文件已保存。" };
    }, async close() {},
  } as ManagedChatRuntime;
  const service = await GatewayService.create(config, runtime);
  assert.equal(config.memoryGraphEnabled, true);
  assert.equal(config.control?.tunnel, "cloudflare");
  // Replace external transports only; exercise production startup, tool dispatch, timer and shutdown.
  Object.assign(service, { startHttpServer: async () => {}, telegram: {
    async start(value: typeof handler) { handler = value; }, async stop() {},
    async sendDocumentToOwner() { documentCount++; return 91; },
  } });
  t.after(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await service.start();
  await handler!({ channel: "telegram", senderId: "70001", conversationId: "70001", messageId: "service-request",
    text: "请保存测试结果", attachments: [], receivedAt: new Date().toISOString() });
  assert.equal(await readFile(join(config.files!.generatedDir, "result.txt"), "utf8"), "Synthetic result");
  t.mock.timers.tick(60_000);
  for (let i = 0; i < 20 && !reviews; i++) await setImmediate();
  assert.equal(reviews, 1);
  await service.stop();
  const store = new LocalKnowledgeStore(data, "formal");
  try { assert.equal(store.getReviewCursor("formal:telegram:70001"), 0); } finally { store.close(); }
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(reviews, 1);
  assert.equal(documentCount, 0, "silent review never sends a document");
});
