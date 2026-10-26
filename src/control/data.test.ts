import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlData, ControlDataError } from "./data.js";
import { initializeGateway } from "../setup.js";
import { SessionStore } from "../sessions/store.js";
import { LocalKnowledgeStore } from "../knowledge/store.js";
import { LocalCoreContextProvider, renderRecentSummary } from "../core/context.js";
import { ExpressionStore } from "../expression/store.js";
import { mainPath, openDatabase, putState } from "../state/database.js";
import { validateSixSchema } from "../state/schema.js";
import { LaneStore } from "../runtime/siwc/lane-store.js";
import { checkpointFromItems } from "../runtime/siwc/compaction.js";

async function fixture(run: (root: string, data: ControlData, sessions: SessionStore, knowledge: LocalKnowledgeStore,
  context: LocalCoreContextProvider) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "sophon-control-data-"));
  const root = join(directory, "data");
  await initializeGateway(root);
  const sessions = new SessionStore(root), knowledge = new LocalKnowledgeStore(root, "formal"), personas = new ExpressionStore(root);
  const context = new LocalCoreContextProvider(root, () => renderRecentSummary(knowledge.listRecent()),
    () => personas.snapshot(), () => knowledge.getRecentRevision());
  const data = new ControlData(root, { sessions, knowledge, context, expressions: personas, timezone: "Asia/Shanghai" });
  try { await run(root, data, sessions, knowledge, context); }
  finally { data.close(); knowledge.close(); sessions.close(); await rm(directory, { recursive: true, force: true }); }
}

test("control history keeps chronological indices, date filters and matched-message context", () => fixture(async (_root, data, sessions) => {
  const messages = [
    { role: "user" as const, content: "上一个日期的任务", at: "2026-10-24T15:59:59Z" },
    { role: "assistant" as const, content: "文档索引已更新", at: "2026-10-24T16:00:00Z" },
    { role: "user" as const, content: "查找文档索引", at: "2026-10-25T15:59:59Z", source: { channel: "wechat" as const } },
    { role: "assistant" as const, content: "下一日期的任务", at: "2026-10-25T16:00:00Z" },
  ];
  await sessions.append("telegram", "123", "123", messages);
  const conversations = data.conversations({ limit: 1 });
  assert.equal(conversations.total, 1);
  assert.equal(conversations.items[0].count, 4);
  const key = conversations.items[0].key;
  const found = await data.history({ conversationKey: key, query: "文档索引", from: "2026-10-25", to: "2026-10-25", limit: 1 });
  assert.equal(found.total, 2);
  assert.deepEqual(found.items.map(item => item.index), [2]);
  assert.equal(found.nextOffset, 1);
  const next = await data.history({ conversationKey: key, query: "文档索引", from: "2026-10-25", to: "2026-10-25", offset: found.nextOffset!, limit: 1 });
  assert.equal(next.items[0].channel, "telegram");
  assert.equal(next.nextOffset, null);
  const around = await data.history({ conversationKey: key, query: "unmatched", around: 1, limit: 3 });
  assert.equal(around.filtered, false);
  assert.deepEqual(around.items.map(item => item.index), [2, 1, 0]);
  assert.equal(around.items[0].content, messages[2].content);
  const last = await data.history({ conversationKey: key, offset: 4 });
  assert.deepEqual(last.items, []);
  assert.equal(last.nextOffset, null);
}));

test("control history validates bounds and literal searches without changing the transcript", () => fixture(async (_root, data, sessions) => {
  await sessions.append("telegram", "123", "123", [{ role: "user", content: 'literal " OR * match', at: "2026-10-25T00:00:00Z" }]);
  assert.equal((await data.history({ conversationKey: "telegram:123", query: '" OR *' })).total, 1);
  for (const invalid of [{ limit: 101 }, { offset: -1 }, { from: "2026-02-30" }, { from: "2026-10-25T01:00:00" },
    { from: "2026-10-26", to: "2026-10-25" }, { query: "a".repeat(257) }]) {
    await assert.rejects(data.history({ conversationKey: "telegram:123", ...invalid }), (e: unknown) => e instanceof ControlDataError && e.status === 400);
  }
  await assert.rejects(data.history({ conversationKey: "../database" }), (e: unknown) => e instanceof ControlDataError && e.status === 404);
  assert.equal((await sessions.view("telegram", "123")).history.count, 1);
}));

