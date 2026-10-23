import OpenAI from "openai";
import { createHash } from "node:crypto";
import type { CompactionCheckpoint, CompactionReason } from "./stateful-types.js";

export const SIWC_AUTO_COMPACT_TOKENS = 120_000;
export const SIWC_SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/** The public Responses context_management API requires >= 1000. */
export const SIWC_WEEKLY_COMPACT_TOKENS = 1_000;

export type StandaloneCompactor = (accessToken: string, model: string,
  items: Record<string, unknown>[]) => Promise<Record<string, unknown>[]>;

/** Uses the already-selected SIWC credential, never an OpenRouter/API-key fallback.
 * A subscription account may reject this endpoint: callers must catch errors
 * and use verified in-response server-side compaction instead. */
export const standaloneCompact: StandaloneCompactor = async (accessToken, model, items) => {
  // Node's built-in test runner spawns tests with NODE_TEST_CONTEXT. Synthetic
  // fixtures must never turn a 7-day clock into a live authenticated request.
  if (process.env.NODE_TEST_CONTEXT) {
    throw new Error("Standalone SIWC network compaction is forbidden in synthetic tests.");
  }
  const client = new OpenAI({ apiKey: accessToken, maxRetries: 0 });
  const response = await client.responses.compact({ model, input: items as never });
  const result = response.output as unknown as Record<string, unknown>[];
  if (!Array.isArray(result) || !result.some(item => item?.type === "compaction" &&
      typeof item.encrypted_content === "string" && item.encrypted_content.length > 0)) {
    throw new Error("Standalone SIWC compact returned no verified encrypted compaction item.");
  }
  // The standalone response is the canonical window; do not prune other items.
  return result;
};

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
  return { version: 1, id, sessionId, model, at, coveredThroughSeq, sha256, reason };
}
