import type { ChannelName, PlatformMessageFragment } from "../channels/types.js";
import type { RuntimeAttachment, RuntimeImage } from "../runtime/types.js";
import { isProactiveMessage } from "../runtime/message-provenance.js";

export interface SessionMessage {
  id?: string;
  source?: { channel?: ChannelName; senderId?:string; messageId?:string; voice?:boolean; platformMessages?:PlatformMessageFragment[] };
  origin?: "chat" | "proactive";
  partial?: boolean;
  generatedImages?: RuntimeImage[];
  role: "user" | "assistant";
  content: string;
  at: string;
  attachments?: RuntimeAttachment[];
}
export interface SessionMetadata {
  channel: ChannelName;
  conversationId: string;
  senderId: string;
  updatedAt: string;
}
export interface SessionRecord extends SessionMetadata { messages: SessionMessage[] }
export interface ReplyState { lastReply?: number; unansweredUsers?: number }
export function applyReplyState(state: ReplyState, message: SessionMessage, sequence: number): void {
  if (message.role === "user") state.unansweredUsers = (state.unansweredUsers ?? 0) + 1;
  else if (!isProactiveMessage(message) && !message.partial) { state.lastReply = sequence; state.unansweredUsers = 0; }
}
export function replyState(messages: SessionMessage[]): ReplyState {
  const state: ReplyState = { unansweredUsers: 0 };
  messages.forEach((message, sequence) => applyReplyState(state, message, sequence));
  return state;
}
export interface SessionAppendResult extends SessionMetadata { count: number; committed: SessionMessage[] }
export function normalizeSessionMessage(message: SessionMessage): SessionMessage {
  const { generatedImages, ...record } = message;
  return record.attachments !== undefined || !generatedImages ? record : { ...record, attachments: generatedImages };
}
export function validateMessage(value: SessionMessage): SessionMessage {
  if (value) value = normalizeSessionMessage(value);
  if (!value || !["user", "assistant"].includes(value.role) || typeof value.content !== "string" ||
    (value.origin !== undefined && !["chat", "proactive"].includes(value.origin)) || (value.partial !== undefined && typeof value.partial !== "boolean") ||
    typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) || (value.id !== undefined && (typeof value.id !== "string" || !value.id)) ||
    (value.source !== undefined && (!value.source || (value.source.channel!==undefined && !["telegram", "wechat"].includes(value.source.channel)) ||
      (value.source.senderId!==undefined&&(typeof value.source.senderId !== "string" || !value.source.senderId)) || (value.source.messageId!==undefined&&typeof value.source.messageId !== "string") ||
      (value.source.voice !== undefined && typeof value.source.voice !== "boolean") ||
      (value.source.platformMessages!==undefined && (!Array.isArray(value.source.platformMessages)||value.source.platformMessages.length>1000||value.source.platformMessages.some(item=>!item||
        typeof item.accountId!=="string"||!item.accountId||typeof item.conversationId!=="string"||!item.conversationId||(item.messageId!==undefined&&(typeof item.messageId!=="string"||!item.messageId))||typeof item.text!=="string"||
        item.direction!==(value.role==="user"?"inbound":"outbound")||item.attachments!==undefined&&!Array.isArray(item.attachments)||item.references!==undefined&&!Array.isArray(item.references)))))) ||
    (value.attachments !== undefined && (!Array.isArray(value.attachments) || value.attachments.some(a => !a || !["image", "file"].includes(a.kind) || typeof a.path !== "string" || !a.path)))) {
    throw new Error("Invalid session message; retained source was not modified.");
  }
  return normalizeSessionMessage(value);
}
