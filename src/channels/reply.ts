import type { ReplySegment } from "../runtime/reply-segments.js";
import type { InboundReply, TelegramNativeReply } from "./types.js";
import { randomUUID } from "node:crypto";
export function normalizeInboundReply(value: string | InboundReply | ReplyOutcome | undefined): ReplyOutcome | undefined {
  if (typeof value === "string") return { kind: "local_reply", text: value };
  if (value && "kind" in value) return value;
  return value ? replyOutcome(value) : undefined;
}

/** Canonical internal outcome; legacy handler objects are normalized at the boundary. */
export type ReplyOutcome =
  | { kind: "retry"; retryAfterMs: number }
  | { kind: "pause"; reason: "subscription_usage_limit" | "model_failure" }
  | { kind: "local_reply"; text: string }
  | { kind: "model_reply"; text: string; replySegments?: ReplySegment[]; images?: InboundReply["images"]; voiceRequested?: boolean; voiceText?: string; voiceInstruction?: string; nativeReply?: TelegramNativeReply; deliveryId: string };
export function replyOutcome(value: InboundReply): ReplyOutcome {
  if (value.retryAfterMs !== undefined) {
    if (value.text || value.images?.length || value.commitAssistant) throw new Error("Retry cannot contain a prepared reply.");
    if (!Number.isFinite(value.retryAfterMs) || value.retryAfterMs < 0) throw new Error("Invalid retry delay.");
    return { kind: "retry", retryAfterMs: value.retryAfterMs };
  }
  return value.commitAssistant ? { kind: "model_reply", text: value.text, replySegments: value.replySegments, images: value.images, deliveryId: value.deliveryId ?? randomUUID() }
    : { kind: "local_reply", text: value.text };
}
