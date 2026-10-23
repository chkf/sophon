import type { TelegramMessage, TelegramPhoto, TelegramBufferedBatch } from "./types.js";
import type { InboundMessage } from "../types.js";
export function telegramMessageAllowed(message: TelegramMessage, ownerId: string): boolean {
  return String(message.from?.id ?? "") === ownerId && message.chat.type === "private";
}

export function largestPhoto(photos?: TelegramPhoto[]): TelegramPhoto | undefined {
  return photos?.slice().sort((a, b) => (b.file_size ?? b.width! * b.height!) - (a.file_size ?? a.width! * a.height!))[0];
}

export function immediateCommand(text: string): boolean {
  const value = text.trim();
  return /^\/[a-z0-9_]+(?:@[a-z0-9_]+)?(?:\s|$)/i.test(value) || /^npm[ \t]+run(?:[ \t]|$)/i.test(value);
}


export function normalizeReplyTo(message: TelegramMessage, ownerId: string): InboundMessage["replyTo"] {
  const quoted = message.reply_to_message;
  if (!quoted) return undefined;
  const quotedSenderId = String(quoted.from?.id ?? "");
  const sender =
    quotedSenderId === ownerId
      ? "user"
      : quoted.from?.is_bot === true
        ? "assistant"
        : "unknown";
  const text = (quoted.text ?? quoted.caption ?? "").trim();
  return {
    messageId: String(quoted.message_id),
    sender,
    ...(text ? { text } : {}),
  };
}

export function sameReplyTarget(a: InboundMessage["replyTo"], b: InboundMessage["replyTo"]): boolean {
  return Boolean(a && b && a.messageId === b.messageId && a.sender === b.sender);
}

export function bufferedReplyTo(batch: TelegramBufferedBatch): InboundMessage["replyTo"] {
  return batch.parts.find((part) => part.replyTo)?.replyTo;
}

export function batchAcceptsReply(
  batch: TelegramBufferedBatch,
  chatId: string,
  replyTo: InboundMessage["replyTo"],
): boolean {
  if (batch.chatId !== chatId) return false;
  if (!replyTo) return true;
  const existing = bufferedReplyTo(batch);
  return !existing || sameReplyTarget(existing, replyTo);
}

export function batchesCanMerge(a: TelegramBufferedBatch, b: TelegramBufferedBatch): boolean {
  if (a.chatId !== b.chatId || a.senderId !== b.senderId) return false;
  const aReply = bufferedReplyTo(a);
  const bReply = bufferedReplyTo(b);
  return !aReply || !bReply || sameReplyTarget(aReply, bReply);
}

const INBOUND_RETRY_BACKOFF_MS = [5_000, 10_000, 30_000, 60_000] as const;
export const MAX_AUTOMATIC_RETRY_ATTEMPTS = 3;

export function inboundRetryDelayMs(attempt: number, requestedMs = 0): number {
  const index = Math.min(Math.max(0, attempt - 1), INBOUND_RETRY_BACKOFF_MS.length - 1);
  return Math.max(requestedMs, INBOUND_RETRY_BACKOFF_MS[index]!);
}

export function mergeBufferedBatch(batch: TelegramBufferedBatch): InboundMessage {
  let attachmentIndex=0;
  const hasVoice=batch.parts.some(part=>part.attachments.some(a=>a.kind==="voice"||a.kind==="audio"));
  const texts = batch.parts.map(part => {
    const markers=part.attachments.map(()=>"[附件索引 "+(++attachmentIndex)+"]");
    return [part.text.trim(),...(hasVoice?markers:[])].filter(Boolean).join("\n");
  }).filter(Boolean);
  const attachments = batch.parts.flatMap((part) => part.attachments);
  const first = batch.parts[0]!;
  const last = batch.parts[batch.parts.length - 1]!;
  const replyTo = bufferedReplyTo(batch);
  // Preserve physical message IDs; never infer a single ID for an entire batch.
  const platformMessages = batch.parts.flatMap(part => part.platformMessage ? [part.platformMessage] : []);
  return {
    channel: "telegram",
    conversationId: batch.chatId,
    senderId: batch.senderId,
    messageId: batch.parts.length === 1
      ? first.messageId
      : first.messageId + "-" + last.messageId,
    text: texts.join("\n\n"),
    receivedAt: last.receivedAt,
    attachments,
    ...(replyTo ? { replyTo } : {}),
    ...(platformMessages.length === batch.parts.length ? { platformMessages } : {}),
  };
}
