import type { ChatMessage, RuntimeHistory } from "../types.js";
import { estimatedTextTokens } from "../context-budget.js";

/** Safety cap for a cold start WITHOUT a usable checkpoint, not a normal chat horizon. */
export const SIWC_COLD_RECOVERY_SAFE_TOKENS = 100_000;
const READ_BATCH = 256;
const MESSAGE_OVERHEAD_TOKENS = 48;
const MEDIA_RESERVE_TOKENS = 4096;

export function messageTokens(message: ChatMessage): number {
  return estimatedTextTokens(message.content) + MESSAGE_OVERHEAD_TOKENS +
    (message.attachments?.length ?? 0) * MEDIA_RESERVE_TOKENS;
}

export interface RecoveryHistoryWindow {
  messages: ChatMessage[];
  estimatedTokens: number;
  totalMessages: number;
  /** True when the requested sequence begins after the first SQLite message. */
  expanded: boolean;
  /** True only when a checkpoint-free emergency fallback lost older context. */
  truncated: boolean;
  startSeq: number;
}

/**
 * Replay complete SQLite messages from a verified covered-sequence cursor.
 * No fixed 3-day expiry, 16/24K window or 48K context reset. If a checkpoint
 * is absent and the complete conversation exceeds the cold-start safety
 * budget, retain a declared suffix. With a checkpoint, never silently omit
 * part of its delta: fail closed instead.
 */
export async function readRecoveryHistoryWindow(history: RuntimeHistory, startSeq = 0): Promise<RecoveryHistoryWindow> {
  if (!Number.isSafeInteger(startSeq) || startSeq < 0 || startSeq > history.count) {
    throw new Error("Invalid SIWC checkpoint coverage cursor; refusing an unsafe replay.");
  }
  const messages: ChatMessage[] = [];
  let estimatedTokens = 0;
  let truncated = false;
  for (let offset = startSeq; offset < history.count; offset += READ_BATCH) {
    const length = Math.min(READ_BATCH, history.count - offset);
    const batch = await history.readRange(offset, length);
    if (batch.length !== length) throw new Error("SQLite history changed during a recovery snapshot.");
    for (const message of batch) {
      if (message.role === "developer") continue;
      const cost = messageTokens(message);
      if (cost > SIWC_COLD_RECOVERY_SAFE_TOKENS) {
        throw new Error("Single SQLite message exceeds the SIWC safe cold-recovery budget.");
      }
      if (startSeq > 0 && estimatedTokens + cost > SIWC_COLD_RECOVERY_SAFE_TOKENS) {
        throw new Error("SIWC checkpoint delta exceeds safe capacity; preserving the checkpoint and SQLite history for recovery.");
      }
      messages.push(message);
      estimatedTokens += cost;
      while (estimatedTokens > SIWC_COLD_RECOVERY_SAFE_TOKENS) {
        estimatedTokens -= messageTokens(messages.shift()!);
        truncated = true;
      }
    }
  }
  // A cold-start suffix cannot begin with an orphan assistant reply.
  if (truncated) while (messages.length && messages[0]!.role === "assistant" &&
    messages[0]!.origin !== "proactive" && messages.some(item => item.role === "user")) {
    estimatedTokens -= messageTokens(messages.shift()!);
  }
  return { messages, estimatedTokens, totalMessages: history.count,
    expanded: startSeq > 0, truncated, startSeq };
}
