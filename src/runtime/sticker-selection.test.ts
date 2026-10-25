import assert from "node:assert/strict";
import test from "node:test";
import { StickerTurn, validSticker } from "./stickers.js";
import { historyFromMessages } from "./history.js";
import type { InboundMessage, TelegramSticker } from "../channels/types.js";
import type { SessionMessage } from "../sessions/types.js";

const sticker: TelegramSticker = { fileId: "fixture_document_icon", accountId: "telegram-bot:70002", chatId: "70001", format: "static", emoji: "📄", setName: "FixtureDocuments" };
function inbound(value = sticker): InboundMessage {
  return { channel: "telegram", senderId: "70001", conversationId: "70001", messageId: "1", text: "查看文档图标", receivedAt: "2030-01-01T00:00:00Z", attachments: [],
    platformMessages: [{ accountId: sticker.accountId, conversationId: "70001", direction: "inbound", messageId: "1", text: "", attachments: [{ kind: "image", sticker: value }] }] };
}
function entry(value = sticker): SessionMessage {
  return { role: "user", content: "文档图标", source: { channel: "telegram", senderId: "70001", messageId: "1", platformMessages: inbound(value).platformMessages } };
}
test("sticker selection requires a catalog key and permits only one selection", async () => {
  const message = inbound();
  message.platformMessages![0]!.attachments!.push({ kind: "image", sticker: { ...sticker, fileId: "fixture_folder_icon" } });
  const turn = new StickerTurn(historyFromMessages([]), message);
  await assert.rejects(turn.execute({ action: "select", key: sticker.fileId }));
  const result = await turn.execute({ action: "list" }) as { stickers: { key: string }[] };
  assert.equal(result.stickers.length, 2);
  assert.equal(JSON.stringify(result).includes(sticker.fileId), false);
  await turn.execute({ action: "select", key: result.stickers[0]!.key });
  await turn.execute({ action: "select", key: result.stickers[0]!.key });
  await assert.rejects(turn.execute({ action: "select", key: result.stickers[1]!.key }));
  assert.deepEqual(turn.prepared, sticker);
});
test("sticker lookup defaults to recent history and supports an explicit older index", async () => {
  const records: SessionMessage[] = [entry(), ...Array.from({ length: 60 }, () => ({ role: "user" as const, content: "任务记录" }))];
  const message = inbound(); message.platformMessages![0]!.attachments = [];
  const turn = new StickerTurn(historyFromMessages(records), message);
  assert.deepEqual((await turn.execute({ action: "list" }) as { stickers: unknown[] }).stickers, []);
  const result = await turn.execute({ action: "list", history_index: 0 }) as { stickers: { key: string }[] };
  assert.equal(result.stickers.length, 1);
  await turn.execute({ action: "select", key: result.stickers[0]!.key });
  assert.deepEqual(turn.prepared, sticker);
  await assert.rejects(turn.execute({ action: "list", history_index: 61 }));
  await assert.rejects(turn.execute({ action: "list", history_index: -1 }));
});
test("sticker catalog rejects foreign accounts, chats, senders and outgoing records", async () => {
  const foreignBot = entry({ ...sticker, accountId: "telegram-bot:70003" });
  const foreignChat = entry({ ...sticker, chatId: "70004" });
  const foreignSender = entry(); foreignSender.source!.senderId = "70004";
  const outgoing = entry(); outgoing.source!.platformMessages![0]!.direction = "outbound";
  const message = inbound(); message.platformMessages![0]!.attachments = [];
  const turn = new StickerTurn(historyFromMessages([foreignBot, foreignChat, foreignSender, outgoing]), message);
  assert.deepEqual((await turn.execute({ action: "list" }) as { stickers: unknown[] }).stickers, []);
  for (const invalid of [{ ...message, channel: "wechat" as const }, { ...message, senderId: "70004" }]) {
    await assert.rejects(new StickerTurn(historyFromMessages([]), invalid).execute({ action: "list" }));
  }
});
test("sticker metadata rejects malformed identifiers and unknown formats", () => {
  for (const value of [{ ...sticker, fileId: "../file" }, { ...sticker, fileId: "x".repeat(513) }, { ...sticker, format: "other" }]) {
    assert.equal(validSticker(value as TelegramSticker, sticker.chatId, sticker.accountId), false);
  }
  assert.equal(validSticker(sticker, sticker.chatId), false);
  assert.equal(validSticker(sticker, sticker.chatId, sticker.accountId), true);
});
