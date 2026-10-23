import { displayText, spokenText, replyText, visibleSegments, type ReplySegment } from "../../runtime/reply-segments.js";
import { readFile } from "node:fs/promises";
import { voiceSupplement } from "../../voice/tool.js";
import { createHash } from "node:crypto";
import type { RuntimeImage } from "../../runtime/types.js";
import type { TelegramApiClient, TelegramPendingReply, TelegramAdapterConfig } from "./types.js";
import { TelegramBotApiError } from "./api.js";
import { splitHumanMessages } from "../message-splitting.js";
import { normalizeInboundReply } from "../reply.js";
import type { InboundReply, PlatformMessageFragment, TelegramNativeReply } from "../types.js";
import { nativeReplyParameters } from "../../runtime/native-reply.js";
export type TelegramTextProgress = (text: string, messageId: number) => void;
export async function sendTelegramImage(api: TelegramApiClient, target: string, image: RuntimeImage,
  reply?: ReturnType<typeof nativeReplyParameters>): Promise<number | undefined> {
  const bytes = await readFile(image.path);
  if (bytes.length > 8 * 1024 * 1024 || bytes.length !== image.size || createHash("sha256").update(bytes).digest("hex") !== image.sha256) throw new Error("Prepared image invalid.");
  const sent = await api.call<{ message_id?: number }>("sendPhoto", { chat_id: target, photo: new Blob([new Uint8Array(bytes)], { type: image.mimeType }),
    ...(reply ? { reply_parameters: reply } : {}) }, 60_000);
  return sent?.message_id;
}
export class TelegramDelivery {
  constructor(private readonly api: TelegramApiClient) {}
  /** Only the first physical bubble gets reply_parameters. Never replay uncertain sends. */
  async sendTextCollectMessageIds(target: string, text: string,
    onSent?: (id: number, text: string) => void,
    reply?: ReturnType<typeof nativeReplyParameters>,
    requireReceipt = Boolean(onSent)): Promise<number[]> {
    const messageIds: number[] = [];
    const bubbles = splitHumanMessages(text);
    let first = true;
    for (let index = 0; index < bubbles.length; index++) {
      if (index > 0) await this.api.call("sendChatAction", { chat_id: target, action: "typing" }).catch(() => undefined);
      for (const chunk of splitTelegramText(bubbles[index]!)) {
        const replyForChunk = first ? reply : undefined;
        first = false;
        const messageId = await this.sendMessageWithSafeRetry(target, chunk, replyForChunk);
        // Voice and other strict progress paths require an actual acknowledged ID.
        if ((requireReceipt || Boolean(reply)) && (messageId === undefined || !Number.isSafeInteger(messageId) || messageId <= 0))
          throw new Error("Telegram text delivery is uncertain: missing or invalid message_id.");
        if (messageId !== undefined && Number.isSafeInteger(messageId) && messageId > 0) {
          messageIds.push(messageId);
          onSent?.(messageId, chunk);
        }
      }
    }
    return messageIds;
  }

  private async sendMessageWithSafeRetry(target: string, text: string,
    reply?: ReturnType<typeof nativeReplyParameters>): Promise<number | undefined> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const sent = await this.api.call<unknown>("sendMessage", { chat_id: target, text,
          ...(reply ? { reply_parameters: reply } : {}) });
        if (sent && typeof sent === "object" && typeof (sent as { message_id?: unknown }).message_id === "number")
          return (sent as { message_id: number }).message_id;
        return undefined;
      } catch (error) {
        const safeRateLimitRetry = error instanceof TelegramBotApiError && error.errorCode === 429;
        if (!safeRateLimitRetry || attempt >= maxAttempts) throw error;
        const retryAfterSeconds = Math.max(0, error.retryAfterSeconds ?? 1);
        console.error("[telegram] sendMessage rate-limited; retrying after " +
          retryAfterSeconds + "s (attempt " + (attempt + 1) + "/" + maxAttempts + ").");
        await new Promise(resolve => setTimeout(resolve, retryAfterSeconds * 1000));
      }
    }
    return undefined;
  }
}

export function splitTelegramText(text: string, maxLength = 4000): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < maxLength / 2) cut = remaining.lastIndexOf(" ", maxLength);
    if (cut < maxLength / 2) cut = maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