test("Core edits validate content, guard revisions and invalidate only the assembled snapshot", () => fixture(async (_root, data, _sessions, _knowledge, context) => {
  await context.load();
  assert.equal(data.context().available, true);
  const core = await data.core();
  const saved = await data.saveCore({ body: "# Assistant configuration\n请清楚地解释技术问题。", expectedRevision: core.revision });
  assert.equal(saved.revision, core.revision + 1);
  assert.equal((await data.core()).body, saved.body);
  assert.equal(data.context().available, false);
  await assert.rejects(data.saveCore({ body: "覆盖较新的配置", expectedRevision: core.revision }), (e: unknown) => e instanceof ControlDataError && e.status === 409);
  await assert.rejects(data.saveCore({ body: "\0", expectedRevision: saved.revision }), (e: unknown) => e instanceof ControlDataError && e.status === 400);
  await assert.rejects(data.saveCore({ body: "文".repeat(100_000), expectedRevision: saved.revision }), (e: unknown) => e instanceof ControlDataError && e.status === 400);
  await context.load();
  assert.equal(data.context().local?.core, saved.body);
}));

test("Recent management respects revisions, archive semantics and deletion tombstones", () => fixture(async (root, data, sessions, knowledge, context) => {
  await sessions.append("telegram", "123", "123", [{ role: "user", content: "准备文档", at: "2026-10-25T00:00:00Z" }]);
  const topic = knowledge.createRecent({ id: "recent:test", body: "# 文档整理\n需要继续核对目录。", conversationState: "Pending", sourceId: "synthetic-source" });
  await context.load();
  const priorSnapshot = context.peek();
  const edited = data.saveRecent({ id: topic.id, body: "# 文档整理\n目录已经核对。", expectedRevision: topic.revision });
  assert.equal(context.peek(), priorSnapshot);
  assert.equal(edited.conversationState, "Pending");
  assert.throws(() => data.saveRecent({ id: topic.id, body: "旧请求", expectedRevision: topic.revision }), (e: unknown) => e instanceof ControlDataError && e.status === 409);
  const archived = data.archiveRecent({ id: topic.id, expectedRevision: edited.revision, archived: true });
  assert.equal(archived.conversationState, "Done");
  assert.equal(data.recent({ archived: false }).total, 0);
  assert.equal(data.recent({ archived: true, query: "文档" }).total, 1);
  const restored = data.archiveRecent({ id: topic.id, expectedRevision: archived.revision, archived: false });
  assert.equal(restored.conversationState, "Ongoing");
  assert.equal(data.recent().items[0].archived, false);
  assert.equal("sourceId" in data.recent().items[0], false);
  const removed = data.deleteRecent({ id: topic.id, expectedRevision: restored.revision });
  assert.deepEqual(removed.deleted, [topic.id]);
  assert.deepEqual(data.deleteRecent({ id: topic.id, expectedRevision: restored.revision }).alreadyDeleted, [topic.id]);
  assert.throws(() => knowledge.createRecent({ id: topic.id, body: "重新创建相同记录" }), /已删除/);
  assert.equal((await sessions.view("telegram", "123")).history.count, 1);
  const db = openDatabase(mainPath(root), true);
  try { validateSixSchema(db); } finally { db.close(); }
}));

test("attachment access uses transcript references, safe metadata and an already-open descriptor", () => fixture(async (root, data, sessions) => {
  const directory = join(root, "media", "telegram");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "document.txt");
  await writeFile(path, "synthetic document");
  await sessions.append("telegram", "123", "123", [{ role: "user", content: "查看附件", at: "2026-10-25T00:00:00Z",
    attachments: [{ kind: "file", path, fileName: "../document\r\n.txt", mimeType: "text/html" }] }]);
  const history = await data.history({ conversationKey: "telegram:123" });
  assert.deepEqual(history.items[0].attachments, [{ index: 0, expectedRevision: history.items[0].revision, kind: "file", fileName: "document.txt", mimeType: "application/octet-stream" }]);
  assert.equal(JSON.stringify(history).includes(root), false);
  const file = await data.attachment({ conversationKey: "telegram:123", messageIndex: 0, attachmentIndex: 0 });
  try { assert.equal(await file.file.readFile("utf8"), "synthetic document"); assert.equal(file.size, 18); }
  finally { await file.file.close(); }
  await assert.rejects(data.attachment({ conversationKey: "telegram:123", messageIndex: 0, attachmentIndex: 1 }), (e: unknown) => e instanceof ControlDataError && e.status === 404);
}));

