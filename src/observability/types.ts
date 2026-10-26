import type { ChatUsage } from "../runtime/types.js";

export type TraceUsage = Partial<ChatUsage>;
export type TaskTraceKind = "chat" | "heartbeat_plan" | "heartbeat_decision" | "heartbeat_delivery" | "heartbeat_check";
export type TaskTraceStatus = "running" | "completed" | "silent" | "skipped" | "failed" | "delivered" | "delivery_unknown" | "interrupted";
export interface TraceStepStart {
  kind: "model" | "tool" | "condition" | "delivery" | "system" | "context";
  name: string;
  parentId?: string;
  provider?: string;
  model?: string;
  input?: unknown;
  context?: ContextInjection[];
}
export interface TraceStepFinish {
  status: "completed" | "failed" | "skipped";
  output?: unknown;
  error?: string;
  usage?: TraceUsage;
  model?: string;
}
export interface RuntimeTraceObserver {
  /** Metadata-only observers never receive prompt, tool or reply content. */
  readonly captureContent?: boolean;
  start(event: TraceStepStart): string | undefined;
  finish(id: string | undefined, event: TraceStepFinish): void;
}
export interface TaskTraceStep extends TraceStepStart {
  id: string;
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  status: "running" | "completed" | "failed" | "skipped" | "interrupted";
  output?: unknown;
  error?: string;
  usage?: TraceUsage;
  truncated?: boolean;
}
export interface TaskTraceSummary {
  id: string;
  kind: TaskTraceKind;
  trigger: string;
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  status: TaskTraceStatus;
  reason?: string;
  channel?: string;
  usage?: TraceUsage;
  /** Aggregate includes only fields actually reported by each model attempt. */
  modelStepCount?: number;
  usageReportedModelSteps?: number;
  usageCompleteFields?: Array<keyof ChatUsage>;
  stepCount: number;
  droppedSteps?: number;
  truncated?: boolean;
}
export interface TaskTraceRun extends TaskTraceSummary { steps: TaskTraceStep[] }

export interface ContextSource { id:string; label:string; placement:"policy"|"turn"; content:string }
export interface ContextInjection { source:string; delivery:"sent"|"inherited"|"replayed"|"omitted"; detail?:string }
