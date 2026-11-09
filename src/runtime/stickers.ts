import { createHash } from "node:crypto";
import type { InboundMessage, TelegramSticker, PlatformMessageFragment } from "../channels/types.js";
import type { RuntimeHistory, RuntimeTool } from "./types.js";
import type { SessionMessage } from "../sessions/types.js";
import type { SessionStore, TelegramReactionEntry } from "../sessions/store.js";

export function validSticker(value: TelegramSticker | undefined, chatId: string, accountId?: string): value is TelegramSticker {
  return Boolean(value && accountId && /^telegram-bot:[1-9][0-9]*$/.test(accountId) &&
    value.accountId === accountId && value.chatId === chatId &&
    typeof value.fileId === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value.fileId) &&
    ["static", "animated", "video", "gif", "gif_document", "mp4_document", "image"].includes(value.format));
}
export const STICKER_TOOL: RuntimeTool = {
  name: "gateway_sticker", readOnly: true, replaySafe: true,
  description: "查找或选择本 TG 私聊收到过的贴纸和 GIF。list 返回当前、近期历史和主库目录的真实素材及备注；query 或 queries 可按备注等搜索，queries 接受最多 3 个关键词，多词命中的优先，history_index 可查指定历史条目。select 可使用 list 返回或上下文已知的真实素材 key，登记本轮一个素材；没有合适素材时再查询最多 8 个候选，由 Gateway 实际发送。",
  parameters: { type: "object", properties: {
    action: { type: "string", enum: ["list", "select"] },
    history_index: { type: "integer", minimum: 0 }, key: { type: "string" }, query: { type: "string" },
    queries: { type: "array", minItems: 1, maxItems: 3, items: {type: "string", minLength: 1, maxLength: 100} },
  }, required: ["action"], additionalProperties: false },
};
export const STICKER_NOTE_TOOL: RuntimeTool = {
  name: "gateway_sticker_note", readOnly: false, replaySafe: false,
  description: "给 gateway_sticker.list 返回的真实贴纸或 GIF 保存或更正简短使用备注。只写确实看见的内容或用户明确说明的含义；多帧预览以外的动作不得推断。",
  parameters: { type: "object", properties: {
    key: { type: "string" }, note: { type: "string", minLength: 1, maxLength: 280 },
  }, required: ["key", "note"], additionalProperties: false },
};
export class StickerTurn {
  private readonly catalog = new Map<string, TelegramSticker>();
  private readonly count: number;
  private selection?: TelegramSticker;
  constructor(private readonly history: RuntimeHistory, private readonly inbound: InboundMessage,
    private readonly saved?: Pick<SessionStore, "listTelegramReactions" | "setTelegramReactionNote">) { this.count = history.count; }
  get prepared(): TelegramSticker | undefined { return this.selection; }
  private account(): string {
    const account = this.inbound.platformMessages?.[0]?.accountId;
    if (this.inbound.channel !== "telegram" || this.inbound.senderId !== this.inbound.conversationId || !account)
      throw new Error("表情包工具仅支持当前 Telegram 私聊。");
    return account;
  }
  async note(args: Record<string, unknown>): Promise<unknown> {
    const account = this.account();
    if (!args || Object.keys(args).some(k => !["key", "note"].includes(k)) ||
      typeof args.key !== "string" || typeof args.note !== "string") throw new Error("备注参数无效。");
    const chosen = this.catalog.get(args.key);
    if (!validSticker(chosen, this.inbound.conversationId, account)) throw new Error("请先 list，再给真实表情包写备注。");
    if (!this.saved) throw new Error("表情包备注存储未启用。");
    const updated = await this.saved.setTelegramReactionNote(account, this.inbound.conversationId, chosen.fileId, args.note);
    return { status: "saved", note: updated.note, format: updated.sticker.format };
  }
  async execute(args: Record<string, unknown>): Promise<unknown> {
    const account = this.account();
    if (!args || Object.keys(args).some(k => !["action", "history_index", "key", "query", "queries"].includes(k))) throw new Error("贴纸参数无效。");
    if (args.action === "select") {
      if (args.history_index !== undefined || args.query !== undefined || args.queries !== undefined || typeof args.key !== "string") throw new Error("请选择 list 返回的 key。");
      let chosen = this.catalog.get(args.key);
      if (!chosen && /^asset:[a-f0-9]{24}$/.test(args.key)) {
        const saved = await this.saved?.listTelegramReactions(account,this.inbound.conversationId,undefined,5000) ?? [];
        chosen = saved.find(entry => "asset:" + createHash("sha256").update(entry.sticker.fileId).digest("hex").slice(0,24) === args.key)?.sticker;
      }
      if (!validSticker(chosen, this.inbound.conversationId, account)) throw new Error("请先 list，再选择真实表情包。");
      if (this.selection && this.selection.fileId !== chosen.fileId) throw new Error("每轮只能选择一个表情包。");
      this.selection = chosen;
      return { status: "selected", source_format: chosen.format, note: "已登记表情包；实际送达由 Gateway 确认。" };
    }
    if (args.action !== "list" || args.key !== undefined || (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 100)))
      throw new Error("请选择 list 或 select。");
    if (args.queries !== undefined && (args.query !== undefined || !Array.isArray(args.queries) ||
      args.queries.length < 1 || args.queries.length > 3 || args.queries.some(q => typeof q !== "string" || !q.trim() || q.length > 100)))
      throw new Error("queries 需要 1–3 个非空关键词，不能与 query 同时使用。");
    const index = args.history_index;
    if (index !== undefined && (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= this.count))
      throw new Error("历史索引超出本轮范围。");
    const entries = new Map<string, TelegramSticker>();
    const collect = (fragments: PlatformMessageFragment[], prefix: string) => {
      for (const [i, f] of fragments.entries()) {
        if (f.accountId !== account || f.conversationId !== this.inbound.conversationId || f.direction !== "inbound") continue;
        for (const [j, a] of (f.attachments ?? []).entries()) {
          if (validSticker(a.sticker, this.inbound.conversationId, account)) entries.set(prefix + ":" + i + ":" + j, a.sticker);
        }
      }
    };
    collect(this.inbound.platformMessages ?? [], "current");
    const start = typeof index === "number" ? index : Math.max(0, this.count - 50);
    const recent = await this.history.readRange(start, typeof index === "number" ? 1 : this.count - start);
    for (const [i, entry] of recent.entries()) {
      const message = entry as SessionMessage;
      if (message.role !== "user" || message.source?.channel !== "telegram" || message.source.senderId !== this.inbound.senderId) continue;
      collect(message.source.platformMessages ?? [], "history:" + (start + i));
    }
    const persisted: TelegramReactionEntry[] = await this.saved?.listTelegramReactions(account, this.inbound.conversationId, undefined, 5000) ?? [];
    const descriptions = new Map(persisted.map(entry => [entry.sticker.fileId, entry.note]));
    const seen = new Set([...entries.values()].map(item => item.fileId));
    for (const [i, entry] of persisted.entries()) {
      if (!validSticker(entry.sticker, this.inbound.conversationId, account) || seen.has(entry.sticker.fileId)) continue;
      entries.set("saved:" + i, entry.sticker);
      seen.add(entry.sticker.fileId);
    }
    const queries = [...new Set((args.queries as string[] | undefined ?? [typeof args.query === "string" ? args.query : ""]).map(q => q.trim().toLowerCase()).filter(Boolean))];
    const distinct = new Map([...entries.values()].map(sticker => ["asset:" + createHash("sha256").update(sticker.fileId).digest("hex").slice(0,24), sticker]));
    const visible = [...distinct].map(entry => ({entry, score: queries.filter(query =>
      [descriptions.get(entry[1].fileId), entry[1].emoji, entry[1].setName, entry[1].format]
        .some(value => value?.toLowerCase().includes(query))).length}))
      .filter(item => !queries.length || item.score > 0).sort((a,b) => b.score-a.score).slice(0,8).map(item => item.entry);
    for (const entry of visible) {
      this.catalog.set(entry[0],entry[1]);
    }
    return { stickers: visible.map(([key, s]) => ({ key, kind: s.format.startsWith("gif") || s.format === "mp4_document" ? "gif" : "sticker",
      emoji: s.emoji, set_name: s.setName, format: s.format, note: descriptions.get(s.fileId) })),
      note: "仅包含本私聊真实收到的素材；GIF 和视频贴纸的多帧预览可能不完整，更早的贴纸可指定 history_index 查找。" };
  }
}
