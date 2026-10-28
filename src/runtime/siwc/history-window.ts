import type { ChatMessage, RuntimeHistory } from "../types.js";
import { estimatedTextTokens } from "../token-estimate.js";
import { readHistoryMessages } from "../history.js";

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
  /** Complete recovery snapshots do not truncate to a locally estimated capacity. */
  truncated: false;
  startSeq: number;
}

/**
 * Replay complete SQLite messages from a verified covered-sequence cursor.
 * Preserve the complete checkpoint delta or cold-start transcript. Token estimates
 * are diagnostic only; model capacity is enforced by the provider.
 */
export async function readRecoveryHistoryWindow(history: RuntimeHistory, startSeq = 0): Promise<RecoveryHistoryWindow> {
  if (!Number.isSafeInteger(startSeq) || startSeq < 0 || startSeq > history.count) {
    throw new Error("Invalid SIWC checkpoint coverage cursor; refusing an unsafe replay.");
  }
  const messages = (await readHistoryMessages(history, startSeq)).filter(message => message.role !== "developer");
  const estimatedTokens = messages.reduce((sum, message) => sum + messageTokens(message), 0);
  return { messages, estimatedTokens, totalMessages: history.count,
    expanded: startSeq > 0, truncated: false, startSeq };
}
