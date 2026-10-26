import type { ChatMessage, ChatRequest } from "./types.js";

/** Check inputs before provider discovery, paid journals or tool execution. */
export function requestMessages(request: ChatRequest): ChatMessage[] {
  if (!["chat", "heartbeat_plan", "heartbeat_decision", "recent_review", "media_exploration", "diagnostic", "memory_classify"].includes(request.purpose)) {
    throw new Error("请求用途无效。");
  }
  if (request.text !== undefined && (typeof request.text !== "string" || !request.text.trim())) throw new Error("请求正文为空。");
  if (request.messages !== undefined && (!Array.isArray(request.messages) || !request.messages.length ||
    request.messages.some(m => !m || !["user", "assistant", "developer"].includes(m.role) || typeof m.content !== "string" || !m.content.trim()))) {
    throw new Error("请求消息为空或无效。");
  }
  const messages = request.messages ?? (request.text ? [{ role: "user" as const, content: request.text }] : []);
  if (!messages.length) throw new Error("请求必须包含正文或消息。");
  return messages;
}

export function isBackground(request: ChatRequest): boolean {
  return request.purpose === "heartbeat_plan" || request.purpose === "heartbeat_decision" ||
    request.purpose === "recent_review" || request.purpose === "memory_classify" || request.purpose === "media_exploration";
}
