import type { ReplySegment } from "./reply-segments.js";
import type { TelegramNativeReply } from "../channels/types.js";
export type ProviderId = "siwc" | "openrouter" | "api";

export interface RuntimeImage extends RuntimeAttachment {
  kind: "image";
  size: number;
  width: number;
  height: number;
  sha256: string;
  prompt: string;
  model: string;
}

export interface ChatMessage {
  id?: string;
  at?: string;
  origin?: "chat" | "proactive";
  partial?: boolean;
  role: "user" | "assistant" | "developer";
  content: string;
  attachments?: RuntimeAttachment[];
}

export interface RuntimeHistory {
  count: number;
  readTail(limit: number): Promise<ChatMessage[]>;
  readRange(offset: number, limit: number): Promise<ChatMessage[]>;
  search(query: string, offset: number, limit: number, before?: number, dates?: { from?: string; to?: string }): Promise<{ total: number; entries: RuntimeHistoryEntry[]; nextOffset: number | null }>;
}

export interface RuntimeHistoryEntry {
  index: number;
  role: "user" | "assistant";
  content: string;
  id?: string;
  at?: string;
}

export interface RuntimeAttachment {
  kind: "image" | "file";
  path: string;
  fileName?: string;
  mimeType?: string;
}

export interface RuntimeTool {
  /** Local, unpaid, turn-scoped intent only; safe to discard and select again. */
  replaySafe?: boolean;
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  readOnly?: boolean;
}

export interface StatefulRuntimeContext {
  controlRevision: string;
  contextRevision: string;
  content: string;
}

export interface ChatUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface ImageGenerationRequest {
  operationId: string;
  prompt: string;
  autonomous: boolean;
  reference?: RuntimeAttachment;
}

export interface ImageSettings {
  route: "provider" | "openrouter";
  proactive: boolean;
  model?: string;
  preset?: string;
  dailyLimit: number;
}

export type RequestPurpose = "chat" | "heartbeat_plan" | "heartbeat_decision" | "recent_review" | "media_exploration" | "diagnostic" | "memory_classify";
export type ChatInput = { text: string; messages?: ChatMessage[] } | { text?: string; messages: ChatMessage[] };
export type ChatRequest = ChatInput & {
  /** Optional local observability; never serialized to providers. */
  trace?: import("../observability/types.js").RuntimeTraceObserver;
  contextSources?: Array<Omit<import("../observability/types.js").ContextSource, "content">>;
  purpose: RequestPurpose;
  memory?: MemoryRuntimeContext;
  memoryTask?: import("../memory/tasks.js").MemoryTask;
  deliveryId?: string;
  history?: RuntimeHistory;
  sessionId: string;
  operationId?: string;
  allowImageGeneration?: boolean;
  /** The channel can deliver real images; does not itself authorize paid generation. */
  imageOutputAllowed?: boolean;
  instructions?: string;
  turnInstructions?: string;
  /** Reset temporary Telegram reply-format requests when a new chat socket starts. */
  resetVoicePreferenceOnReconnect?: boolean;
  /** IANA timezone for trusted per-message timestamps in the SIWC conversation chain. */
  timezone?: string;
  stateful?: boolean;
  /** Skip all provider conversation checkpoint writes for an in-memory test turn. */
  ephemeral?: boolean;
  /** Normal tools in a nonpersistent conversation, distinct from diagnostic tests. */
  temporaryMode?: boolean;
  /** Ephemeral-only transport route. Never changes persistent provider or model settings. */
  testProvider?: ProviderId;
  testModel?: string;
  /** Maximum approximate tokens for model-visible historic text in ephemeral OpenRouter calls. */
  testHistoryTokens?: number;
  /** Local, non-serialized spending gate; expires on sandbox exit or selection changes. */
  testAuthorized?: () => boolean;
  deferAssistantCommit?: boolean;
  context?: StatefulRuntimeContext;
  attachments?: RuntimeAttachment[];
  tools?: RuntimeTool[];
  executeTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Local per-turn getter; only validated, actually selected speech counts as output. */
  recordReplyText?: (text: string, id: string) => void;
  getPreparedReplySegments?: () => ReplySegment[];
  getPreparedVoice?: () => string | undefined;
  /** Optional natural-language delivery instruction; fixed user voice never changes. */
  getPreparedVoiceInstruction?: () => string | undefined;
  /** A verified native TG target chosen in this turn; returned only as metadata. */
  getPreparedSticker?: () => import("../channels/types.js").TelegramSticker | undefined;
  getPreparedNativeReply?: () => TelegramNativeReply | undefined;
  /** Local, non-serialized final text renderer; completed replies are persisted after rendering. */
  finalizeReplyText?: (text: string) => string;
  maxToolRounds?: number;
}

