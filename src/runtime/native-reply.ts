import type { InboundMessage, PlatformMessageFragment, TelegramNativeReply } from "../channels/types.js";
import type { ChatMessage, RuntimeHistory, RuntimeTool } from "./types.js";
import type { SessionMessage } from "../sessions/types.js";

export const RETIRED_TEXT_QUOTE_TOOL = "gateway_quote_message";
export const NATIVE_REPLY_TOOL = "gateway_reply_native";
/** No WeChat bot outbound quote contract. Telegram is opt-in on a per-reply basis only. */
export const NATIVE_REPLY_GUIDANCE = "需要引用 Telegram 当前聊天中的某条消息时，使用 gateway_reply_native，不必每轮调用。准确定位当前或历史消息，不跨渠道引用、不伪造平台 ID；每轮最多一个目标。工具只登记引用意图，实际发送由 Gateway 完成，不使用旧文字引用模板。";
export const NATIVE_REPLY_DEFINITION: RuntimeTool = {
  name: NATIVE_REPLY_TOOL,
  readOnly: true,
  description: "为本轮 Telegram 回复选择一个当前 TG 私聊中的真实消息作为原生回复目标。target=current 选用户本轮消息；target=history 选已保存的 TG 用户或 Gateway 回复，先用 gateway_read_history 找到 index。合批或分段用 fragment_index 精确选一条。quote 可选，必须为该条文字的原样子串，最长 1024 UTF-16 字符。此工具只登记意图，不发消息；不支持微信、跨聊天、旧的无平台 ID 记录。",
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", enum: ["current", "history"] },
      index: { type: "integer", minimum: 0 },
      fragment_index: { type: "integer", minimum: 0 },
      quote: { type: "string", minLength: 1, maxLength: 1024 },
    },
    required: ["target"],
    additionalProperties: false,
  },
};

/** Prefix is Telegram's own numeric bot identity. Never persist the secret token. */
export function telegramAccountId(token: string): string | undefined {
  const match = /^(\d{1,20}):[^\s:]+$/.exec(token);
  return match ? "telegram-bot:" + match[1] : undefined;
}
export function safeTelegramMessageId(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
export function nativeReplyParameters(reply: TelegramNativeReply | undefined, target: string, accountId: string | undefined):
  { message_id: number; quote?: string; allow_sending_without_reply: true } | undefined {
  if (!reply || !accountId || reply.channel !== "telegram" || reply.chatId !== target ||
      reply.accountId !== accountId || !Number.isSafeInteger(reply.messageId) || reply.messageId <= 0 ||
      (reply.quote !== undefined && (typeof reply.quote !== "string" || !reply.quote.length || reply.quote.length > 1024))) return undefined;
  return { message_id: reply.messageId, ...(reply.quote ? { quote: reply.quote } : {}), allow_sending_without_reply: true };
}
function exactIndex(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) throw new Error(name + " 必须是非负安全整数。");
  return value;
}
type HistoryMessage = ChatMessage & Pick<SessionMessage, "source">;
export class NativeReplyTurn {
  private readonly count: number;
  private readonly accountId?: string;
  private selection?: TelegramNativeReply;
  constructor(private readonly history: RuntimeHistory, private readonly inbound: InboundMessage) {
    this.count = history.count;
    const fragments = inbound.platformMessages;
    if (inbound.channel === "telegram" && inbound.senderId === inbound.conversationId &&
      fragments?.length && /^telegram-bot:[1-9][0-9]*$/.test(fragments[0]!.accountId) && fragments.every(f =>
      f.accountId === fragments[0]!.accountId && f.conversationId === inbound.conversationId && f.direction === "inbound")) {
      this.accountId = fragments[0]!.accountId;
    }
  }
  get enabled(): boolean { return Boolean(this.accountId); }
  get prepared(): TelegramNativeReply | undefined { return this.selection; }

