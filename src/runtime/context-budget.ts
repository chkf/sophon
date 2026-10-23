import type { ChatMessage } from "./types.js";
/** UTF-8 heuristic, not a tokenizer or a hard claim about a model's window. */
export function estimatedTextTokens(text: string): number { return Math.ceil(Buffer.byteLength(text, "utf8") / 2); }
export const OPENROUTER_LIMITS = { historyChars: 24_000, historyMessages: 24, responseTokens: 4096,
  toolReserveTokens: 2000, imageEstimateTokens: 4096, toolRounds: 8, toolCalls: 16 } as const;
export function historyWindow(messages: ChatMessage[], contextTokens: number, instructions: string, schemas: unknown, imageCount: number, maxHistoryMessages: number = OPENROUTER_LIMITS.historyMessages): number {
  const fixed = estimatedTextTokens(instructions) + estimatedTextTokens(JSON.stringify(schemas)) +
    OPENROUTER_LIMITS.responseTokens + OPENROUTER_LIMITS.toolReserveTokens + imageCount * OPENROUTER_LIMITS.imageEstimateTokens;
  const budget = contextTokens - fixed;
  if (!Number.isFinite(budget) || budget <= 0) throw new Error("规则、工具与输出预留超过模型上下文预算，请选择更大上下文模型。");
  let start = messages.length; let chars = 0; let tokens = 0;
  while (start > 0 && messages.length - start < maxHistoryMessages) {
    const next = messages[start - 1]!;
    const size = estimatedTextTokens(next.content);
    if (chars + next.content.length > OPENROUTER_LIMITS.historyChars || tokens + size > budget) break;
    chars += next.content.length; tokens += size; start--;
  }
  if (start === messages.length) throw new Error("当前消息超过上下文预算，请缩短消息。");
  return start;
}

/** Estimate the actual next request, excluding binary data URLs from text accounting. */
export function assertRequestBudget(messages: unknown[], schemas: unknown, contextTokens: number): void {
  let images = 0;
  const text = JSON.stringify({ messages, schemas }, (key, value) => {
    if (key === "image_url") { images++; return "[image]"; }
    return value;
  });
  const estimate = estimatedTextTokens(text) + images * OPENROUTER_LIMITS.imageEstimateTokens + OPENROUTER_LIMITS.responseTokens;
  if (!Number.isFinite(contextTokens) || estimate > contextTokens) {
    throw new Error("本轮工具结果与对话超过模型上下文预算；请选择更大上下文模型。工具结果不会自动重放。");
  }
}