export async function deliverPreparedReply(api: TelegramApiClient, pending: TelegramPendingReply,
  callbacks: Pick<TelegramAdapterConfig, "onReplyDelivered" | "onReplyDeliveryFailed" | "sendVoice" | "showStageDirections">,
  sendText: (target: string, text: string, onSent?: TelegramTextProgress,
    reply?: TelegramNativeReply, requireReceipt?: boolean) => Promise<void>,
  accountId?: string): Promise<void> {
  if (pending.kind === "model_reply" && callbacks.showStageDirections) {
    const show = await callbacks.showStageDirections();
    const replySegments = pending.replySegments ? visibleSegments(pending.replySegments, show) : undefined;
    pending = { ...pending, text: replySegments ? replyText(replySegments) : displayText(pending.text, show),
      ...(replySegments ? {replySegments} : {}),
      ...(pending.voiceText ? {voiceText:spokenText(pending.voiceText)} : {}) };
  }
  const sentImages: RuntimeImage[] = [];
  const deliveredText: string[] = [];
  const platformMessages: PlatformMessageFragment[] = [];
  const verified = pending.kind === "model_reply"
    ? nativeReplyParameters(pending.nativeReply, pending.chatId, accountId) : undefined;
  const native = verified && pending.kind === "model_reply" ? pending.nativeReply : undefined;
  let attached = false;
  const record = (messageId: number, text: string) => {
    if (accountId && Number.isSafeInteger(messageId) && messageId > 0) {
      platformMessages.push({ accountId, conversationId: pending.chatId,
        direction: "outbound", messageId: String(messageId), text });
    }
  };
  const sendTextTracked = async (text: string, strict: boolean) => {
    const reply = attached ? undefined : native;
    if (reply) attached = true;
    await sendText(pending.chatId, text, (chunk, messageId) => {
      deliveredText.push(chunk);
      record(messageId, chunk);
    }, reply, strict);
  };
  try {
    // The durable pending reply was consumed before the first network attempt.
    for (const image of (pending.kind === "model_reply" ? pending.images ?? [] : []).slice(0, 1)) {
      const reply = attached ? undefined : verified;
      if (reply) attached = true;
      const id = await sendTelegramImage(api, pending.chatId, image, reply);
      if (native && (id === undefined || !Number.isSafeInteger(id) || id <= 0))
        throw new Error("Telegram photo delivery is uncertain: missing or invalid message_id.");
      sentImages.push(image);
      if (id !== undefined && Number.isSafeInteger(id) && id > 0) record(id, "[已发送图片]");
    }
    if (pending.kind === "model_reply" && pending.replySegments) {
      const prepared = pending;
      await deliverReplySegments(prepared.replySegments!,
        text => sendTextTracked(text, true),
        async (part, index) => {
          const voiceReply = attached ? undefined : native;
          const spoken = await callbacks.sendVoice?.(api, prepared.chatId, part.text,
            prepared.deliveryId + ":segment:" + index, voiceReply,
            id => record(id, part.text), part.instruction) ?? false;
          if (spoken) { deliveredText.push(part.text); if (voiceReply) attached = true; }
          return spoken;
        });
    } else if (pending.text) {
      const voice = pending.kind === "model_reply"
        ? pending.voiceText ?? (pending.voiceRequested && !pending.images?.length ? pending.text : undefined) : undefined;
      // A definite voice-generation failure has not sent anything; its text
      // fallback may still use the original native target. Unknown voice stops.
      const voiceReply = !attached ? native : undefined;
      const spoken = voice && pending.kind === "model_reply"
        ? await callbacks.sendVoice?.(api, pending.chatId, voice, pending.deliveryId, voiceReply,
            messageId => record(messageId, voice), pending.voiceInstruction) : false;
      if (spoken) {
        deliveredText.push(voice!);
        if (voiceReply) attached = true;
      }
      const text = voice ? voiceSupplement(pending.text, voice) : pending.text;
      if (!spoken && voice) await sendTextTracked("（语音未发出，已改用文字；原因见 /model → 语音设置。）\n" + voice, true);
      if (text) await sendTextTracked(text, Boolean(voice || native));
    }
    if (pending.kind === "model_reply") {
      try {
        await callbacks.onReplyDelivered?.({
          conversationId: pending.chatId, senderId: pending.senderId, reply: pending.text,
          images: pending.images, deliveryId: pending.deliveryId,
          ...(platformMessages.length ? { platformMessages } : {}),
        });
      } catch (error) {
        console.error("[telegram] reply was delivered but assistant session commit failed:",
          error instanceof Error ? error.message : error);
      }
    }
  } catch (error) {
    if (pending.kind === "model_reply" && (sentImages.length || deliveredText.length)) {
      await Promise.resolve(callbacks.onReplyDelivered?.({
        conversationId: pending.chatId, senderId: pending.senderId,
        reply: deliveredText.join("\n\n") || "[图片已发送，文字投递未完成]",
        images: sentImages, deliveryId: pending.deliveryId, complete: false,
        ...(platformMessages.length ? { platformMessages } : {}),
      })).catch(() => undefined);
    }
    if (pending.kind === "model_reply" && !sentImages.length && !deliveredText.length) {
      await Promise.resolve(callbacks.onReplyDeliveryFailed?.({
        conversationId: pending.chatId, senderId: pending.senderId,
        reply: pending.text, deliveryId: pending.deliveryId,
      })).catch(() => undefined);
    }
    console.error("[telegram] reply delivery failed or is uncertain; not retrying to avoid duplicate messages:",
      error instanceof Error ? error.message : error);
  }
}

/** Compatibility boundary for pre-union durable channel state. */
export function normalizePendingReply(value: TelegramPendingReply | ({ chatId: string; senderId: string; reply: string } & Omit<InboundReply, "text">)): TelegramPendingReply {
  if ("kind" in value) return value;
  const outcome = normalizeInboundReply({ ...value, text: value.reply });
  if (!outcome || outcome.kind === "retry" || outcome.kind === "pause") throw new Error("Invalid prepared reply.");
  return { ...outcome, chatId: value.chatId, senderId: value.senderId };
}

/** Both ordinary and proactive/transient paths use the same ordered fallback rule.
 * A false voice result is a definite failure. Rejection is uncertain and stops the
 * sequence; no earlier fragment is replayed and no paid attempt is repeated.
 */
export async function deliverReplySegments(segments: readonly ReplySegment[],
  text: (text: string) => Promise<void>,
  voice: (segment: Extract<ReplySegment, {kind: "voice"}>, index: number) => Promise<boolean>): Promise<void> {
  for (const [index, segment] of segments.entries()) {
    if (segment.kind !== "voice" || !await voice(segment, index)) await text(segment.text);
  }
}
