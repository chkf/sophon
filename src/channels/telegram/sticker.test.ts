import assert from "node:assert/strict";
import test from "node:test";
import { TelegramAdapter } from "./adapter.js";

test("Telegram sticker delivery is opt-in and restricted to configured IDs", async () => {
  const calls: Array<{ method: string; body: any }> = [];
  const adapter = new TelegramAdapter({
    token: "fake", ownerId: "123", dataDir: "/tmp", mediaStore: {} as any,
    stickerIds: ["known-sticker-id"],
    api: { async call(method: string, body: any) { calls.push({ method, body }); return { message_id: 1 }; } } as any,
  });
  assert.equal(adapter.availableStickers(), 1);
  await adapter.sendSticker("123", 1);
  assert.deepEqual(calls, [{ method: "sendSticker", body: { chat_id: "123", sticker: "known-sticker-id" } }]);
  await assert.rejects(adapter.sendSticker("123", 2), /allowlisted/);
  await assert.rejects(adapter.sendSticker("123", 0), /allowlisted/);
  assert.equal(calls.length, 1);
});
