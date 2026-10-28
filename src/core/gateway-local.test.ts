import { selectTestTurn } from "../testing/turn-decision.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Gateway } from "../gateway.js";
import { SessionStore } from "../sessions/store.js";
import { LocalKnowledgeStore } from "../knowledge/store.js";
import { LocalCoreContextProvider } from "./context.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "gateway-local-gateway-"));
  const sessions = new SessionStore(root);
  const knowledge = new LocalKnowledgeStore(root, "formal");
  const text = "测试本地 Core；请只使用已核实的本地上下文。";
  mkdirSync(join(root, "core"));
  writeFileSync(join(root, "core", "core.md"), text);
  knowledge.createRecent({ body: "晚上核对测试结果", conversationState: null,
    stateDate: null, eventAt: null, sourceId: "fixture:one" });
  return { root, sessions, knowledge, context: new LocalCoreContextProvider(root, () => "晚上核对测试结果"),
    cleanup: () => { knowledge.close(); sessions.close(); rmSync(root, { recursive: true, force: true }); } };
}
const message = { channel: "telegram" as const, conversationId: "123",
  senderId: "123", messageId: "1", text: "晚上几点核对结果？",
  receivedAt: "2026-10-18T08:00:00Z", attachments: [] };

test("local Core exposes Recent tools and persists idempotent updates", async () => {
  const fixture = setup();
  try {
    let request: any;
    const runtime = { async reply(value: any) { request = value; await selectTestTurn(value, {groups:["recent_manage"]}); return { text: "已经了解" }; } };
    const gateway = new Gateway(runtime as any, fixture.sessions, fixture.context as any,
      2, "Asia/Shanghai", undefined, undefined, fixture.knowledge);
    const outcome = await gateway.handle(message);
    assert.equal(outcome.kind, "model_reply");
    assert.match(request.instructions, /测试本地 Core/);
    assert.match(request.instructions, /可靠事实管理记忆/);
    assert.deepEqual(request.tools.filter((tool: any) => tool.name.startsWith('gateway_recent_')).map((tool: any) => tool.name),
      ["gateway_recent_read", "gateway_recent_create",
        "gateway_recent_write"]);
    const recent = await request.executeTool("gateway_recent_read", { query: "晚上" });
    assert.equal(recent.total, 1);
    const created = await request.executeTool("gateway_recent_create",
      { body: "用户周末整理测试资料", conversation_state: null });
    const retried = await request.executeTool("gateway_recent_create",
      { body: "用户周末整理测试资料", conversation_state: null });
    assert.equal(created.created.id, retried.created.id);
    assert.equal(fixture.knowledge.listRecent().length, 2);
  } finally { fixture.cleanup(); }
});

test("local conversation rejects unadvertised tools without changing stored memory", async () => {
  const fixture = setup();
  try {
    let request: any;
    const runtime = { async reply(value: any) { request = value; await selectTestTurn(value, {groups:["recent_manage"]}); return { text: "本地信息仍可用" }; } };
    const gateway = new Gateway(runtime as any, fixture.sessions, fixture.context as any,
      2, "Asia/Shanghai", undefined, undefined, fixture.knowledge);
    assert.equal((await gateway.handle(message)).kind, "model_reply");
    assert.deepEqual(request.tools.filter((tool: any) => tool.name.startsWith('gateway_recent_')).map((tool: any) => tool.name),
      ["gateway_recent_read", "gateway_recent_create", "gateway_recent_write"]);
    assert.equal((await request.executeTool("gateway_recent_read", { query: "晚上" })).total, 1);
    const before = fixture.knowledge.listRecent();
    for (const name of ["unknown_read", "unknown_write", "gateway_recent_clear_all"]) {
      await assert.rejects(request.executeTool(name, {}), /本轮未开放/);
    }
    assert.deepEqual(fixture.knowledge.listRecent(), before);
  } finally { fixture.cleanup(); }
});
