import { dateKey } from "../util/clock-window.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { mainPath, openDatabase, putState, schemaVersion, transaction } from "../state/database.js";
import type { RuntimeTraceObserver, TaskTraceKind, TaskTraceRun, TaskTraceStatus, TaskTraceSummary, TraceStepFinish, TraceStepStart, TraceUsage } from "./types.js";

const MAX_STEPS = 80;
const MAX_RUN_BYTES = 128 * 1024;
const MAX_PAYLOAD_BYTES = 12 * 1024;
const ID = /^tr_\d{13}_[a-f0-9-]{36}$/;
const sensitiveKey = /^(?:authorization|proxy.authorization|cookie|set.cookie|api.?key|access.?token|refresh.?token|id.?token|client.?secret|secret|password|credentials|encrypted_content|ciphertext|reasoning|reasoning_content|reasoning_details|accessToken|refreshToken|initData)$/i;
const usageFields = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens", "costUsd"] as const;

export interface TaskTraceOptions { secrets?: string[]; maxRuns?: number; retentionDays?: number; scope?: "tasks" | "calls"; todayOnly?: boolean; timezone?: string }
export interface TaskTraceStart { kind: TaskTraceKind; trigger: string; channel?: string; at?: Date }
export interface TaskTraceFinish { status: Exclude<TaskTraceStatus, "running">; reason?: string }

/** Credential removal and bounded snapshots happen before SQLite receives any text. */
export function sanitizeTrace(value: unknown, secrets: string[] = []): { value: unknown; truncated: boolean } {
  let truncated = false;
  const seen = new WeakSet<object>();
  const text = (s: string): string => {
    let result = s;
    for (const secret of secrets) if (secret.length >= 4) result = result.split(secret).join("[redacted]");
    result = result
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted]")
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[=:]\s*)[^\s&,;]+/gi, "$1[redacted]")
      .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g, "[binary omitted]");
    if (result.length > 6000) { truncated = true; result = result.slice(0, 6000) + "\n[truncated]"; }
    return result;
  };
  const walk = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") return text(item);
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (typeof item !== "object") return item === undefined ? undefined : text(String(item));
    if (depth > 6 || seen.has(item)) { truncated = true; return "[truncated]"; }
    seen.add(item);
    if (Array.isArray(item)) { if (item.length > 40) truncated = true; return item.slice(0, 40).map(v => walk(v, depth + 1)); }
    const entries = Object.entries(item); if (entries.length > 40) truncated = true;
    return Object.fromEntries(entries.slice(0, 40).map(([key, val]) => [text(key), sensitiveKey.test(key) ? "[redacted]" : walk(val, depth + 1)]));
  };
  let result = walk(value, 0);
  const encoded = JSON.stringify(result);
  if (encoded && Buffer.byteLength(encoded) > MAX_PAYLOAD_BYTES) {
    truncated = true; result = { preview: encoded.slice(0, 3500), truncated: true };
  }
  return { value: result, truncated };
}
export function reportedUsage(value: TraceUsage | undefined): TraceUsage | undefined {
  if (!value) return undefined;
  const out: TraceUsage = {};
  for (const key of usageFields) if (typeof value[key] === "number" && Number.isFinite(value[key]) && value[key]! >= 0) out[key] = value[key];
  return Object.keys(out).length ? out : undefined;
}
function summarize(run: TaskTraceRun): TaskTraceSummary {
  const { steps: _steps, ...summary } = run;
  const models = run.steps.filter(step => step.kind === "model");
  return { ...summary, modelStepCount:models.length, usageReportedModelSteps:models.filter(step=>step.usage).length,
    usageCompleteFields:models.length && !run.droppedSteps ? usageFields.filter(field=>models.every(step=>step.usage?.[field] !== undefined)) : [],
    durationMs: run.finishedAt ? run.durationMs : Math.max(0, Date.now() - Date.parse(run.startedAt)) };
}

