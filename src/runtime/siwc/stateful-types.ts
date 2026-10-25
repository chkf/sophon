import type { ReplySegment } from "../reply-segments.js";
import type { ChatMessage, ChatUsage, RuntimeAttachment, RuntimeTool, StatefulRuntimeContext, RuntimeHistory } from "../types.js";
export interface FunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  namespace?: string;
  arguments: string;
}

export interface ResponseSnapshot {
  id: string;
  output?: Record<string, unknown>[];
  output_text?: string;
  usage?: Record<string, unknown>;
  streamedText?: string;
}

export interface SocketStreamMessage {
  type: string;
  message?: Record<string, unknown>;
  error?: Error;
  code?: number;
  reason?: string;
}

export interface StatefulResponsesSocket {
  send(event: Record<string, unknown>): void;
  stream(options?: { maxBufferedEvents?: number }): AsyncIterable<SocketStreamMessage>;
  close(): void;
  onClose(listener: () => void): void;
}

export type StatefulResponsesSocketFactory = (accessToken: string) => StatefulResponsesSocket;

export type CompactionReason = "seven_days" | "capacity";
export interface CompactionCheckpoint {
  version: 1;
  id: string;
  sessionId: string;
  model: string;
  at: string;
  coveredThroughSeq: number;
  sha256: string;
  reason: CompactionReason;
}

export interface PersistedLaneState {
  historyCursor?: number;
  attachmentCursor?: number;
  coverageVerified?: boolean;
  pendingDeliveryId?: string;
  pendingDeliveryItems?: Record<string, unknown>[];
  /** Generated response held outside canonical context until delivery receipt. */
  pendingPreparedItems?: Record<string, unknown>[];
  pendingPreparedCheckpoint?: CompactionCheckpoint;
  pendingPreparedLastCompactedAt?: string;
  pendingDeliveryCheckpoint?: CompactionCheckpoint;
  pendingDeliveryLastCompactedAt?: string;
  /** Legacy v1 recovery remains readable and migrates on its next safe save. */
  needsWindowRebase?: boolean;
  version: 1 | 2;
  model: string;
  sessionId?: string;
  startedAt?: string;
  lastCompactedAt?: string;
  checkpoint?: CompactionCheckpoint;
  controlRevision?: string;
  contextRevision?: string;
  contextItems: Record<string, unknown>[];
}

export interface LaneState {
  historyCursor?: number;
  attachmentCursor?: number;
  coverageVerified?: boolean;
  pendingDeliveryId?: string;
  needsWindowRebase?: boolean;
  startedAt?: string;
  lastCompactedAt?: string;
  checkpoint?: CompactionCheckpoint;
  sessionId: string;
  model: string;
  ephemeral?: boolean;
  socket?: StatefulResponsesSocket;
  socketToken?: string;
  previousResponseId?: string;
  controlRevision?: string;
  contextRevision?: string;
  contextItems: Record<string, unknown>[];
  needsBootstrap: boolean;
  pendingDeliveryItems?: Record<string, unknown>[];
  /** Legacy v1 pending reply did not persist its completed output. */
  pendingRecoveryWithoutPrepared?: boolean;
  pendingDeliveryCheckpoint?: CompactionCheckpoint;
  pendingDeliveryLastCompactedAt?: string;
}

export interface StatefulResponseOptions {
  webSearchAllowed?: boolean;
  trace?: import("../../observability/types.js").RuntimeTraceObserver;
  history?: RuntimeHistory;
  deliveryId?: string;
  accessToken: string;
  model: string;
  sessionId: string;
  messages: ChatMessage[];
  ephemeral?: boolean;
  deferAssistantCommit?: boolean;
  instructions?: string;
  turnInstructions?: string;
  resetVoicePreferenceOnReconnect?: boolean;
  timezone?: string;
  context?: StatefulRuntimeContext;
  attachments?: RuntimeAttachment[];
  tools?: RuntimeTool[];
  executeTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  recordReplyText?: (text: string, id: string) => void;
  getPreparedReplySegments?: () => ReplySegment[];
  getPreparedVoice?: () => string | undefined;
  getPreparedVoiceInstruction?: () => string | undefined;
  getPreparedNativeReply?: () => import("../../channels/types.js").TelegramNativeReply | undefined;
  finalizeReplyText?: (text: string) => string;
  maxToolRounds?: number;
}

export interface StatefulResponseResult {
  replySegments?: ReplySegment[];
  voiceText?: string;
  voiceInstruction?: string;
  nativeReply?: import("../../channels/types.js").TelegramNativeReply;
  text: string;
  usage: ChatUsage;
  compacted: boolean;
  compaction?: CompactionCheckpoint;
}
