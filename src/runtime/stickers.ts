import type { InboundMessage, TelegramSticker, PlatformMessageFragment } from "../channels/types.js";
import type { RuntimeHistory, RuntimeTool } from "./types.js";
import type { SessionMessage } from "../sessions/types.js";

export function validSticker(value: TelegramSticker | undefined, chatId: string, accountId?: string): value is TelegramSticker {
  return Boolean(value && accountId && /^telegram-bot:[1-9][0-9]*$/.test(accountId) &&
    value.accountId === accountId && value.chatId === chatId &&
    typeof value.fileId === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value.fileId) &&
    ["static", "animated", "video"].includes(value.format));
}
export const STICKER_TOOL: RuntimeTool = {
  name: "gateway_sticker", readOnly: true, replaySafe: true,
  description: "查找或选择本 TG 私聊收到过的表情包。list 返回当前消息与最近 50 条历史中的贴纸；可用 history_index 查指定历史条目。select 用返回的 key 登记本轮一个贴纸，由 Gateway 实际发送，不在工具调用时发消息。每轮先 list 再 select；不接受自造 ID。",
  parameters: { type: "object", properties: {
    action: { type: "string", enum: ["list", "select"] },
    history_index: { type: "integer", minimum: 0 }, key: { type: "string" },
  }, required: ["action"], additionalProperties: false },
};
export class StickerTurn {
  private readonly catalog = new Map<string, TelegramSticker>();
  private readonly count: number;
  private selection?: TelegramSticker;
  constructor(private readonly history: RuntimeHistory, private readonly inbound: InboundMessage) { this.count = history.count; }
  get prepared(): TelegramSticker | undefined { return this.selection; }
  async execute(args: Record<string, unknown>): Promise<unknown> {
    const account = this.inbound.platformMessages?.[0]?.accountId;
    if (this.inbound.channel !== "telegram" || this.inbound.senderId !== this.inbound.conversationId || !account)
      throw new Error("贴纸工具仅支持当前 Telegram 私聊。");
    if (!args || Object.keys(args).some(k => !["action", "history_index", "key"].includes(k))) throw new Error("贴纸参数无效。");
    if (args.action === "select") {
      if (args.history_index !== undefined || typeof args.key !== "string") throw new Error("请选择 list 返回的 key。");
      const chosen = this.catalog.get(args.key);
      if (!validSticker(chosen, this.inbound.conversationId, account)) throw new Error("请先 list，再选择真实贴纸。");
      if (this.selection && this.selection.fileId !== chosen.fileId) throw new Error("每轮只能选择一个贴纸。");
      this.selection = chosen;
      return { status: "selected", note: "已登记贴纸；实际送达由 Gateway 确认。" };
    }
    if (args.action !== "list" || args.key !== undefined) throw new Error("请选择 list 或 select。");
    const index = args.history_index;
    if (index !== undefined && (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= this.count))
      throw new Error("历史索引超出本轮范围。");
    const collect = (fragments: PlatformMessageFragment[], prefix: string) => {
      for (const [i, f] of fragments.entries()) {
        if (f.accountId !== account || f.conversationId !== this.inbound.conversationId || f.direction !== "inbound") continue;
        for (const [j, a] of (f.attachments ?? []).entries()) {
          if (validSticker(a.sticker, this.inbound.conversationId, account)) this.catalog.set(prefix + ":" + i + ":" + j, a.sticker);
        }
      }
    };
    collect(this.inbound.platformMessages ?? [], "current");
    const start = typeof index === "number" ? index : Math.max(0, this.count - 50);
    const entries = await this.history.readRange(start, typeof index === "number" ? 1 : this.count - start);
    for (const [i, entry] of entries.entries()) {
      const message = entry as SessionMessage;
      if (message.role !== "user" || message.source?.channel !== "telegram" || message.source.senderId !== this.inbound.senderId) continue;
      collect(message.source.platformMessages ?? [], "history:" + (start + i));
    }
    return { stickers: [...this.catalog].map(([key, s]) => ({ key, emoji: s.emoji, set_name: s.setName, format: s.format })),
      note: "仅包含本会话真实收到的贴纸；更早的贴纸可指定 history_index 查找。" };
  }
}
