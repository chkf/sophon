import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactionNoticeLedger } from "./compaction-notice.js";
import { checkpointFromItems } from "./compaction.js";
import { TelegramAdapter } from "../../channels/telegram/adapter.js";
import { TelegramStateStore } from "../../channels/telegram/state-store.js";

test("checkpoint notice is claimed once across process restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-compact-notice-"));
  try {
    const checkpoint = checkpointFromItems("owner:chat", "fixture-model",
      [{ type: "compaction", encrypted_content: "opaque-result" }], 6,
      "capacity", "2026-10-23T00:00:00Z");
    assert.equal(await new CompactionNoticeLedger(root).claim(checkpoint), true);
    assert.equal(await new CompactionNoticeLedger(root).claim(checkpoint), false);
    const next = checkpointFromItems("owner:chat", "fixture-model",
      [{ type: "compaction", encrypted_content: "different-result" }], 12,
      "seven_days", "2026-10-30T00:00:00Z");
    assert.equal(await new CompactionNoticeLedger(root).claim(next), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Telegram notification targets owner, records 60-second expiry and deletes through existing timer", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-compact-telegram-"));
  const actions: Array<{ method: string; data: Record<string, unknown> }> = [];
  let sentId = 41;
  const api = { async call(method: string, data: Record<string, unknown>) {
    actions.push({ method, data });
    return method === "sendMessage" ? { message_id: ++sentId } : true;
  } };
  const adapter = new TelegramAdapter({ token: "fixture", ownerId: "owner-id", dataDir: root,
    mediaStore: {} as any, api: api as any });
  try {
    const started = Date.now();
    await adapter.notifyTemporary("🧠 Gateway 上下文已压缩");
    assert.deepEqual(actions.map(action => action.method), ["sendMessage"]);
    assert.equal(actions[0]!.data.chat_id, "owner-id");
    const state = await new TelegramStateStore(root).load();
    assert.deepEqual(state.commandReplyDeletions?.[0]?.messageIds, [42]);
    assert.ok((state.commandReplyDeletions?.[0]?.expiresAtMs ?? 0) - started >= 60_000);
    assert.ok((state.commandReplyDeletions?.[0]?.expiresAtMs ?? 0) - Date.now() <= 60_000);
    await adapter.notifyTemporary("short fixture", 20);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(actions.some(action => action.method === "deleteMessage" && action.data.message_id === 43));
  } finally { await adapter.stop(); await rm(root, { recursive: true, force: true }); }
});
