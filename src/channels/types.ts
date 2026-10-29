import type { ReplySegment } from "../runtime/reply-segments.js";
import type { RuntimeImage } from "../runtime/types.js";
import type { ReplyOutcome } from "./reply.js";
export type ChannelName = "telegram" | "wechat";
export type AttachmentKind = "image" | "document" | "audio" | "voice" | "video";

/** Model selects only a verified Telegram message in this same private chat.
 * The transport independently checks chat/account before constructing the wire request.
 * IDs are real Telegram Bot API IDs, never database, batch or Gateway delivery IDs.
 */
export interface TelegramNativeReply {
  channel: "telegram";
  chatId: string;
  accountId: string;
  messageId: number;
  quote?: string;
}

export interface TelegramSticker {
  fileId: string; accountId: string; chatId: string;
  emoji?: string; setName?: string; format: "static" | "animated" | "video" | "gif" | "gif_document" | "mp4_document" | "image";
}

export interface Attachment {
  sticker?: TelegramSticker;
  kind: AttachmentKind;
  fileName?: string;
  mimeType?: string;
  size?: number;
  localPath?: string;
  textPreview?: string;
  remoteId?: string;
  sourceMessageId?: string;
  durationSeconds?: number;
  error?: string;
  transcription?: string;
  transcriptionSource?: "platform" | "asr";
}

export interface InboundMessageReference {
  messageId: string;
  sender: "user" | "assistant" | "unknown";
  text?: string;
  attachments?: Attachment[];
  unavailableReason?: string;
  partial?: boolean;
}

/** Platform IDs belong to one bot and peer; never substitute a Gateway delivery/batch ID. */
export interface PlatformMessageFragment {
  accountId: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  messageId?: string;
  text: string;
  attachments?: Attachment[];
  references?: InboundMessageReference[];
}

export interface InboundMessage {
  channel: ChannelName;
  conversationId: string;
  senderId: string;
  messageId: string;
  text: string;
  receivedAt: string;
  attachments: Attachment[];
  replyTo?: InboundMessageReference;
  platformMessages?: PlatformMessageFragment[];
}

export interface InboundReply {
  replySegments?: ReplySegment[];
  text: string;
  images?: RuntimeImage[];
  deliveryId?: string;
  commitAssistant?: boolean;
  /** Keep the inbound message durable and retry model processing after this delay. */
  retryAfterMs?: number;
}

export type InboundHandler = (message: InboundMessage) => Promise<string | InboundReply | ReplyOutcome | undefined>;

/** The caller reserves an at-most-once attempt before asking the transport to send. */
export interface ProactiveDelivery { replySegments?: ReplySegment[]; deliveryId:string; at:string; /** Agent-selected prosody only; never a voice ID. */ voiceInstruction?:string }

export interface ProactiveSender {
  channel: ChannelName;
  availableTarget(): Promise<string | undefined>;
  sendText(target: string, text: string): Promise<void | PlatformMessageFragment[]>;
  sendProactiveText?(target: string, text: string, voiceText?: string, delivery?: ProactiveDelivery): Promise<void | PlatformMessageFragment[]>;
  sendImages?(target: string, images: RuntimeImage[], deliveryId: string): Promise<void>;
  availableStickers?(): number;
  sendSticker?(target: string, index: number): Promise<void>;
}
