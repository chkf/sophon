import { executeLocalContextTool } from "./tools.js";
import { writeLegacyPersonaFixture, fixturePresets } from "../../scripts/testing/persona-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../gateway.js";
import { SessionStore } from "../sessions/store.js";
import { ExpressionStore } from "../expression/store.js";
import { LocalKnowledgeStore } from "../knowledge/store.js";
import type { InboundMessage } from "../channels/types.js";
import type { ChatRequest, ChatRuntime } from "../runtime/types.js";
import { mainPath, openDatabase, schemaVersion } from "../state/database.js";
import { migrateState } from "../state/migration.js";
import { migrateSchemaDatabase } from "../state/schema.js";
import { LocalCoreContextProvider, renderRecentSummary } from "./context.js";

const ORIGINAL_CORE = "# Synthetic Core\n正式初始指令标记。";
const REVISED_CORE = "# Synthetic Core\n正式新指令标记。";
const DELETED_RECENT = "只存在于 Recent 的待删除测试标记";
const KEPT_RECENT = "仍需保留的合成交流";
const NEW_TOOLS = ["gateway_core_read", "gateway_core_write", "gateway_recent_delete"];
const receivedAt = "2026-10-22T08:00:00.000Z";
const incoming = (messageId: string, text = "继续这次合成测试"): InboundMessage => ({
  channel: "telegram", conversationId: "123", senderId: "123", messageId, text,
  receivedAt, attachments: [],
});

