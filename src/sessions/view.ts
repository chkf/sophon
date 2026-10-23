import type { ChannelName } from "../channels/types.js";
import type { SessionStore, SessionView, SessionMessage } from "./store.js";
import { replyState } from "./types.js";
import { historyFromMessages } from "../runtime/history.js";

/** Compatibility for callers implementing the former get-only storage interface. */
export async function readSessionView(store: SessionStore, channel: ChannelName, conversationId: string): Promise<SessionView & { eagerMessages?: SessionMessage[] }> {
  if (typeof store.view === "function") return store.view(channel, conversationId);
  const messages = (await store.get(channel, conversationId))?.messages ?? [];
  const lastAssistantIndex = messages.map(m => m.role).lastIndexOf("assistant");
  const replies = replyState(messages);
  return { tail: messages.slice(-6), lastUser: [...messages].reverse().find(m => m.role === "user"),
    lastAssistant: messages[lastAssistantIndex], unansweredCount: replies.unansweredUsers ?? 0,
    unansweredStart: (replies.lastReply ?? -1) + 1, eagerMessages: messages, history: historyFromMessages(messages),
  };
}
