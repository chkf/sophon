import { randomBytes } from "node:crypto";
import type { TelegramApiClient, TelegramMessage } from "./types.js";

export interface PanelButton { text: string; run?: () => Promise<PanelView>; url?: string }
export interface PanelView {
  text: string;
  rows: PanelButton[][];
  /** Explicit reply to the panel only; ordinary conversation is never captured. */
  input?: (text: string) => Promise<PanelView>;
  /** Async diagnostics return the initial view immediately and publish the result later. */
  follow?: Promise<PanelView>;
  autoDelete?: boolean;
  /** A session-scoped panel can supply a stricter lifetime than the formal-mode default. */
  canAct?: () => boolean;
}
interface Panel { chatId: string; messageId: number; generation: string; actions: Map<string, () => Promise<PanelView>>;
  input?: PanelView["input"]; canAct: () => boolean; busy: boolean; expires: number }

/** Callback tokens are short, opaque, single-render and bound to an owner/private message. */
export class TelegramPanels {
  private readonly panels = new Map<string, Panel>();
  constructor(private readonly api: TelegramApiClient, private readonly ownerId: string,
    private readonly scheduleDeletion: (chatId: string, ids: number[], durationMs?: number) => Promise<void>, private readonly canAct: () => boolean = () => true) {}
  private key(chat: string, id: number) { return chat + ":" + id; }
  private prune() { for (const [key,p] of this.panels) if (p.expires < Date.now()) this.panels.delete(key); }
  async open(chatId: string, view: PanelView): Promise<number> {
    this.prune();
    const sent = await this.api.call<{ message_id: number }>("sendMessage", { chat_id: chatId, text: view.text, protect_content:true });
    if (!Number.isSafeInteger(sent.message_id)) throw new Error("未收到面板消息编号。");
    const p: Panel = { chatId, messageId: sent.message_id, generation: "", actions: new Map(), canAct: this.canAct, busy: false, expires: Date.now()+24*3600_000 };
    this.panels.set(this.key(chatId,p.messageId), p);
    await this.render(p, view);
    return p.messageId;
  }
  forget(chatId: string, id: number) { this.panels.delete(this.key(chatId,id)); }
  private async render(p: Panel, view: PanelView): Promise<void> {
    const generation = randomBytes(6).toString("hex");
    const actions = new Map<string, () => Promise<PanelView>>();
    let i=0;
    const rows = view.rows.map(row => row.map(button => {
      if (button.url) return { text: button.text, web_app: { url: button.url } };
      const token = "p:" + generation + ":" + i++;
      if (button.run) actions.set(token, button.run);
      return { text: button.text, callback_data: token };
    }));
    rows.push([{ text: "收起面板", callback_data: "p:" + generation + ":close" }]);
    // Commit actions before edit: old tokens become stale even if delivery is ambiguous.
    p.generation=generation; p.actions=actions; p.input=view.input; p.canAct=view.canAct??this.canAct; p.expires=Date.now()+24*3600_000;
    await this.api.call("editMessageText", { chat_id:p.chatId, message_id:p.messageId,
      text:view.text.slice(0,3900), reply_markup:{inline_keyboard:rows} });
    // Persist the deadline through the adapter, including across process restarts.
    await this.scheduleDeletion(p.chatId,[p.messageId],view.autoDelete ? undefined : 24*3600_000);
    if(view.follow) void view.follow.then(async next => {
      if(this.panels.get(this.key(p.chatId,p.messageId))===p && p.generation===generation) await this.render(p,next);
    }).catch(() => undefined);
  }
  async callback(query: { id:string; from:{id:number|string}; message?:TelegramMessage; data?:string }): Promise<void> {
    const m=query.message;
    if(String(query.from.id)!==this.ownerId || !m || m.chat.type!=="private" || String(m.chat.id)!==this.ownerId) {
      await this.api.call("answerCallbackQuery",{callback_query_id:query.id,text:"仅限所有者私聊。"});return;
    }
    this.prune();
    const p=this.panels.get(this.key(String(m.chat.id),m.message_id));
    const data=query.data??"";
    if(!p) {
      await this.api.call("answerCallbackQuery",{callback_query_id:query.id});
      if(data.startsWith("p:")) await this.api.call("deleteMessage",{chat_id:m.chat.id,message_id:m.message_id}).catch(()=>undefined);
      return;
    }
    if(!data.startsWith("p:"+p.generation+":")) {
      // A delayed click from a previous render must not delete the current panel.
      await this.api.call("answerCallbackQuery",{callback_query_id:query.id});return;
    }
    if(p.busy) {await this.api.call("answerCallbackQuery",{callback_query_id:query.id,text:"正在处理，请稍候。"});return;}
    await this.api.call("answerCallbackQuery",{callback_query_id:query.id});
    if(data.endsWith(":close")) {
      this.forget(p.chatId,p.messageId);
      await this.api.call("deleteMessage",{chat_id:p.chatId,message_id:p.messageId});return;
    }
    if(!p.canAct()) { await this.render(p,{text:"当前模式不能使用这个面板，请重新发送对应指令。",rows:[]});return; }
    const action=p.actions.get(data);if(!action)return;
    p.actions.clear();p.busy=true;
    try { await this.render(p,await action()); }
    catch { await this.render(p,{text:"操作未完成，请重新打开面板检查当前状态。",rows:[]}); }
    finally {p.busy=false;}
  }
  async input(message: TelegramMessage): Promise<boolean> {
    const p=message.reply_to_message && this.panels.get(this.key(String(message.chat.id),message.reply_to_message.message_id));
    if(!p?.input || p.expires<Date.now() || !message.text || message.text.startsWith("/"))return false;
    if(!p.canAct())return false;
    if(p.busy)return true;
    p.busy=true;const input=p.input;p.input=undefined;
    try {await this.render(p,await input(message.text));}
    catch {await this.render(p,{text:"填写未完成，请重新打开面板。",rows:[]});}
    finally {p.busy=false;}
    await this.api.call("deleteMessage",{chat_id:p.chatId,message_id:message.message_id}).catch(()=>undefined);
    return true;
  }
}