  async select(args: Record<string, unknown>): Promise<unknown> {
    if (!this.accountId) throw new Error("当前渠道不支持原生引用目标选择。");
    if (!args || Array.isArray(args) || Object.keys(args).some(k => !["target", "index", "fragment_index", "quote"].includes(k)))
      throw new Error("原生引用参数无效，不能提供平台 ID 或其他聊天信息。");
    if (args.target !== "current" && args.target !== "history") throw new Error("必须选择 current 或 history。");
    if (args.target === "current" && args.index !== undefined) throw new Error("当前消息不能提供历史索引。");
    const index = args.target === "history" ? exactIndex(args.index, "index") : undefined;
    const fragmentIndex = args.fragment_index === undefined ? undefined : exactIndex(args.fragment_index, "fragment_index");
    const quote = args.quote;
    if (quote !== undefined && (typeof quote !== "string" || !quote.length || !quote.trim() || quote.length > 1024))
      throw new Error("quote 必须是 1–1024 字符的连续原文。");
    let fragments: PlatformMessageFragment[];
    let role: "user" | "assistant" = "user";
    if (index === undefined) fragments = this.inbound.platformMessages ?? [];
    else {
      if (index >= this.count) throw new Error("历史索引超出本轮授权范围。");
      const message = (await this.history.readRange(index, 1))[0] as HistoryMessage | undefined;
      if (!message || (message.role !== "user" && message.role !== "assistant") ||
          message.source?.channel !== "telegram" ||
          (message.source.senderId !== undefined && message.source.senderId !== this.inbound.senderId))
        throw new Error("历史条目不是本 TG 会话中的双方消息。");
      role = message.role;
      fragments = message.source?.platformMessages ?? [];
    }
    if (!fragments.length || fragments.length > 1000 || fragments.some(f => !f ||
        f.accountId !== this.accountId || f.conversationId !== this.inbound.conversationId ||
        f.direction !== (role === "user" ? "inbound" : "outbound") ||
        (f.messageId !== undefined && safeTelegramMessageId(f.messageId) === undefined) ||
        typeof f.text !== "string")) throw new Error("引用目标缺少可靠的本 TG 私聊消息映射。");
    if (fragmentIndex === undefined && fragments.length !== 1)
      return { status: "ambiguous", message: "该轮含多条 TG 消息，请指定 fragment_index。", candidates: fragments.slice(0, 5).map((f,i) => ({ fragment_index: i, preview: f.text.slice(0, 80) })), total: fragments.length };
    if (fragmentIndex !== undefined && fragmentIndex >= fragments.length) throw new Error("片段索引超出当前消息范围。");
    const fragment = fragments[fragmentIndex ?? 0]!;
    const id = safeTelegramMessageId(fragment.messageId);
    if (id === undefined) throw new Error("该条 TG 消息没有已确认的平台 ID，无法建立原生引用。");
    if (quote !== undefined && !fragment.text.includes(quote as string)) throw new Error("quote 必须逐字来自选中的 TG 消息正文。");
    if (quote !== undefined && fragment.text.split(quote as string).length !== 2) throw new Error("引用片段出现多次，请选择唯一的连续原文。");
    const chosen: TelegramNativeReply = { channel: "telegram", chatId: this.inbound.conversationId,
      accountId: this.accountId, messageId: id, ...(quote ? { quote: quote as string } : {}) };
    if (this.selection) {
      if (JSON.stringify(this.selection) !== JSON.stringify(chosen)) throw new Error("本轮只能选择一个原生引用目标。");
      return { status: "selected", role, reused: true };
    }
    this.selection = chosen;
    return { status: "selected", role, target: args.target, fragment_index: fragmentIndex ?? 0, note: "已登记原生回复目标；发送前不承诺已送达。" };
  }
}

/** Only fresh model output is cleaned; old delivery journals and transcripts are unchanged. */
export function stripLegacyQuoteTokens(text: string): string {
  if (!text.includes("[[gateway_quote:")) return text;
  const clean = text.replace(/\[\[gateway_quote:[^\r\n]*?(?:\]\]|(?=\r?\n|$))/g, "").trim();
  return clean || "原生引用暂不可用，我会直接回答你的问题。";
}
