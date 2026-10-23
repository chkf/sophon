import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "./store.js";

test("SQLite history survives restart without recreating the retired migrations table", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlite-retired-migration-"));
  try {
    const store = new SessionStore(root);
    await store.append("telegram", "fixture", "owner", [
      { id: "first", role: "user", at: "2026-10-11T00:00:00Z", content: "已导入的消息" },
    ]);
    store.close();

    const restarted = new SessionStore(root);
    await restarted.prepare();
    assert.equal((await restarted.get("telegram", "fixture"))?.messages[0]?.content, "已导入的消息");
    restarted.close();

    const db = new DatabaseSync(join(root, "sessions", "gateway.sqlite"), { readOnly: true });
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name='migrations'").get()?.n, 0);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FTS5 search keeps timestamps and snapshot boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "sqlite-search-"));
  try {
    const store = new SessionStore(root);
    await store.append("telegram", "fixture", "owner", [
      { id: "a", role: "user", at: "2026-10-09T00:00:00Z", content: "ExampleModel 证据" },
      { id: "b", role: "assistant", at: "2026-10-10T00:00:00Z", content: "文档检索样例 Evidence" },
    ]);
    const history = (await store.view("telegram", "fixture")).history;
    await store.append("telegram", "fixture", "owner", [
      { id: "c", role: "user", at: "2026-10-11T00:00:00Z", content: "新的 Evidence" },
    ]);
    assert.equal((await history.search("Evidence", 0, 4)).total, 1);
    assert.equal((await history.search("文档检索", 0, 4)).entries[0]?.id, "b");
    assert.equal((await history.search("文档", 0, 4)).entries[0]?.at, "2026-10-10T00:00:00Z");
    assert.deepEqual((await history.readTail(9)).map(message => message.id), ["a", "b"]);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