test("attachment access rejects external paths even if stored in history", () => fixture(async (root, data, sessions) => {
  const outside = join(root, "outside.txt");
  await writeFile(outside, "synthetic document");
  await sessions.append("telegram", "123", "123", [{ role: "user", content: "不可用附件", at: "2026-10-25T00:00:00Z",
    attachments: [{ kind: "file", path: outside }] }]);
  await assert.rejects(data.attachment({ conversationKey: "telegram:123", messageIndex: 0, attachmentIndex: 0 }),
    (e: unknown) => e instanceof ControlDataError && e.status === 404);
}));

test("attachment access rejects symbolic links when available", t => fixture(async (root, data, sessions) => {
  const directory = join(root, "media", "telegram");
  await mkdir(directory, { recursive: true });
  const target = join(directory, "document.txt"), link = join(directory, "linked.txt");
  await writeFile(target, "synthetic document");
  try { await symlink(target, link); }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Symbolic-link privilege unavailable; enable Windows Developer Mode to run this case."); return;
    }
    throw error;
  }
  await sessions.append("telegram", "123", "123", [{ role: "user", content: "不可用附件", at: "2026-10-25T00:00:00Z",
    attachments: [{ kind: "file", path: link }] }]);
  await assert.rejects(data.attachment({ conversationKey: "telegram:123", messageIndex: 0, attachmentIndex: 0 }),
    (e: unknown) => e instanceof ControlDataError && e.status === 404);
}));

test("context projection exposes only assembled local content and allowlisted checkpoint metadata", () => fixture(async (root, data, _sessions, knowledge, context) => {
  knowledge.createRecent({ body: "# 需要复查的文档\n第二章尚待检查。" });
  knowledge.createRecent({ body: "已结束的话题", conversationState: "Done" });
  await context.load();
  const sessionId = "telegram:123", items = [{ type: "compaction", encrypted_content: "synthetic-opaque-never-return" }];
  const checkpoint = checkpointFromItems(sessionId, "fixture-model", items, 4, "capacity", "2026-10-25T01:00:00Z");
  await new LaneStore(root).save({ sessionId, model: "fixture-model", needsBootstrap: false, contextItems: items,
    historyCursor: 4, coverageVerified: true, lastCompactedAt: checkpoint.at, checkpoint });
  const db = openDatabase(mainPath(root));
  try {
    putState(db, { key: "runtime/private-provider", value: JSON.stringify({ apiKey: "synthetic-secret-never-return" }) });
    putState(db, { key: "runtime/context/" + "0".repeat(64) + ".json", value: "not-json" });
  } finally { db.close(); }
  const result = data.context();
  assert.equal(result.available, true);
  assert.deepEqual(result.recent, { totalCount: 2, activeCount: 1 });
  assert.equal(result.checkpoints.length, 1);
  assert.equal(result.checkpoints[0].checkpoint?.id, checkpoint.id);
  // LaneStore omits a true flag when saving; absence is reported as unknown, not guessed.
  assert.equal(result.checkpoints[0].coverageVerified, null);
  assert.equal(result.checkpoints[0].archived, false);
  assert.equal(result.usage.supported, false);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("synthetic-opaque-never-return"), false);
  assert.equal(serialized.includes("synthetic-secret-never-return"), false);
  assert.equal(serialized.includes("contextItems"), false);
}));

test("history deletion is versioned and renumbers remaining transcript atomically",()=>fixture(async(root,_data,sessions,knowledge,context)=>{
  await sessions.append('telegram','70001','70001',[
    {role:'user',content:'合成目录问题',at:'2026-10-26T00:00:00Z',id:'entry-a'},
    {role:'assistant',content:'合成目录答复',at:'2026-10-26T00:00:01Z',id:'entry-b',origin:'chat',partial:false},
    {role:'user',content:'合成后续问题',at:'2026-10-26T00:00:02Z',id:'entry-c'}]);
  const data=new ControlData(root,{sessions,knowledge,context,editHistory:async(_id,work)=>work()});
  try {
    const before=await data.history({conversationKey:'telegram:70001'});
    assert.deepEqual(before.items.map(x=>x.index),[2,1,0]);
    const target=before.items[1];
    await assert.rejects(data.deleteHistory({conversationKey:'telegram:70001',messageIndex:1,expectedRevision:'0'.repeat(64),confirm:true}),/变化/);
    await data.deleteHistory({conversationKey:'telegram:70001',messageIndex:1,expectedRevision:target.revision,confirm:true});
    const after=await data.history({conversationKey:'telegram:70001'});
    assert.deepEqual(after.items.map(x=>x.content),['合成后续问题','合成目录问题']);
    assert.deepEqual(after.items.map(x=>x.index),[1,0]);
    const db=openDatabase(mainPath(root),true);try{validateSixSchema(db);}finally{db.close();}
  }finally{data.close();}
}));
