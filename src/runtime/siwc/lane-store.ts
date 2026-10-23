import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { readJsonFile, writeJsonAtomic, removeJson } from "../../util/atomic-json.js";
import { removeDocument } from "../../state/database.js";
import type { LaneState, PersistedLaneState } from "./stateful-types.js";
import { hasCompaction, hasUnresolvedToolEvidence } from "./responses-codec.js";
export class LaneStore {
  constructor(private readonly dataDir: string) {}
  path(sessionId: string): string { return join(this.dataDir, "runtime", "context", createHash("sha256").update(sessionId).digest("hex") + ".json"); }
  async read(sessionId: string): Promise<PersistedLaneState | undefined> {
    const state = await readJsonFile<PersistedLaneState | undefined>(this.path(sessionId), undefined);
    if (state && (![1, 2].includes(state.version) || typeof state.model !== "string" || !Array.isArray(state.contextItems) ||
      (state.historyCursor !== undefined && (!Number.isSafeInteger(state.historyCursor) || state.historyCursor < 0)) ||
      (state.attachmentCursor !== undefined && (!Number.isSafeInteger(state.attachmentCursor) || state.attachmentCursor < 0)) ||
      (state.coverageVerified !== undefined && typeof state.coverageVerified !== "boolean") ||
      (state.pendingDeliveryItems !== undefined && (!Array.isArray(state.pendingDeliveryItems) ||
        state.pendingDeliveryItems.some(item => !item || typeof item !== "object" || Array.isArray(item)))) ||
      (state.pendingPreparedItems !== undefined && (!Array.isArray(state.pendingPreparedItems) ||
        state.pendingPreparedItems.some(item => !item || typeof item !== "object" || Array.isArray(item)))) ||
      (state.needsWindowRebase !== undefined && typeof state.needsWindowRebase !== "boolean") ||
      state.contextItems.some(item => !item || typeof item !== "object" || Array.isArray(item)))) {
      throw new Error("Unsupported or invalid lane checkpoint; refusing unsafe recovery.");
    }
    if (state?.version === 2) {
      const cp = state.checkpoint;
      if (state.sessionId !== sessionId || (state.startedAt !== undefined && !Number.isFinite(Date.parse(state.startedAt))) ||
        (state.lastCompactedAt !== undefined && !Number.isFinite(Date.parse(state.lastCompactedAt))) ||
        (cp && (cp.version !== 1 || cp.sessionId !== sessionId || cp.model !== state.model ||
          !Number.isSafeInteger(cp.coveredThroughSeq) || cp.coveredThroughSeq < 0 ||
          !Number.isFinite(Date.parse(cp.at)) || !["seven_days", "capacity"].includes(cp.reason) ||
          !/^[a-f0-9]{64}$/.test(cp.id) || !/^[a-f0-9]{64}$/.test(cp.sha256) ||
          !hasCompaction(state.contextItems))) ||
        (cp && (state.lastCompactedAt !== cp.at ||
          (state.historyCursor !== undefined && state.historyCursor !== cp.coveredThroughSeq)))) {
        throw new Error("SIWC checkpoint metadata is invalid; refusing unsafe recovery.");
      }
      const latest = [...state.contextItems].reverse().find(item => item.type === "compaction");
      if (cp && createHash("sha256").update(JSON.stringify(latest)).digest("hex") !== cp.sha256) {
        throw new Error("SIWC compaction checkpoint checksum mismatch; preserve SQLite history and investigate.");
      }
      const prepared = state.pendingPreparedCheckpoint;
      const preparedItems = state.pendingPreparedItems;
      if ((prepared || preparedItems) && (!state.pendingDeliveryItems || !preparedItems)) {
        throw new Error("SIWC pending delivery checkpoint metadata is invalid.");
      }
      if (prepared) {
        const latestPrepared = [...preparedItems!].reverse().find(item => item.type === "compaction");
        if (prepared.sessionId !== sessionId || prepared.model !== state.model ||
          !latestPrepared || createHash("sha256").update(JSON.stringify(latestPrepared)).digest("hex") !== prepared.sha256) {
          throw new Error("SIWC pending prepared checkpoint checksum mismatch.");
        }
      }
    }
    return state;
  }
  write(sessionId: string, state: PersistedLaneState): Promise<void> { return writeJsonAtomic(this.path(sessionId), state); }
  remove(sessionId: string): Promise<void> { return removeJson(this.path(sessionId)); }
  /** Preserve the entire corrupt record byte-for-byte in schema-v2 gateway_state
   * (or the legacy file store) before a declared SQLite-only downgrade. Pending
   * delivery or unresolved tool evidence is never eligible for this fallback. */
  async quarantineRecoverable(sessionId: string, error: unknown): Promise<boolean> {
    if (!(error instanceof Error) || !(
      error instanceof SyntaxError || /(?:SIWC checkpoint metadata is invalid|SIWC (?:compaction )?checkpoint checksum mismatch)/i.test(error.message)
    )) return false;
    let raw: unknown;
    try { raw = await readJsonFile<unknown>(this.path(sessionId), undefined); }
    catch { return false; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const record = raw as Record<string, unknown>;
    if (!Array.isArray(record.contextItems) || record.contextItems.some(item =>
      !item || typeof item !== "object" || Array.isArray(item))) return false;
    if (record.pendingDeliveryId || record.pendingDeliveryItems || record.pendingPreparedItems ||
      hasUnresolvedToolEvidence(record.contextItems as Record<string, unknown>[])) return false;
    const identity = createHash("sha256").update(JSON.stringify([sessionId,
      record.model, "corrupt-recovery", new Date().toISOString()])).digest("hex");
    const relativeArchive = "runtime/context/" + identity + ".json";
    const archive = join(this.dataDir, relativeArchive);
    // Database archive+remove is one transaction, preserving the exact record.
    if (!removeDocument(this.path(sessionId), relativeArchive)) {
      await mkdir(dirname(archive), { recursive: true });
      await rename(this.path(sessionId), archive);
    }
    return true;
  }
  save(lane: LaneState): Promise<void> {
    // The canonical context must never contain an undelivered assistant reply.
    // Preserve the prepared response separately so a genuine receipt after a
    // process restart can still promote its opaque tool/media evidence.
    const canonicalItems = lane.pendingDeliveryItems ?? lane.contextItems;
    const canonicalCheckpoint = lane.pendingDeliveryItems ? lane.pendingDeliveryCheckpoint : lane.checkpoint;
    const canonicalCompactedAt = lane.pendingDeliveryItems
      ? lane.pendingDeliveryLastCompactedAt : lane.lastCompactedAt;
    return this.write(lane.sessionId, { version: 2, sessionId: lane.sessionId, model: lane.model,
      controlRevision: lane.controlRevision,
      ...(lane.historyCursor !== undefined ? { historyCursor: lane.historyCursor } : {}),
      ...(lane.attachmentCursor !== undefined ? { attachmentCursor: lane.attachmentCursor } : {}),
      ...(lane.coverageVerified === false ? { coverageVerified: false } : {}),
      ...(lane.pendingDeliveryId ? { pendingDeliveryId: lane.pendingDeliveryId } : {}),
      ...(lane.pendingDeliveryItems ? { pendingDeliveryItems: lane.pendingDeliveryItems } : {}),
      ...(lane.pendingDeliveryItems ? { pendingPreparedItems: lane.contextItems } : {}),
      ...(lane.pendingDeliveryItems && lane.checkpoint ? { pendingPreparedCheckpoint: lane.checkpoint } : {}),
      ...(lane.pendingDeliveryItems && lane.lastCompactedAt ? { pendingPreparedLastCompactedAt: lane.lastCompactedAt } : {}),
      ...(lane.pendingDeliveryCheckpoint ? { pendingDeliveryCheckpoint: lane.pendingDeliveryCheckpoint } : {}),
      ...(lane.pendingDeliveryLastCompactedAt ? { pendingDeliveryLastCompactedAt: lane.pendingDeliveryLastCompactedAt } : {}),
      ...(lane.startedAt ? { startedAt: lane.startedAt } : {}),
      ...(canonicalCompactedAt ? { lastCompactedAt: canonicalCompactedAt } : {}),
      ...(canonicalCheckpoint && hasCompaction(canonicalItems)
        ? { checkpoint: { ...canonicalCheckpoint, coveredThroughSeq: lane.historyCursor ?? canonicalCheckpoint.coveredThroughSeq } } : {}),
      contextRevision: lane.contextRevision, contextItems: canonicalItems });
  }
  /** Preserve an incompatible opaque checkpoint before a model/Core transition. */
  async archive(sessionId: string, state: PersistedLaneState, reason: string): Promise<void> {
    if (!state.contextItems.length) return;
    const identity = createHash("sha256").update(JSON.stringify([sessionId, state.model,
      state.checkpoint?.id ?? state.controlRevision ?? "", reason])).digest("hex");
    const path = join(this.dataDir, "runtime", "context", identity + ".json");
    const existing = await readJsonFile<PersistedLaneState | undefined>(path, undefined);
    if (!existing) await writeJsonAtomic(path, state);
  }
}
