import type { ChatMessage } from "./types.js";

export function isProactiveMessage(message: Pick<ChatMessage, "role" | "origin" | "id">): boolean {
  if (message.role !== "assistant") return false;
  if (message.origin !== undefined) return message.origin === "proactive";
  // Older Gateway versions persisted a deterministic heartbeat delivery ID.
  // Recover only that proven origin; arbitrary legacy assistant text stays legacy.
  const timestamp = /^heartbeat:(.+):(?:text|sticker|image):assistant$/.exec(message.id ?? "")?.[1];
  return timestamp !== undefined && /^\d{4}-\d{2}-\d{2}T/.test(timestamp) && Number.isFinite(Date.parse(timestamp));
}
