import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalKnowledgeStore } from "./store.js";
import { executeLocalKnowledgeTool as run, LOCAL_KNOWLEDGE_TOOLS as defs } from "./tools.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "gateway-tools-"));
  mkdirSync(join(root, "sessions"));
  const db = new DatabaseSync(join(root, "sessions", "gateway.sqlite"));
  db.exec("CREATE TABLE messages(content TEXT)");
  db.close();
  const store = new LocalKnowledgeStore(root, "formal");
  const seededId = store.createRecent({ body: "明天晚上核对测试结果", conversationState: null, stateDate: null,
    sourceId: "s:rec:1", eventAt: null }).id;
  return { store, seededId, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("local tools default to formal-only with readOnly metadata", () => {
  const { store, cleanup } = setup();
  try {
    assert.equal(defs.length, 4);
    assert.deepEqual(defs.map(t => t.readOnly), [true, false, false, false]);
    assert.throws(() => run(store, "ephemeral", "gateway_recent_read", {}), /临时/);
    assert.throws(() => run(store, "ephemeral", "gateway_recent_write", {}), /临时/);
    assert.throws(() => run(store, "formal", "gateway_recent_read", { unknown: true }), /未授权/);
  } finally { cleanup(); }
});

test("recent write requires a revision and preserves unknown initial state", () => {
  const { store, seededId, cleanup } = setup();
  try {
    const read = run(store, "formal", "gateway_recent_read", { id: seededId }) as any;
    assert.equal(read.entry.conversationState, null);
    assert.equal(read.entry.revision, 1);
    assert.throws(() => run(store, "formal", "gateway_recent_write",
      { id: seededId, expected_revision: 1, conversation_state: "Fake", state_date: "2026-10-18" }), /Unknown state/);
    const changed = run(store, "formal", "gateway_recent_write",
      { id: seededId, expected_revision: 1, conversation_state: "Ongoing", state_date: "2026-10-18" }) as any;
    assert.equal(changed.updated.revision, 2);
    assert.equal(changed.updated.stateDate, "2026-10-18");
    assert.throws(() => run(store, "formal", "gateway_recent_write",
      { id: seededId, expected_revision: 1, body: "stale" }), /Stale Recent/);
    const created = run(store, "formal", "gateway_recent_create", {
      body: "今天晚上九点检查任务状态", event_at: "2026-10-18T21:00:00+08:00",
    }) as any;
    assert.equal(created.created.conversationState, null);
    assert.equal(created.created.eventAt, "2026-10-18T21:00:00+08:00");
    const changedTime = run(store, "formal", "gateway_recent_write", {
      id: created.created.id, expected_revision: 1,
      event_at: "2026-10-18T22:00:00+08:00",
    }) as any;
    assert.equal(changedTime.updated.eventAt, "2026-10-18T22:00:00+08:00");
    assert.throws(() => run(store, "formal", "gateway_recent_create", {
      body: "不明确日期", event_at: "tonight",
    }), /ISO 8601/);
    const listing = run(store, "formal", "gateway_recent_read", { query: "明天" }) as any;
    assert.equal(listing.total, 1);
    assert.equal(listing.items[0].body, undefined);
  } finally { cleanup(); }
});

test("trusted source replays are idempotent and conflicting retries cannot duplicate", () => {
  const { store, cleanup } = setup();
  try {
    const key = "gateway:trusted-inbound-slot0";
    const first = run(store, "formal", "gateway_recent_create", { body: "原始话题" }, key) as any;
    const same = run(store, "formal", "gateway_recent_create", { body: "原始话题" }, key) as any;
    assert.equal(first.created.id, same.created.id);
    assert.throws(() => run(store, "formal", "gateway_recent_create", {
      body: "模型重试生成了不同话题",
    }, key), /changed/);
    assert.equal(store.listRecent().length, 2, "only original source and one new thread remain");
  } finally { cleanup(); }
});

test("SQLite tool interface rejects unknown tools", () => {
  const { store, cleanup } = setup();
  try {
    assert.throws(() => run(store, "formal", "unknown_read", {}), /未知本地工具/);
    assert.throws(() => run(store, "formal", "unknown_write", {}), /未知本地工具/);
  } finally { cleanup(); }
});