export class TaskTraceStore {
  private readonly prefix: string;
  private readonly db: DatabaseSync;
  private readonly secrets: string[];
  private readonly maxRuns: number;
  private readonly retentionDays: number;
  private closed = false;
  constructor(rootDir: string, private readonly options: TaskTraceOptions = {}) {
    this.prefix = options.scope === "calls" ? "observability/calls/" : "observability/tasks/";
    if (!existsSync(mainPath(rootDir))) throw new Error("任务轨迹需要已初始化的主数据库。");
    this.db = openDatabase(mainPath(rootDir));
    if (schemaVersion(this.db) !== 2) { this.db.close(); throw new Error("任务轨迹需要当前主数据库格式。"); }
    this.secrets = (options.secrets ?? []).filter(Boolean);
    this.maxRuns = Math.max(10, Math.min(1000, options.maxRuns ?? 200));
    this.retentionDays = Math.max(1, Math.min(30, options.retentionDays ?? 7));
  }
  /** Call only after the service owns the instance lock and the old owner has stopped. */
  recoverInterrupted(): void {
    if (this.closed) return;
    transaction(this.db, () => {
      for (const row of this.db.prepare("SELECT value FROM gateway_state WHERE key GLOB ?").all(this.prefix + "*") as {value:string}[]) {
        let run: TaskTraceRun; try { run = JSON.parse(row.value); } catch { continue; }
        if (run.status !== "running") continue;
        const deliveryStarted = run.steps.some(step => step.kind === "delivery" && step.status === "running");
        const at = new Date().toISOString();
        for (const step of run.steps) if (step.status === "running") { step.status = "interrupted"; step.finishedAt = at; step.durationMs = Math.max(0, Date.parse(at) - Date.parse(step.startedAt)); }
        run.status = deliveryStarted ? "delivery_unknown" : "interrupted";
        run.reason = "process_interrupted"; run.finishedAt = at; run.durationMs = Math.max(0, Date.parse(at) - Date.parse(run.startedAt));
        this.save(run);
      }
      this.prune();
    });
  }
  private save(run: TaskTraceRun): void {
    if (this.closed) return;
    if (Buffer.byteLength(JSON.stringify(run)) > MAX_RUN_BYTES) {
      run.truncated = true;
      // Preserve timing/outcome for every retained span; discard oldest payloads first.
      for (const step of run.steps) {
        delete step.input; delete step.output; step.truncated = true;
        if (Buffer.byteLength(JSON.stringify(run)) <= MAX_RUN_BYTES) break;
      }
    }
    putState(this.db, {key: this.prefix + run.id, category:"diagnostic", value:JSON.stringify(run)});
  }
  retentionDay(): string | null {
    return this.options.todayOnly && this.options.scope !== "calls" ? dateKey(new Date(Date.now()), this.options.timezone ?? "UTC") : null;
  }
  private prune(): void {
    if (this.options.todayOnly && this.options.scope !== "calls") {
      const timezone = this.options.timezone ?? "UTC", today = this.retentionDay();
      for (const row of this.db.prepare("SELECT key,value FROM gateway_state WHERE key GLOB ?").all(this.prefix + "*") as {key:string;value:string}[]) {
        const run = JSON.parse(row.value) as TaskTraceRun;
        if (dateKey(new Date(run.startedAt), timezone) !== today) this.db.prepare("DELETE FROM gateway_state WHERE key=?").run(row.key);
      }
    }
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    this.db.prepare("DELETE FROM gateway_state WHERE key GLOB ? AND key < ?").run(this.prefix + "*", this.prefix + "tr_" + String(cutoff).padStart(13,"0") + "_");
    this.db.prepare("DELETE FROM gateway_state WHERE key IN (SELECT key FROM gateway_state WHERE key GLOB ? ORDER BY key DESC LIMIT -1 OFFSET ?)").run(this.prefix + "*", this.maxRuns);
  }
  begin(input: TaskTraceStart): string {
    const at = (input.at ?? new Date()).toISOString();
    // Identity uses recording time; supplied event time remains the observed trigger timestamp.
    const id = "tr_" + String(Date.now()).padStart(13,"0") + "_" + randomUUID();
    this.save({id,kind:input.kind,trigger:this.cleanText(input.trigger,120),startedAt:at,durationMs:0,status:"running",stepCount:0,steps:[],...(input.channel ? {channel:this.cleanText(input.channel,32)} : {})});
    this.prune(); return id;
  }
  private cleanText(value: string, limit: number): string {
    // Metadata is always text, even when a multi-byte payload exceeds the generic byte budget.
    const clean = sanitizeTrace(value, this.secrets).value;
    return (typeof clean === "string" ? clean : (clean && typeof clean === "object" && "preview" in clean ? String(clean.preview) : "[truncated]")).slice(0,limit);
  }
  get(id: string): TaskTraceRun | undefined {
    if (this.closed || !ID.test(id)) return undefined;
    if (this.options.todayOnly) this.prune();
    const row = this.db.prepare("SELECT value FROM gateway_state WHERE key=? AND category='diagnostic' AND encoding='json'").get(this.prefix + id) as {value:string}|undefined;
    if (!row) return undefined;
    const run = JSON.parse(row.value) as TaskTraceRun;
    return { ...run, ...summarize(run), steps:run.steps.map(step=>({...step,durationMs:step.finishedAt ? step.durationMs : Math.max(0,Date.now()-Date.parse(step.startedAt))})) };
  }
  list(options: {limit?:number;before?:string} = {}): { runs: TaskTraceSummary[]; nextBefore: string | null } {
    this.prune();
    const limit = Number.isInteger(options.limit) ? Math.max(1, Math.min(100, options.limit!)) : 30;
    if (options.before && !ID.test(options.before)) throw new Error("无效的任务游标。");
    const rows = this.db.prepare("SELECT value FROM gateway_state WHERE key GLOB ? AND key < ? ORDER BY key DESC LIMIT ?")
      .all(this.prefix + "*", options.before ? this.prefix + options.before : this.prefix + "~", limit + 1) as {value:string}[];
    const runs = rows.slice(0,limit).map(row => summarize(JSON.parse(row.value)));
    return {runs,nextBefore:rows.length > limit ? runs.at(-1)!.id : null};
  }
  start(runId: string, event: TraceStepStart): string | undefined {
    const run = this.get(runId); if (!run || run.status !== "running") return undefined;
    if (run.steps.length >= MAX_STEPS) { run.droppedSteps = (run.droppedSteps ?? 0) + 1; run.truncated = true; this.save(run); return undefined; }
    const id = randomUUID(), input = sanitizeTrace(event.input, this.secrets);
    const step = {kind:event.kind, name:this.cleanText(event.name,160), id,
      ...(event.parentId ? {parentId:this.cleanText(event.parentId,80)} : {}),
      ...(event.provider ? {provider:this.cleanText(event.provider,64)} : {}),
      ...(event.model ? {model:this.cleanText(event.model,200)} : {}),
      ...(event.context ? {context:event.context.slice(0,32).map(item=>({source:this.cleanText(item.source,80),delivery:item.delivery,
        ...(item.detail ? {detail:this.cleanText(item.detail,240)} : {})}))} : {}),
      startedAt:new Date().toISOString(), durationMs:0, status:"running" as const, input:input.value, ...(input.truncated ? {truncated:true} : {}) };
    run.steps.push(step); run.stepCount = run.steps.length; this.save(run); return id;
  }
  finishStep(runId: string, id: string | undefined, event: TraceStepFinish): void {
    if (!id) return;
    const run = this.get(runId), step = run?.steps.find(item => item.id === id);
    if (!run || !step || step.status !== "running") return;
    const output = sanitizeTrace(event.output, this.secrets), usage = reportedUsage(event.usage);
    Object.assign(step, {status:event.status,finishedAt:new Date().toISOString(),durationMs:Math.max(0,Date.now()-Date.parse(step.startedAt)),output:output.value,
      ...(event.error ? {error:this.cleanText(event.error,512)} : {}), ...(event.model ? {model:this.cleanText(event.model,200)} : {}), ...(usage ? {usage} : {}), ...(output.truncated ? {truncated:true} : {})});
    if (step.kind === "model" && usage) {
      run.usage ??= {};
      for (const key of usageFields) if (usage[key] !== undefined) run.usage[key] = (run.usage[key] ?? 0) + usage[key]!;
    }
    this.save(run);
  }
  finish(runId: string, result: TaskTraceFinish): void {
    const run = this.get(runId); if (!run || run.status !== "running") return;
    run.status = result.status; run.finishedAt = new Date().toISOString(); run.durationMs = Math.max(0,Date.now()-Date.parse(run.startedAt));
    for (const step of run.steps) if (step.status === "running") {
      step.status = "interrupted"; step.finishedAt = run.finishedAt; step.durationMs = Math.max(0,Date.parse(run.finishedAt)-Date.parse(step.startedAt));
    }
    if (result.reason) run.reason = this.cleanText(result.reason,512);
    this.save(run);
  }
  observer(runId: string, parentId?: string): RuntimeTraceObserver {
    return {start:event => this.start(runId, {...event,parentId:event.parentId ?? parentId}),finish:(id,event) => this.finishStep(runId,id,event)};
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