export interface ChatResponse {
  replySegments?: ReplySegment[];
  voiceText?: string;
  voiceInstruction?: string;
  sticker?: import("../channels/types.js").TelegramSticker;
  nativeReply?: TelegramNativeReply;
  deliveryId?: string;
  skipped?: "background_disabled";
  text: string;
  model?: string;
  usage?: ChatUsage;
  /** Legacy SIWC signal; prefer contextEffect for new implementations. */
  compacted?: boolean;
  /** Confirmed SIWC opaque checkpoint; never a simulated summary or a paid-provider result. */
  compaction?: import("./siwc/stateful-types.js").CompactionCheckpoint;
  contextEffect?: "none" | "history_windowed" | "checkpoint_compacted";
  images?: RuntimeImage[];
}

export interface RuntimeSession {
  status: "disconnected" | "connecting" | "connected" | "reauth_required";
  sharing: boolean;
  profileId?: string;
  profileLabel?: string;
  identity?: { name?: string; email?: string };
  error?: { code: string; message: string; retryable: boolean };
}

export interface RuntimeModel {
  id: string;
  displayName: string;
}

export interface RuntimeModelSelection {
  mode: "auto" | "pinned";
  model?: string;
  resolvedModel?: string;
}

export interface DeliverySettlementOptions {
  /** The channel retains a durable acknowledgement and can retry its recording after restart. */
  durableReceipt?: boolean;
}

export interface ChatRuntime {
  /** Separately selected model on an independent SIWC lane; never routes through paid providers. */
  classifyMemory?(input: string): Promise<string>;
  runMemoryTask?(task: import("../memory/tasks.js").MemoryTask, input: string): Promise<string>;
  listMemoryModels?(): Promise<RuntimeModel[]>;
  getMemoryModel?(): Promise<string>;
  selectMemoryModel?(model: string): Promise<string>;
  reply(request: ChatRequest): Promise<ChatResponse>;
  /** Local due check, then tool-free maintenance of the selected formal SIWC lane. */
  maintainContext?(request: ContextMaintenanceRequest): Promise<{ compacted: boolean; rebuilt?: boolean; skipped?: string }>;
  commitSession?(sessionId: string, deliveredText: string, deliveryId?: string): Promise<void | boolean>;
  editHistory?(sessionId: string, work: () => Promise<void>): Promise<void>;
  resetSession?(sessionId: string, deliveryId?: string): Promise<void | boolean>;
  /** Validate, record and settle under the same provider ticket queue. */
  settleSessionDelivery?(sessionId: string, deliveryId: string, text: string | undefined, record: () => Promise<void>, options?: DeliverySettlementOptions): Promise<boolean>;
  /** Release active transport resources for one-shot CLI runtimes. */
  close?(): Promise<void> | void;
}

export interface MemoryRuntimeContext { ready?:boolean; revision:number; content:string; refresh?:()=>MemoryRuntimeContext }
export interface ContextMaintenanceRequest {
  memory?: MemoryRuntimeContext;
  sessionId: string;
  history: RuntimeHistory;
  timezone: string;
}

export interface RuntimeAuth {
  signIn(options?: { reconsent?: boolean }): Promise<RuntimeSession>;
  getSession(): Promise<RuntimeSession>;
}
export interface ModelCatalog {
  listModels(): Promise<RuntimeModel[]>;
  getModelSelection(): Promise<RuntimeModelSelection>;
  selectModel(model?: string, expectedProvider?: ProviderId): Promise<RuntimeModelSelection>;
}
export interface ProviderControl {
  getProvider(): Promise<ProviderId>;
  providerStatus(): Promise<Array<{ provider: ProviderId; available: boolean }>>;
  selectProvider(provider: ProviderId): Promise<void>;
  validateTestModel?(model: string, provider?: ProviderId): Promise<{ model: string; supportsTools: boolean }>;
}
export interface UsageReader {
  getUsage(): Promise<{ supported: boolean; source?: string; costUsd?: number; limitRemainingUsd?: number }>;
}
export interface ImageControl {
  getImageSettings(): Promise<ImageSettings>;
  selectImageRoute(route: "provider" | "openrouter"): Promise<ImageSettings>;
  canGenerateImage(autonomous: boolean): Promise<boolean>;
  generateImage(request: ImageGenerationRequest): Promise<ChatResponse>;
  selectImageModel(model: string): Promise<ImageSettings>;
  setProactiveImages(enabled: boolean): Promise<ImageSettings>;
}
/** Compatibility composition; consumers can request only the interfaces they use. */
export interface ManagedChatRuntime extends ChatRuntime, RuntimeAuth, ModelCatalog,
  Partial<ProviderControl>, Partial<ImageControl>, Partial<UsageReader> {
  diagnosticModels?(provider: ProviderId): Promise<RuntimeModel[]>;
  diagnosticReply?(provider: ProviderId, model: string, kind: "text" | "tools" | "vision" | "image"): Promise<string>;
}
export type CommandRuntime = ModelCatalog & Pick<ChatRuntime, "listMemoryModels" | "getMemoryModel" | "selectMemoryModel"> & Partial<ProviderControl> & Partial<ImageControl>;
export type ControlRuntime = ModelCatalog & Pick<RuntimeAuth, "getSession"> & Partial<ProviderControl> & Partial<UsageReader>;

/** Channel-owned RAM context; never serialize this object into channel state. */
export interface TemporaryConversation { id: string; messages: ChatMessage[]; pendingInput?: ChatMessage }
