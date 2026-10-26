import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramAdapter } from "./adapter.js";
import { deliverPreparedReply } from "./delivery.js";
import type { TelegramApiClient, TelegramMessage, TelegramAdapterConfig, TelegramPendingReply } from "./types.js";
import type { Attachment, TelegramSticker } from "../types.js";
import { MediaStore } from "../../media/store.js";

const sticker: TelegramSticker = { fileId: "fixture_document_icon", accountId: "telegram-bot:70002", chatId: "70001", format: "static" };
const pending: TelegramPendingReply = { kind: "model_reply", chatId: "70001", senderId: "70001", text: "", deliveryId: "fixture-delivery", sticker };
async function preview(format: "static" | "animated" | "video", failure?: "missing" | "download" | "size") {
  const root = await mkdtemp(join(tmpdir(), "sticker-preview-"));
  const fetched: string[] = [];
  const api: TelegramApiClient = { async call<T>() { return {} as T; }, async getFile(id) { fetched.push(id); return { file_path: "fixture/preview.webp", file_size: failure === "size" ? 2048 : 16 }; },
    async downloadFile() { if (failure === "download") throw new Error("Synthetic transport failure"); return new Uint8Array(16); } };
  const adapter = new TelegramAdapter({ token: "70002:fixture-token", ownerId: "70001", dataDir: root, mediaStore: new MediaStore(root), api, maxMediaBytes: 1024 });
  const message: TelegramMessage = { message_id: 1, date: 1, chat: { id: 70001, type: "private" }, sticker: { file_id: sticker.fileId,
    is_animated: format === "animated", is_video: format === "video", ...(failure === "missing" ? {} : { thumbnail: { file_id: "fixture_preview" } }) } };
  try {
    const items = await (adapter as unknown as { collectAttachments(m: TelegramMessage): Promise<Attachment[]> }).collectAttachments(message);
    return { item: items[0]!, fetched };
  } finally { await adapter.stop(); await rm(root, { recursive: true, force: true }); }
}
for (const format of ["static", "animated", "video"] as const) test(`${format} sticker uses the expected visual source and keeps original send metadata`, async () => {
  const { item, fetched } = await preview(format);
  assert.deepEqual(fetched, format === "video" ? [sticker.fileId, "fixture_preview"] : [format === "static" ? sticker.fileId : "fixture_preview"]);
  assert.equal(item.sticker!.fileId, sticker.fileId);
  assert.equal(item.sticker!.format, format);
  assert.ok(item.localPath);
  if (format !== "static") assert.match(item.textPreview!, /静态预览/);
});
for (const failure of ["missing", "download", "size"] as const) test(`unavailable sticker preview (${failure}) retains metadata without claiming image access`, async () => {
  const { item } = await preview("animated", failure);
  assert.equal(item.localPath, undefined);
  assert.equal(item.sticker!.fileId, sticker.fileId);
  assert.ok(item.error);
});
test("sticker delivery attaches native reply only once and records the confirmed sticker", async () => {
  const calls: Record<string, unknown>[] = [];
  const api = { async call<T>(method: string, body: Record<string, unknown>) { assert.equal(method, "sendSticker"); calls.push(body); return { message_id: 8 } as T; } } as TelegramApiClient;
  let event: Parameters<NonNullable<TelegramAdapterConfig["onReplyDelivered"]>>[0] | undefined;
  await deliverPreparedReply(api, { ...pending, text: "文档已检查。", nativeReply: { channel: "telegram", chatId: "70001", accountId: sticker.accountId, messageId: 1 } },
    { onReplyDelivered: value => { event = value; } }, async (_target, text, record, reply) => { assert.equal(reply, undefined); record?.(text, 9); }, sticker.accountId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.sticker, sticker.fileId);
  assert.deepEqual(calls[0]!.reply_parameters, { message_id: 1, allow_sending_without_reply: true });
  assert.deepEqual(event!.platformMessages![0]!.attachments![0]!.sticker, sticker);
});
test("missing sticker receipt is an uncertain single attempt, never successful delivery", async () => {
  let attempts = 0, failures = 0, successes = 0;
  const api = { async call<T>() { attempts++; return {} as T; } } as TelegramApiClient;
  await deliverPreparedReply(api, pending, { onReplyDelivered: () => { successes++; }, onReplyDeliveryFailed: () => { failures++; } }, async () => {}, sticker.accountId);
  assert.equal(attempts, 1); assert.equal(failures, 1); assert.equal(successes, 0);
});
test("transport rejects a sticker associated with another chat before network access", async () => {
  let attempts = 0, failures = 0;
  const api = { async call<T>() { attempts++; return {} as T; } } as TelegramApiClient;
  await deliverPreparedReply(api, { ...pending, sticker: { ...sticker, chatId: "70004" } }, { onReplyDeliveryFailed: () => { failures++; } }, async () => {}, sticker.accountId);
  assert.equal(attempts, 0); assert.equal(failures, 1);
});
test("a confirmed sticker remains in partial delivery history if subsequent text fails", async () => {
  const api = { async call<T>() { return { message_id: 8 } as T; } } as TelegramApiClient;
  let event: Parameters<NonNullable<TelegramAdapterConfig["onReplyDelivered"]>>[0] | undefined;
  await deliverPreparedReply(api, { ...pending, text: "文档状态" }, { onReplyDelivered: value => { event = value; } }, async () => { throw new Error("Synthetic text failure"); }, sticker.accountId);
  assert.equal(event!.complete, false);
  assert.deepEqual(event!.platformMessages![0]!.attachments![0]!.sticker, sticker);
});
test("prepared sticker survives restart and its send intent is consumed before an uncertain attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "sticker-restart-"));
  let attempts = 0;
  const api: TelegramApiClient = { async call<T>(method) {
    if (method === "sendSticker") { attempts++; throw new Error("Synthetic connection loss"); }
    return {} as T;
  }, async getFile() { return {}; }, async downloadFile() { return new Uint8Array(); } };
  const config = { token: "70002:fixture-token", ownerId: "70001", dataDir: root, mediaStore: new MediaStore(root), api };
  type Internal = { prepareReply(inbound: { conversationId: string; senderId: string }, reply: TelegramPendingReply): Promise<void>; resumePendingReply(): Promise<void> };
  try {
    const first = new TelegramAdapter(config);
    await (first as unknown as Internal).prepareReply({ conversationId: "70001", senderId: "70001" }, pending);
    await first.stop();
    const second = new TelegramAdapter(config);
    await second.availableTarget();
    await (second as unknown as Internal).resumePendingReply();
    await second.stop();
    const third = new TelegramAdapter(config);
    await third.availableTarget();
    await (third as unknown as Internal).resumePendingReply();
    await third.stop();
    assert.equal(attempts, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
