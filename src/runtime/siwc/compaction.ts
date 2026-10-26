import { createHash } from "node:crypto";
import type { CompactionCheckpoint, CompactionReason } from "./stateful-types.js";

export const SIWC_AUTO_COMPACT_TOKENS = 120_000;
export const SIWC_SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/** The public Responses context_management API requires >= 1000. */
export const SIWC_WEEKLY_COMPACT_TOKENS = 1_000;

export function sevenDayCompactionDue(startedAt: string | undefined, lastCompactedAt: string | undefined,
  now = Date.now()): boolean {
  const anchor = Date.parse(lastCompactedAt ?? startedAt ?? "");
  return Number.isFinite(anchor) && now >= anchor + SIWC_SEVEN_DAYS_MS;
}

export function checkpointFromItems(sessionId: string, model: string, items: Record<string, unknown>[],
  coveredThroughSeq: number, reason: CompactionReason, at: string): CompactionCheckpoint {
  const latest = [...items].reverse().find(item => item.type === "compaction" &&
    typeof item.encrypted_content === "string" && item.encrypted_content.length > 0);
  if (!latest || !Number.isSafeInteger(coveredThroughSeq) || coveredThroughSeq < 0) {
    throw new Error("No valid SIWC compaction checkpoint to persist.");
  }
  const sha256 = createHash("sha256").update(JSON.stringify(latest)).digest("hex");
  // The encrypted payload is opaque and is not guaranteed to be unique across
  // distinct successful compaction events. The event ID must also bind its
  // confirmed time and coverage so that a future compaction gets a new notice.
  const id = createHash("sha256").update(JSON.stringify([sessionId, model, sha256, coveredThroughSeq, at])).digest("hex");
  return { version: 1, id, sessionId, model, at, coveredThroughSeq, replayFromSeq: coveredThroughSeq, sha256, reason };
}
