import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalKnowledgeStore } from "./store.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "gateway-knowledge-"));
  const sessions = join(root, "sessions");
  mkdirSync(sessions);
  const db = new DatabaseSync(join(sessions, "gateway.sqlite"));
  db.exec("CREATE TABLE messages(conv_key TEXT, seq INTEGER, content TEXT);");
  for (let seq = 0; seq < 4; seq++) db.prepare("INSERT INTO messages(conv_key, seq, content) VALUES(?,?,?)")
    .run("telegram:123", seq, "message " + seq);
  db.close();
  const store = new LocalKnowledgeStore(root, "formal");
  return { store, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const baseRecent = {
  body: "需要后续聊的话题", conversationState: null, stateDate: null,
  eventAt: "2026-10-10T16:00:00+08:00", sourceId: "trusted:one",
} as const;

test("trusted creates are idempotent, never guess Done and never overwrite a changed source", () => {
  const { store, cleanup } = setup();
  try {
    const first = store.createRecent(baseRecent);
    assert.equal(store.createRecent(baseRecent).id, first.id);
    assert.equal(store.getRecent(first.id)?.conversationState, null);
    assert.throws(() => store.createRecent({ ...baseRecent, body: "changed" }), /changed/);
    assert.equal(store.listRecent().length, 1);
    assert.throws(() => store.createRecent({
      ...baseRecent, sourceId: "trusted:invalid", eventAt: "not-a-date",
    }), /Event time requires explicit ISO 8601 timezone/);
  } finally { cleanup(); }
});

test("state date updates only on a real conversation-state transition", () => {
  const { store, cleanup } = setup();
  try {
    const id = store.createRecent(baseRecent).id;
    const a = store.updateRecent({ id, expectedRevision: 1, conversationState: "Pending", stateDate: "2026-10-11" });
    assert.equal(a.stateDate, "2026-10-11");
    const b = store.updateRecent({ id, expectedRevision: 2, body: "后来补充的正文" });
    assert.equal(b.stateDate, "2026-10-11");
    assert.throws(() => store.updateRecent({ id, expectedRevision: 3, stateDate: "2026-10-12" }), /only when/);
    assert.throws(() => store.updateRecent({ id, expectedRevision: 2, body: "lost" }), /Stale Recent/);
    assert.throws(() => store.updateRecent({ id, expectedRevision: 3, conversationState: "Done" }), /Explicit state date/);
    const c = store.updateRecent({ id, expectedRevision: 3, conversationState: "Done", stateDate: "2026-10-12" });
    assert.equal(c.stateDate, "2026-10-12");
    assert.equal(store.getRecent(id)?.conversationState, "Done",
      "completed topics remain archived until explicitly deleted");
  } finally { cleanup(); }
});

test("review progress and Recent edits commit atomically and are safe to replay", () => {
  const { store, cleanup } = setup();
  try {
    const id = store.createRecent(baseRecent).id;
    assert.equal(store.getReviewCursor("formal:telegram:123"), -1);
    assert.throws(() => store.commitReview("formal:telegram:missing", -1, 2, []), /unseen messages/);
    assert.throws(() => store.commitReview("formal:telegram:123", -1, 12, []), /unseen messages/);
    assert.throws(() => store.commitReview("ephemeral:123", -1, 2, []), /Only formal/);
    assert.throws(() => store.commitReview("formal:telegram:123", -1, 2, [
      { id, expectedRevision: 1, body: "updated" },
      { id: "recent:missing", expectedRevision: 1, body: "invalid" },
    ]), /not found/);
    assert.equal(store.getReviewCursor("formal:telegram:123"), -1);
    assert.equal(store.getRecent(id)?.body, baseRecent.body);
    assert.equal(store.commitReview("formal:telegram:123", -1, 2, [
      { id, expectedRevision: 1, body: "updated" },
    ]), "committed");
    assert.equal(store.getReviewCursor("formal:telegram:123"), 2);
    assert.equal(store.commitReview("formal:telegram:123", -1, 2, [
      { id, expectedRevision: 1, body: "updated" },
    ]), "already");
    assert.equal(store.getRecent(id)?.revision, 2);
    assert.throws(() => store.commitReview("formal:telegram:123", -1, 3, []), /advanced concurrently/);
  } finally { cleanup(); }
});
test("review creates and updates share the cursor transaction", () => {
  const { store, cleanup } = setup();
  try {
    const id = store.createRecent(baseRecent).id;
    assert.throws(() => store.commitReview("formal:telegram:123", -1, 1,
      [{ id, expectedRevision: 1, body: "审阅过的原话" }],
      [{ body: "新话题", conversationState: null }, { body: "新话题", conversationState: null }]), /duplicate/);
    assert.equal(store.getReviewCursor("formal:telegram:123"), -1);
    assert.equal(store.getRecent(id)?.revision, 1);
    assert.equal(store.listRecent().length, 1);
    assert.equal(store.commitReview("formal:telegram:123", -1, 1,
      [{ id, expectedRevision: 1, body: "审阅过的原话" }],
      [{ body: "新话题", conversationState: null }]), "committed");
    assert.equal(store.getReviewCursor("formal:telegram:123"), 1);
    assert.equal(store.listRecent().length, 2);
    assert.equal(store.commitReview("formal:telegram:123", -1, 1, [],
      [{ body: "新话题", conversationState: null }]), "already");
    assert.equal(store.listRecent().length, 2);
  } finally { cleanup(); }
});
