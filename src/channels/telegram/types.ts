import type { RuntimeImage } from "../../runtime/types.js";
import type { Attachment, InboundMessage, PlatformMessageFragment, TelegramNativeReply } from "../types.js";
import type { MediaStore } from "../../media/store.js";
import type { ReplyOutcome } from "../reply.js";
export interface TelegramPhoto { file_id: string; file_size?: number; width?: number; height?: number }
export interface TelegramFile { file_id: string; file_name?: string; mime_type?: string; file_size?: number; duration?: number; thumbnail?: TelegramPhoto }
export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  from?: { id: number | string; is_bot?: boolean };
  chat: { id: number | string; type: string };
  reply_to_message?: TelegramMessage;
  sticker?: TelegramFile & { is_animated?: boolean; is_video?: boolean; emoji?: string; set_name?: string; thumbnail?: TelegramPhoto };
  animation?: TelegramFile & { thumbnail?: TelegramPhoto };
  photo?: TelegramPhoto[];
  document?: TelegramFile;
  audio?: TelegramFile;
  voice?: TelegramFile;
  video?: TelegramFile;
}
export interface TelegramUpdate { update_id: number; message?: TelegramMessage; callback_query?: { id: string; from: { id: string | number }; message?: TelegramMessage; data?: string } }

export interface TelegramBufferedPart {
  messageId: string;
  text: string;
  receivedAt: string;
  attachments: Attachment[];
  replyTo?: InboundMessage["replyTo"];
  /** One actual incoming platform message, retained across debounce and restart. */
  platformMessage?: PlatformMessageFragment;
}

export interface TelegramBufferedBatch {
  chatId: string;
  senderId: string;
  lastReceivedAtMs: number;
  parts: TelegramBufferedPart[];
  retryAtMs?: number;
  retryAttempts?: number;
  /** Durable circuit breaker: wait for a new owner message or /retry. */
  retryPaused?: boolean;
  /** Quota and non-transient model failures wait for explicit /retry. */
  pauseReason?: "subscription_usage_limit" | "model_failure";
}

export type TelegramPendingReply = Exclude<ReplyOutcome, { kind: "retry" | "pause" }> & {
  chatId: string;
  senderId: string;
};

export interface TelegramCommandReplyDeletion {
  chatId: string;
  messageIds: number[];
  expiresAtMs: number;
  deleteBeforeMs?: number;
}

export interface TelegramState {
  offset: number;
  pauseNotices?: Array<{ chatId: string; messageId: number }>;
  commandReplyDeletions?: TelegramCommandReplyDeletion[];
  lastChatId?: string;
  buffer?: TelegramBufferedBatch;
  queuedBuffers?: TelegramBufferedBatch[];
  inFlight?: TelegramBufferedBatch;
  pendingReply?: TelegramPendingReply;
}

export interface TelegramApiClient {
  call<T>(method: string, body: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<T>;
  getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }>;
  downloadFile(filePath: string, maxBytes: number): Promise<Uint8Array>;
}

export interface TelegramAdapterConfig {
  temporaryReply?: (message:InboundMessage, session:import("../../runtime/types.js").TemporaryConversation)=>Promise<import("../reply.js").ReplyOutcome>;
  token: string;
  ownerId: string;
  stickerIds?: string[];
  dataDir: string;
  mediaStore: MediaStore;
  maxMediaBytes?: number;
  commands?: ReadonlyArray<{ command: string; description: string }>;
  api?: TelegramApiClient;
  onPollingConflict?: () => void;
  inputDebounceMs?: number;
  getInputDebounceMs?: () => number;
  conversationQueue?: import("../../util/serial-queue.js").SerialQueue;
  onCallback?: (query: NonNullable<TelegramUpdate["callback_query"]>, api: TelegramApiClient) => Promise<boolean>;
  showStageDirections?: () => Promise<boolean>;
  sendProactiveVoice?: (api: TelegramApiClient, target: string, text: string, instruction?:string, deliveryId?:string) => Promise<boolean>;
  sendVoice?: (api: TelegramApiClient, target: string, text: string, deliveryId: string, reply?: TelegramNativeReply, onSent?: (id: number) => void, instruction?:string, preview?:boolean) => Promise<boolean>;
  /** Separate transient speech path: never writes a regular voice job or transcript. */
  typingRefreshMs?: number;
  commandReplyAutoDeleteMs?: number;
  onPanel?: (command: string, message: InboundMessage) => Promise<import("./panels.js").PanelView | undefined>;
  onReplyDelivered?: (event: { conversationId: string; senderId: string; reply: string; images?: RuntimeImage[]; deliveryId?: string; complete?: boolean; platformMessages?: PlatformMessageFragment[] }) => Promise<void> | void;
  onReplyDeliveryFailed?: (event: { conversationId: string; senderId: string; reply: string; deliveryId?: string }) => Promise<void> | void;
  onProactiveDelivered?: TelegramAdapterConfig["onReplyDelivered"];
}