async function fixture(version: 0 | 1 | 2, run: (value: {
  root: string; sessions: SessionStore; knowledge: LocalKnowledgeStore;
  personas: ExpressionStore; context: LocalCoreContextProvider;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "gateway-formal-context-"));
  let sessions: SessionStore | undefined, knowledge: LocalKnowledgeStore | undefined;
  try {
    await mkdir(join(root, "core"));
    await writeFile(join(root, "core/core.md"), ORIGINAL_CORE);
    sessions = new SessionStore(root);
    await sessions.bindOwnerSession("123", "wechat-owner");
    await sessions.append("telegram", "123", "123", [
      { id: "fixture:question", role: "user", content: "正式聊天原文应保留", at: receivedAt },
      { id: "fixture:answer", role: "assistant", content: "已确认原文", at: receivedAt },
    ]);
    sessions.close(); sessions = undefined;
    const personas = new ExpressionStore(root);
    await writeLegacyPersonaFixture(root,"custom",{...fixturePresets,custom:["CALM","SMART"]});
    knowledge = new LocalKnowledgeStore(root, "formal");
    knowledge.createRecent({ id: "fixture:delete", body: DELETED_RECENT, sourceId: "fixture:delete" });
    knowledge.createRecent({ id: "fixture:keep", body: KEPT_RECENT, sourceId: "fixture:keep" });
    knowledge.close(); knowledge = undefined;
    if (version > 0) await migrateState(root, true);
    if (version === 2) {
      const db = openDatabase(mainPath(root));
      try { migrateSchemaDatabase(db, root); } finally { db.close(); }
    }
    const db = openDatabase(mainPath(root), true);
    try { assert.equal(schemaVersion(db), version); } finally { db.close(); }
    sessions = new SessionStore(root);
    knowledge = new LocalKnowledgeStore(root, "formal");
    const currentKnowledge = knowledge;
    const context = new LocalCoreContextProvider(root,
      () => renderRecentSummary(currentKnowledge.listRecent()), version ? () => personas.snapshot() : undefined,
      () => currentKnowledge.getRecentRevision());
    await run({ root, sessions, knowledge, personas, context });
  } finally {
    knowledge?.close(); sessions?.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("manual Core edits refresh chat while model tools only mutate Recent", () => fixture(2, async value => {
  const requests: ChatRequest[] = [], results: Record<string, any> = {};
  const snapshots: Array<ReturnType<LocalCoreContextProvider["peek"]>> = [];
  let failure: unknown;
  const runtime: ChatRuntime = { async reply(request) {
    requests.push(request);
    if (requests.length === 1) {
      try {
        const execute = request.executeTool!;
        await assert.rejects(execute("gateway_core_read", {}),/未开放/);
        results.core = await executeLocalContextTool(value.root,"formal","gateway_core_read", {});
        results.coreWrite = await executeLocalContextTool(value.root,"formal","gateway_core_write", {
          body: REVISED_CORE, expected_revision: results.core.core.revision,
        });
        await value.context.load();
        snapshots.push(value.context.peek());
        await value.personas.setShowStageDirections(true);
        await value.context.load();
        snapshots.push(value.context.peek());
        results.recent = await execute("gateway_recent_read", { query: DELETED_RECENT });
        results.deletion = await execute("gateway_recent_delete", {
          items: [{ id: "fixture:delete", expected_revision: results.recent.items[0].revision }],
        });
        results.afterDelete = await execute("gateway_recent_read", { query: DELETED_RECENT });
        snapshots.push(value.context.peek());
      } catch (error) { failure = error; throw error; }
    }
    return { text: "测试配置已更新。" };
  } };
  const gateway = new Gateway(runtime, value.sessions, value.context,
    8, "Asia/Shanghai", () => new Date(receivedAt), value.personas, value.knowledge);
  const before = await value.context.load();
  const first = await gateway.handle(incoming("1", "请修改这次测试的 Core 和描写设置，并删除指定交流条目。"));
  if (failure) throw failure;
  assert.equal(first.kind, "model_reply");
  if (first.kind !== "model_reply") throw new Error("Formal request failed");
  await gateway.commitDeliveredAssistant("telegram", "123", "123", first.text, undefined, first.deliveryId);
  const advertised = requests[0]!.tools!.map(tool => tool.name);
  assert.ok(advertised.includes("gateway_recent_delete"));
  assert.equal(advertised.some(name=>name.startsWith("gateway_core_")),false);
  assert.equal(requests[0]!.ephemeral, undefined);
  assert.equal(requests[0]!.sessionId, "telegram:123");
  assert.equal(results.coreWrite.updated.body, REVISED_CORE);
  assert.equal(results.coreWrite.updated.revision, results.core.core.revision + 1);
  assert.deepEqual(results.deletion.deleted, ["fixture:delete"]);
  assert.equal(results.afterDelete.total, 0);
  assert.equal(value.knowledge.getRecent("fixture:delete"), undefined);
  assert.notEqual(snapshots[0]!.data!.coreRevision, before.data!.coreRevision);
  assert.notEqual(snapshots[1]!.data!.coreRevision, snapshots[0]!.data!.coreRevision,
    "Expression changes invalidate the control revision");
  assert.notEqual(snapshots[2]!.data!.recentRevision, before.data!.recentRevision);

  const second = await gateway.handle({ ...incoming("2"), channel: "wechat",
    conversationId: "wechat-owner", senderId: "wechat-owner" });
  assert.equal(second.kind, "model_reply");
  assert.equal(requests[1]!.sessionId, requests[0]!.sessionId, "both owner channels share the formal conversation");
  assert.match(requests[1]!.instructions!, /正式新指令标记/);
  assert.doesNotMatch(requests[1]!.instructions!, /正式初始指令标记/);
  assert.match(requests[1]!.instructions!, /心理和动作描写已开启/);
  assert.equal((requests[1]!.instructions!.match(/心理和动作描写已开启/g) ?? []).length, 1);
  assert.doesNotMatch(requests[1]!.turnInstructions!, /表达风格/);
  assert.notEqual(requests[1]!.context!.controlRevision, requests[0]!.context!.controlRevision);
  assert.notEqual(requests[1]!.context!.contextRevision, requests[0]!.context!.contextRevision);
  assert.doesNotMatch(requests[1]!.context!.content, new RegExp(DELETED_RECENT));
  assert.equal(requests[1]!.context!.content, "{}", "Recent is no longer a persisted developer context item");
  assert.doesNotMatch(requests[1]!.turnInstructions!, new RegExp(DELETED_RECENT));
  assert.match(requests[1]!.turnInstructions!, new RegExp(KEPT_RECENT));
  const history = await value.sessions.get("telegram", "123");
  assert.equal(history!.messages[0]!.content, "正式聊天原文应保留");
}));

for (const version of [0, 1] as const) {
  test("Gateway schema " + version + " keeps legacy Recent writes scoped and exposes session-message history", () => fixture(version, async value => {
    let request: ChatRequest | undefined;
    const runtime: ChatRuntime = { async reply(input) { request = input; return { text: "旧版正常交流" }; } };
    const gateway = new Gateway(runtime, value.sessions, value.context,
      8, "Asia/Shanghai", () => new Date(receivedAt), version ? value.personas : undefined, value.knowledge);
    assert.equal((await gateway.handle(incoming("legacy"))).kind, "model_reply");
    const toolNames = request!.tools!.map(tool => tool.name);
    assert.deepEqual(toolNames.filter(name => name.startsWith("gateway_recent_")), [
      "gateway_recent_read", "gateway_recent_create", "gateway_recent_write",
    ]);
    assert.ok(toolNames.includes("gateway_read_history"));
    assert.equal(toolNames.length, 4);
    assert.match(JSON.stringify(await request!.executeTool!("gateway_read_history", { query: "正式聊天原文应保留" })), /正式聊天原文应保留/);
    for (const name of NEW_TOOLS) await assert.rejects(request!.executeTool!(name, {}), /未开放/);
    assert.equal(request!.context!.content, "{}");
    assert.match(request!.turnInstructions!, new RegExp(DELETED_RECENT));
    assert.match(request!.instructions!, /正式初始指令标记/);
  }));
}
