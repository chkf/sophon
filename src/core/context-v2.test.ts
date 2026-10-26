import { writeLegacyPersonaFixture, fixturePresets } from "../../scripts/testing/persona-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../sessions/store.js";
import { ExpressionStore } from "../expression/store.js";
import { LocalKnowledgeStore, RecentDeletedError, RECENT_DELETED_KEY } from "../knowledge/store.js";
import { executeLocalKnowledgeTool, localKnowledgeTools } from "../knowledge/tools.js";
import { mainPath, openDatabase, getState, schemaVersion } from "../state/database.js";
import { migrateState } from "../state/migration.js";
import { migrateSchemaDatabase } from "../state/schema.js";
import { executeLocalContextTool as contextTool } from "./tools.js";
import { LocalCoreContextProvider } from "./context.js";
import { renderLocalPolicy } from "./render.js";
import { LaneStore } from "../runtime/siwc/lane-store.js";
import { checkpointFromItems } from "../runtime/siwc/compaction.js";
import { CompactionNoticeLedger } from "../runtime/siwc/compaction-notice.js";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "gateway-context-v2-"));
  try {
    await mkdir(join(root, "core"));
    await writeFile(join(root, "core/core.md"), "# Synthetic Core\n用于隔离测试的初始指令。\n");
    const sessions = new SessionStore(root);
    try {
      for (let seq = 0; seq < 4; seq++) await sessions.append("telegram", "123", "123", [{
        id: "fixture:" + seq, role: seq % 2 ? "assistant" : "user", content: "合成消息 " + seq,
        at: new Date(Date.UTC(2026, 9, 20, 0, seq)).toISOString(),
      }]);
    } finally { sessions.close(); }
    const personas = new ExpressionStore(root);
    const saved = {...fixturePresets, custom:["CALM","SMART"]};
    delete saved.formal;
    await writeLegacyPersonaFixture(root,"custom",saved);
    const knowledge = new LocalKnowledgeStore(root, "formal");
    try { knowledge.createRecent({ id: "recent:legacy", body: "旧的合成话题", sourceId: "fixture:legacy" }); }
    finally { knowledge.close(); }
    await migrateState(root, true);
    const db = openDatabase(mainPath(root));
    try { migrateSchemaDatabase(db, root); } finally { db.close(); }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("schema v2 stores cumulative SIWC checkpoint and notice in existing gateway_state", () => fixture(async root => {
  const sessionId = "telegram:owner";
  const items = [{ type: "compaction", encrypted_content: "synthetic-v2-opaque" }];
  const cp = checkpointFromItems(sessionId, "fixture-model", items, 8,
    "capacity", "2026-10-23T00:00:00Z");
  const store = new LaneStore(root);
  await store.save({ sessionId, model: "fixture-model", needsBootstrap: false,
    contextItems: items, historyCursor: 8, coverageVerified: true,
    startedAt: "2026-10-01T00:00:00Z", lastCompactedAt: cp.at, checkpoint: cp });
  assert.equal((await store.read(sessionId))?.checkpoint?.id, cp.id);
  assert.equal(await new CompactionNoticeLedger(root).claim(cp), true);
  assert.equal(await new CompactionNoticeLedger(root).claim(cp), false);
  const db = openDatabase(mainPath(root), true);
  try {
    assert.ok((db.prepare("SELECT COUNT(*) AS n FROM gateway_state WHERE key LIKE 'runtime/context/%'")
      .get() as { n: number }).n >= 2);
    assert.equal(schemaVersion(db), 2);
  } finally { db.close(); }
}));

test("v2 Recent deletion is immediate in every state, survives restart and keeps history and other kinds", () => fixture(async root => {
  let store = new LocalKnowledgeStore(root, "formal");
  try {
    assert.equal(store.supportsContextTools, true);
    assert.ok(localKnowledgeTools(store).some(tool => tool.name === "gateway_recent_delete"));
    const entries = [null, "Pending", "Ongoing", "Done"].map((state, index) => store.createRecent({
      body: "新建测试话题 " + index, conversationState: state as "Pending" | "Ongoing" | "Done" | null,
      sourceId: "fixture:new:" + index,
    }));
    const unknown = store.createRecent({ body: "历史未知状态" });
    const db = openDatabase(mainPath(root));
    try { db.prepare("UPDATE context SET conversation_state='legacy-unknown' WHERE kind='recent' AND id=?").run(unknown.id); }
    finally { db.close(); }
    const targets = [...entries, unknown].map(entry => ({ id: entry.id, expected_revision: entry.revision }));
    const deleted = executeLocalKnowledgeTool(store, "formal", "gateway_recent_delete", { items: targets }) as any;
    assert.equal(deleted.deleted.length, 5);
    assert.deepEqual(store.listRecent().map(entry => entry.id), ["recent:legacy"]);
    assert.equal((executeLocalKnowledgeTool(store, "formal", "gateway_recent_read", { query: "新建测试" }) as any).total, 0);
    store.close(); store = new LocalKnowledgeStore(root, "formal");
    const replay = executeLocalKnowledgeTool(store, "formal", "gateway_recent_create", { body: "重试的新正文" }, "fixture:new:0") as any;
    assert.equal(replay.deleted, true); assert.equal(replay.created, null);
    assert.throws(() => store.createRecent({ id: unknown.id, body: "无来源旧 ID 重放" }), RecentDeletedError);
    assert.equal(store.deleteRecent([{ id: entries[0].id, expectedRevision: entries[0].revision }]).alreadyDeleted.length, 1);
    assert.ok(store.createRecent({ body: "无来源且新 ID 的正常新话题" }).id);
    assert.throws(() => store.deleteRecent([{ id: "main", expectedRevision: 1 }]), /not found/);
    assert.throws(() => executeLocalKnowledgeTool(store, "ephemeral", "gateway_recent_delete", { items: targets }), /临时/);
    const after = openDatabase(mainPath(root), true);
    try {
      assert.equal(after.prepare("SELECT count(*) AS n FROM messages").get()!.n, 4);
      assert.equal(after.prepare("SELECT count(*) AS n FROM context WHERE kind='core'").get()!.n, 1);
      const receipt = getState(after, RECENT_DELETED_KEY)!;
      assert.doesNotMatch(receipt.value, /新建测试|历史未知状态/);
      assert.equal(JSON.parse(receipt.value).entries.length, 5);
      const names = after.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
      for (const retired of ["recent_entries", "knowledge_review_progress", "gateway_state_meta"]) assert.ok(!names.includes(retired));
    } finally { after.close(); }
  } finally { store.close(); }
}));

test("Recent bounded delete conflicts and receipt failures roll back the whole batch", () => fixture(async root => {
  const store = new LocalKnowledgeStore(root, "formal");
  const db = openDatabase(mainPath(root));
  try {
    const a = store.createRecent({ body: "a" }), b = store.createRecent({ body: "b" });
    store.updateRecent({ id: b.id, expectedRevision: 1, body: "b new" });
    assert.throws(() => store.deleteRecent([{ id: a.id, expectedRevision: 1 }, { id: b.id, expectedRevision: 1 }]), /Stale/);
    assert.ok(store.getRecent(a.id)); assert.ok(store.getRecent(b.id));
    assert.equal(getState(db, RECENT_DELETED_KEY), undefined);
    db.exec(`CREATE TRIGGER refuse_receipt BEFORE INSERT ON gateway_state
      WHEN NEW.key='context/recent_deleted' BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;`);
    assert.throws(() => store.deleteRecent([{ id: a.id, expectedRevision: 1 }]), /injected/);
    assert.ok(store.getRecent(a.id)); assert.equal(getState(db, RECENT_DELETED_KEY), undefined);
    db.exec("DROP TRIGGER refuse_receipt");
    assert.throws(() => store.deleteRecent(Array.from({ length: 21 }, () => ({ id: a.id, expectedRevision: 1 }))), /1–20/);
    assert.throws(() => store.deleteRecent([{ id: a.id, expectedRevision: 1 }, { id: a.id, expectedRevision: 1 }]), /重复/);
    assert.equal(store.deleteRecent([{ id: a.id, expectedRevision: 1 }, { id: b.id, expectedRevision: 2 }]).deleted.length, 2);
  } finally { db.close(); store.close(); }
}));

test("Recent review shares cursor transaction, preserves chat activity and composes with caller rollback", () => fixture(async root => {
  const db = openDatabase(mainPath(root));
  const store = new LocalKnowledgeStore(root, "formal", db);
  try {
    const before = db.prepare("SELECT updated_at FROM conversations WHERE key='telegram:123'").get()!.updated_at;
    assert.throws(() => store.commitReview("formal:telegram:123", -1, 1,
      [{ id: "recent:legacy", expectedRevision: 1, body: "更改" }, { id: "missing", expectedRevision: 1 }]), /not found/);
    assert.equal(store.getReviewCursor("formal:telegram:123"), -1);
    assert.equal(store.getRecent("recent:legacy")!.body, "旧的合成话题");
    assert.equal(store.commitReview("formal:telegram:123", -1, 1, [], [{ body: "整理新增" }]), "committed");
    const created = store.listRecent().find(entry => entry.body === "整理新增")!;
    store.deleteRecent([{ id: created.id, expectedRevision: 1 }]);
    assert.throws(() => store.createRecent({ body: "整理新增", sourceId: created.sourceId }), RecentDeletedError);
    assert.equal(store.commitReview("formal:telegram:123", -1, 1, [], [{ body: "整理新增" }]), "already");
    assert.equal(db.prepare("SELECT updated_at FROM conversations WHERE key='telegram:123'").get()!.updated_at, before);
    assert.ok(db.prepare("SELECT recent_review_updated_at FROM conversations WHERE key='telegram:123'").get()!.recent_review_updated_at);
    db.exec("BEGIN IMMEDIATE");
    store.commitReview("formal:telegram:123", 1, 3, [{ id: "recent:legacy", expectedRevision: 1, body: "事务内暂存" }]);
    assert.equal(store.getReviewCursor("formal:telegram:123"), 3);
    db.exec("ROLLBACK");
    assert.equal(store.getReviewCursor("formal:telegram:123"), 1);
    assert.equal(store.getRecent("recent:legacy")!.body, "旧的合成话题");
  } finally { store.close(); db.close(); }
}));

test("legacy review receipts do not resurrect deleted sources and archived topics persist", () => fixture(async root => {
  const store = new LocalKnowledgeStore(root, "formal");
  try {
    const sourceId = "review:" + createHash("sha256").update(JSON.stringify(["formal:telegram:123", -1, 1, 0])).digest("hex");
    const seeded = store.createRecent({ body: "已删除的整理提议", sourceId });
    store.deleteRecent([{ id: seeded.id, expectedRevision: seeded.revision }]);
    assert.equal(store.commitReview("formal:telegram:123", -1, 1, [], [{ body: "重放提议可改变文字但不得复活来源" }]), "committed");
    assert.equal(store.listRecent().length, 1);
    const oldDone = store.createRecent({ body: "已结束的历史交流", conversationState: "Done", stateDate: "2026-10-01", sourceId: "fixture:prune" });
    assert.equal(store.getRecent(oldDone.id)?.body, "已结束的历史交流");
    assert.equal(store.getRecent(oldDone.id)?.conversationState, "Done",
      "archived topics have no age-based deletion");
    assert.throws(() => store.createRecent({ body: "已更改的历史交流", sourceId: "fixture:prune" }),
      /changed/, "trusted create sources remain immutable");
  } finally { store.close(); }
}));

test("formal store rejects damaged deletion receipts and active identities that conflict with them", () => fixture(async root => {
  const store = new LocalKnowledgeStore(root, "formal");
  const entry = store.createRecent({ body: "删除凭据测试", sourceId: "fixture:receipt" });
  store.deleteRecent([{ id: entry.id, expectedRevision: 1 }]);
  store.close();
  const db = openDatabase(mainPath(root));
  try {
    const receipt = getState(db, RECENT_DELETED_KEY)!;
    const value = JSON.parse(receipt.value);
    value.entries[0].body = "凭据禁止保留正文";
    db.prepare("UPDATE gateway_state SET value=? WHERE key=?").run(JSON.stringify(value), RECENT_DELETED_KEY);
    assert.throws(() => new LocalKnowledgeStore(root, "formal"), /删除凭据内容无效/);
    db.prepare("UPDATE gateway_state SET value=? WHERE key=?").run(receipt.value, RECENT_DELETED_KEY);
    db.prepare("INSERT INTO context(kind,id,body,revision,updated_at,source_id) VALUES('recent',?,?,1,?,?)")
      .run(entry.id, "错误复活", new Date().toISOString(), entry.sourceId);
    assert.throws(() => new LocalKnowledgeStore(root, "formal"), /删除凭据与有效条目冲突/);
  } finally { db.close(); }
}));

test("Recent revision tracks deletion outside the displayed excerpt and same-turn create then delete", () => fixture(async root => {
  const knowledge = new LocalKnowledgeStore(root, "formal");
  const provider = new LocalCoreContextProvider(root, () => "固定节选，不含待删除条目", undefined,
    () => knowledge.getRecentRevision());
  try {
    const before = await provider.load();
    knowledge.deleteRecent([{ id: "recent:legacy", expectedRevision: 1 }]);
    const deleted = await provider.load();
    assert.equal(deleted.data!.recent, before.data!.recent);
    assert.notEqual(deleted.data!.recentRevision, before.data!.recentRevision);
    const transient = knowledge.createRecent({ body: "仅在工具结果里出现过的条目" });
    knowledge.deleteRecent([{ id: transient.id, expectedRevision: 1 }]);
    const after = await provider.load();
    assert.equal(knowledge.listRecent().length, 0);
    assert.notEqual(after.data!.recentRevision, deleted.data!.recentRevision,
      "deletion receipts invalidate cached tool results even when active rows are unchanged");
  } finally { knowledge.close(); }
}));

test("Core tools and expression settings persist validated CAS updates and refresh the assembled formal context", () => fixture(async root => {
  const knowledge = new LocalKnowledgeStore(root, "formal"), personas = new ExpressionStore(root);
  const provider = new LocalCoreContextProvider(root, () => knowledge.listRecent().map(item => item.body).join("\n"), () => personas.snapshot());
  try {
    const before = await provider.load();
    assert.equal(before.available, true); assert.equal(before.data!.expression!.showStageDirections, false);
    const current = (await contextTool(root, "formal", "gateway_core_read", {})) as any;
    const revised = await contextTool(root, "formal", "gateway_core_write", { body: "# Synthetic Core\n新的合成指令。", expected_revision: current.core.revision }) as any;
    assert.equal(revised.updated.revision, current.core.revision + 1);
    await assert.rejects(contextTool(root, "formal", "gateway_core_write", { body: "lost", expected_revision: current.core.revision }), /revision/);
    await assert.rejects(contextTool(root, "formal", "gateway_core_write", { body: " \u0000", expected_revision: revised.updated.revision }), /Core/);
    await assert.rejects(contextTool(root, "ephemeral", "gateway_core_read", {}), /临时/);
    await assert.rejects(contextTool(root, "ephemeral", "gateway_persona_write", {}), /临时/);
    await assert.rejects(contextTool(root, "formal", "gateway_persona_read", {}), /未知/);
    await personas.setShowStageDirections(true);
    const after = await provider.load();
    assert.equal(after.available, true); assert.notEqual(after.data!.coreRevision, before.data!.coreRevision);
    assert.notEqual(after.data!.expressionRevision, before.data!.expressionRevision);
    assert.match(renderLocalPolicy(after), /新的合成指令/); assert.match(renderLocalPolicy(after), /心理和动作描写已开启/);
    knowledge.deleteRecent([{ id: "recent:legacy", expectedRevision: 1 }]);
    const cleaned = await provider.load();
    assert.doesNotMatch(cleaned.data!.recent, /旧的合成话题/);
    assert.notEqual(cleaned.data!.recentRevision, after.data!.recentRevision);
    const db = openDatabase(mainPath(root));
    try { db.exec("DELETE FROM context WHERE kind='core'"); } finally { db.close(); }
    assert.equal((await provider.load()).available, false, "retained old Core file is never used");
  } finally { knowledge.close(); }
}));
