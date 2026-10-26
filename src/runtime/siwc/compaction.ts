import { createHash } from "node:crypto";
import type { CompactionCheckpoint, CompactionReason } from "./stateful-types.js";

/** Legacy checkpoint fixture/compatibility helper; no runtime compaction policy. */
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
