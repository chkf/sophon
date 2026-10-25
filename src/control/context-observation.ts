import type { DatabaseSync } from "node:sqlite";
import type { RuntimeTraceObserver, TraceStepFinish, TraceStepStart, TraceUsage } from "../observability/types.js";
import type { ChatResponse, ProviderId } from "../runtime/types.js";
import { getState, mainPath, openDatabase, putState, schemaVersion } from "../state/database.js";

const KEY = "diagnostic/control/context-observation";
const usageKeys = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens", "costUsd"] as const;

export interface ContextObservation {
  version: 1;
  scope: "last_model_call";
  at: string;
  startedAt: string;
  durationMs: number;
  provider: ProviderId | null;
  model: string | null;
  status: "completed" | "failed";
  usage: TraceUsage | null;
  contextEffect: "none" | "history_windowed" | "checkpoint_compacted" | null;
  compaction: { id: string; at: string; reason: "capacity" | "seven_days"; coveredThroughSeq: number; model: string } | null;
}

function safeUsage(input: unknown): TraceUsage | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>, value: TraceUsage = {};
  for (const key of usageKeys) {
    const item = source[key];
    if (typeof item === "number" && Number.isFinite(item) && item >= 0 && (key === "costUsd" || Number.isSafeInteger(item))) value[key] = item;
  }
  return Object.keys(value).length ? value : null;
}
function safeModel(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}
function instant(value: unknown): value is string { return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)); }
function compaction(input: unknown): ContextObservation["compaction"] {
  if (!input || typeof input !== "object") return null;
  const cp = input as Record<string, unknown>, model = safeModel(cp.model);
  if (typeof cp.id !== "string" || !/^[a-f0-9]{64}$/.test(cp.id) || !instant(cp.at) ||
    !["capacity", "seven_days"].includes(cp.reason as string) || !Number.isSafeInteger(cp.coveredThroughSeq) ||
    (cp.coveredThroughSeq as number) < 0 || !model) return null;
  return { id: cp.id, at: cp.at, reason: cp.reason as "capacity" | "seven_days", coveredThroughSeq: cp.coveredThroughSeq as number, model };
}

/** Records only the last actual model attempt. It never inspects prompt, output, tools or opaque reasoning fields. */
export class ContextObservationCollector implements RuntimeTraceObserver {
  readonly captureContent = false;
  private sequence = 0;
  private latest?: { id: string; startedAt: string; startedMs: number; provider: ProviderId | null; model: string | null;
    finishedAt?: string; durationMs?: number; status?: "completed" | "failed"; usage?: TraceUsage | null };
  constructor(private readonly clock: () => Date = () => new Date()) {}
  start(event: TraceStepStart): string | undefined {
    if (event.kind !== "model") return undefined;
    const now = this.clock(), id = "context-observation-" + (++this.sequence);
    this.latest = { id, startedAt: now.toISOString(), startedMs: now.getTime(),
      provider: ["api", "openrouter", "siwc"].includes(event.provider ?? "") ? event.provider as ProviderId : null,
      model: safeModel(event.model) };
    return id;
  }
  finish(id: string | undefined, event: TraceStepFinish): void {
    if (!id || id !== this.latest?.id || event.status === "skipped") return;
    const now = this.clock();
    this.latest.finishedAt = now.toISOString();
    this.latest.durationMs = Math.max(0, now.getTime() - this.latest.startedMs);
    this.latest.status = event.status;
    this.latest.model = safeModel(event.model) ?? this.latest.model;
    this.latest.usage = safeUsage(event.usage);
  }
  completed(response: Pick<ChatResponse, "contextEffect" | "compaction">): ContextObservation | null {
    const last = this.latest;
    if (!last?.finishedAt || !last.status) return null;
    return { version: 1, scope: "last_model_call", at: last.finishedAt, startedAt: last.startedAt,
      durationMs: last.durationMs ?? 0, provider: last.provider, model: last.model, status: last.status,
      usage: last.usage ?? null,
      contextEffect: ["none", "history_windowed", "checkpoint_compacted"].includes(response.contextEffect ?? "") ? response.contextEffect! : null,
      compaction: compaction(response.compaction) };
  }
}

/** SQLite already belongs to Gateway; this adds one diagnostic row and no history or new schema. */
export function persistContextObservation(rootDir: string, observation: ContextObservation): void {
  const db = openDatabase(mainPath(rootDir));
  try {
    if (schemaVersion(db) !== 2) throw new Error("Context observation requires the existing six-table database.");
    // Read through the same allowlist before persisting, even for internal callers.
    const safe = normalize(observation);
    if (!safe) throw new Error("Invalid context observation metadata.");
    putState(db, { key: KEY, category: "diagnostic", value: JSON.stringify(safe), updatedAt: safe.at });
  } finally { db.close(); }
}

function normalize(input: unknown): ContextObservation | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1 || raw.scope !== "last_model_call" || !instant(raw.at) || !instant(raw.startedAt) ||
    !["completed", "failed"].includes(raw.status as string) || typeof raw.durationMs !== "number" ||
    !Number.isFinite(raw.durationMs) || raw.durationMs < 0) return null;
  return { version: 1, scope: "last_model_call", at: raw.at, startedAt: raw.startedAt, durationMs: raw.durationMs,
    provider: ["api", "openrouter", "siwc"].includes(raw.provider as string) ? raw.provider as ProviderId : null,
    model: safeModel(raw.model), status: raw.status as "completed" | "failed", usage: safeUsage(raw.usage),
    contextEffect: ["none", "history_windowed", "checkpoint_compacted"].includes(raw.contextEffect as string) ? raw.contextEffect as ContextObservation["contextEffect"] : null,
    compaction: compaction(raw.compaction) };
}

export function readContextObservation(db: DatabaseSync): ContextObservation | null {
  const row = getState(db, KEY);
  if (!row || row.category !== "diagnostic" || row.encoding !== "json" || row.value.length > 16_384) return null;
  try { return normalize(JSON.parse(row.value)); } catch { return null; }
}
