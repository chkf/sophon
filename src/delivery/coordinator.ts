import type { InboundMessage, PlatformMessageFragment } from "../channels/types.js";
import type { ChatRuntime, RuntimeImage } from "../runtime/types.js";
import type { SessionStore } from "../sessions/store.js";
/** Persist an acknowledged assistant delivery without touching provider-specific session settlement. */
export async function recordDeliveredAssistant(
  sessions: SessionStore,
  channel: InboundMessage["channel"],
  conversationId: string,
  senderId: string,
  reply: string,
  images?: RuntimeImage[],
  deliveryId?: string,
  at = new Date().toISOString(),
  delivery: { origin: "chat" | "proactive"; partial?: boolean } = { origin: "proactive" },
  platformMessages?: PlatformMessageFragment[],
): Promise<void> {
  const content = reply.trim() || (images?.length ? "[已生成图片]" : "");
  if (!content) return;
  await sessions.append(channel, conversationId, senderId, [{
    role: "assistant", content, at, ...delivery,
    source: { channel, senderId, messageId: deliveryId ?? "", ...(platformMessages?.length ? { platformMessages } : {}) },
    ...(images?.length ? { attachments: images } : {}),
    ...(deliveryId ? { id: deliveryId + ":assistant" } : {}),
  }]);
}
/** Channel acknowledgements own transcript/runtime settlement; generation never implies delivery. */
export class DeliveryCoordinator {
  constructor(private readonly runtime: ChatRuntime, private readonly sessions: SessionStore) {}
  async commitDeliveredAssistant(
    channel: InboundMessage["channel"],
    conversationId: string,
    senderId: string,
    reply: string,
    images?: RuntimeImage[],
    deliveryId?: string,
    complete = true,
    platformMessages?: PlatformMessageFragment[],
  ): Promise<void> {
    const text = reply.trim() || (images?.length ? "[已生成图片]" : "");
    if (!text) return;
    if (this.runtime.settleSessionDelivery) {
      if (!deliveryId) return;
      await this.runtime.settleSessionDelivery((this.sessions.sessionKey?.(channel, conversationId) ?? channel + ":" + conversationId), deliveryId, complete ? text : undefined,
        () => recordDeliveredAssistant(this.sessions, channel, conversationId, senderId, text, images, deliveryId, undefined, { origin: "chat", partial: !complete }, platformMessages),
        { durableReceipt: channel === "wechat" && this.sessions.supportsDurableIlinkDelivery?.() === true });
      return;
    }
    try {
      await recordDeliveredAssistant(this.sessions, channel, conversationId, senderId,
        text, images, deliveryId, undefined, { origin: "chat", partial: !complete }, platformMessages);
    } finally {
      // Delivery already succeeded. A transcript disk failure must not leave the
      // runtime waiting forever for an acknowledgement or discard a sent reply.
      if (complete) await this.runtime.commitSession?.((this.sessions.sessionKey?.(channel, conversationId) ?? channel + ":" + conversationId), text, deliveryId);
      else await this.runtime.resetSession?.((this.sessions.sessionKey?.(channel, conversationId) ?? channel + ":" + conversationId), deliveryId);
    }
  }

  async discardUndeliveredAssistant(
    channel: InboundMessage["channel"],
    conversationId: string,
    deliveryId?: string,
  ): Promise<void> {
    await this.runtime.resetSession?.((this.sessions.sessionKey?.(channel, conversationId) ?? channel + ":" + conversationId), deliveryId);
  }
}
