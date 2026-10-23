import { displayText, spokenText, visibleSegments } from "../../runtime/reply-segments.js";
import { deliverReplySegments } from "./delivery.js";
import { TelegramPanels } from "./panels.js";
import { voiceSupplement, VoiceSupplementError } from "../../voice/tool.js";
import { deliverPreparedReply, normalizePendingReply, type TelegramTextProgress } from "./delivery.js";
import { TelegramStateStore } from "./state-store.js";
import { TelegramDelivery, sendTelegramImage } from "./delivery.js";
import { pollTelegram } from "./poller.js";
import { telegramMessageAllowed, largestPhoto, immediateCommand, normalizeReplyTo, batchAcceptsReply, batchesCanMerge, inboundRetryDelayMs, mergeBufferedBatch, MAX_AUTOMATIC_RETRY_ATTEMPTS } from "./input-buffer.js";
import type { TelegramState, TelegramBufferedPart, TelegramCommandReplyDeletion, TelegramMessage, TelegramUpdate, TelegramFile, TelegramPhoto, TelegramApiClient, TelegramAdapterConfig } from "./types.js";
export type { TelegramApiClient, TelegramAdapterConfig } from "./types.js";
export { telegramMessageAllowed } from "./input-buffer.js";
export { splitTelegramText } from "./delivery.js";
import { normalizeInboundReply } from "../reply.js";
import type { RuntimeImage } from "../../runtime/types.js";
import { basename } from "node:path";
import type { Attachment, AttachmentKind, InboundHandler, InboundMessage, ProactiveSender, ProactiveDelivery } from "../types.js";
import type { ReplyOutcome } from "../reply.js";
import { TelegramBotApi } from "./api.js";
import { telegramAccountId, nativeReplyParameters } from "../../runtime/native-reply.js";
import type { TelegramNativeReply } from "../types.js";

export class TelegramAdapter implements ProactiveSender {
  readonly channel = "telegram" as const;
  private readonly api: TelegramApiClient;
  private readonly delivery: TelegramDelivery;
  private readonly panels: TelegramPanels;
  private readonly store: TelegramStateStore;
  private running = false;
  private pollAbort?: AbortController;
  private pollTask?: Promise<void>;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushTask?: Promise<void>;
  private replyQueue: Promise<void> = Promise.resolve();
  private readonly commandReplyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private processingBuffered = false;
  private handler?: InboundHandler;
  private get state(): TelegramState { return this.store.state; }
  private set state(value: TelegramState) { this.store.state = value; }

  constructor(private readonly config: TelegramAdapterConfig) {
    this.api = config.api ?? new TelegramBotApi(config.token);
    this.delivery = new TelegramDelivery(this.api);
    this.store = new TelegramStateStore(config.dataDir);
    this.panels = new TelegramPanels(this.api, config.ownerId, (chat, ids, duration) => this.scheduleCommandReplyDeletion(chat, ids, duration));
  }

  async start(handler: InboundHandler): Promise<void> {
    if (this.running) throw new Error("Telegram adapter is already running.");
    this.handler = handler;
    this.state = await this.store.load();
    const legacy = this.state as TelegramState & { pending?: unknown };
    if ("pending" in legacy) {
      delete legacy.pending;
      await this.store.mutate(() => undefined);
    }

    await this.api.call("deleteWebhook", { drop_pending_updates: false });
    await this.api.call("deleteMyCommands", {}).catch(() => undefined);
    if (this.config.commands?.length) {
      await this.api.call("setMyCommands", { commands: this.config.commands });
    }

    this.running = true;
    this.resumeCommandReplyDeletions();
    await (this.config.conversationQueue?.run(() => this.resumePendingReply()) ?? this.resumePendingReply());
    this.scheduleBufferedFlush();
    this.pollAbort = new AbortController();
    this.pollTask = pollTelegram(this.api, this.pollAbort.signal, () => this.running, () => this.state.offset,
      update => this.processUpdate(update), () => { this.running = false; this.config.onPollingConflict?.(); });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.clearFlushTimer();
    this.pollAbort?.abort();
    await this.pollTask?.catch(() => undefined);
    await this.flushTask?.catch(() => undefined);
    await this.replyQueue.catch(() => undefined);
    for (const timer of this.commandReplyTimers.values()) clearTimeout(timer);
    this.commandReplyTimers.clear();
    this.pollAbort = undefined;
    this.pollTask = undefined;
    this.flushTask = undefined;
  }

  async availableTarget(): Promise<string | undefined> {
    this.state = await this.store.load();
    return this.state.lastChatId;
  }

  async sendImages(target: string, images: RuntimeImage[], deliveryId: string): Promise<void> {
    // Heartbeat durably consumes its pending send before calling this method.
    for (const image of images.slice(0, 1)) {
      await sendTelegramImage(this.api, target, image);
      // Persist the acknowledged image even if the following text send fails.
      await this.config.onProactiveDelivered?.({ conversationId: target, senderId: this.config.ownerId,
        reply: "[主动生成图片] " + image.prompt, images: [image], deliveryId: deliveryId + ":image" });
    }
  }

  availableStickers(): number {
    return this.config.stickerIds?.length ?? 0;
  }

  async sendSticker(target: string, index: number): Promise<void> {
    const sticker = this.config.stickerIds?.[index - 1];
    if (!sticker || !Number.isInteger(index) || index < 1) throw new Error("Sticker is not allowlisted.");
    await this.api.call("sendSticker", { chat_id: target, sticker });
  }

  async sendText(target: string, text: string, onSent?: TelegramTextProgress,
    reply?: TelegramNativeReply, requireReceipt = Boolean(onSent)): Promise<void> {
    const account = telegramAccountId(this.config.token);
    await this.delivery.sendTextCollectMessageIds(target, text, onSent ? (id, chunk) => onSent(chunk, id) : undefined,
      nativeReplyParameters(reply, target, account),
      requireReceipt);
  }

  async sendProactiveText(target: string, text: string, voiceText?: string, delivery?: ProactiveDelivery): Promise<void> {
    if (this.config.showStageDirections) text = displayText(text, await this.config.showStageDirections());
    if (voiceText) voiceText = spokenText(voiceText);
    if(!voiceText && !delivery?.replySegments){await this.sendText(target,text);return;}
    const delivered: string[] = [];
    const sendVoiceText = async (value: string) => {
      await this.sendText(target, value, chunk => { delivered.push(chunk); });
    };
    try {
      if (delivery?.replySegments) {
        const segments = visibleSegments(delivery.replySegments, await this.config.showStageDirections?.() ?? true);
        await deliverReplySegments(segments, sendVoiceText, async (part, index) => {
          const spoken = await this.config.sendProactiveVoice?.(this.api, target, part.text, part.instruction,
            delivery.deliveryId + ":segment:" + index) ?? false;
          if (spoken) delivered.push(part.text);
          return spoken;
        });
        return;
      }
      if (await this.config.sendProactiveVoice?.(this.api, target, voiceText!, delivery?.voiceInstruction)) delivered.push(voiceText!);
      else await sendVoiceText(voiceText!);
      const rest=voiceSupplement(text,voiceText!);
      if(rest) await sendVoiceText(rest);
    } catch (error) {
      if(delivered.length) throw new VoiceSupplementError(delivered.join("\n\n"));
      throw error;
    }
  }
  async showQr(bytes: Buffer): Promise<void> {
    const sent=await this.api.call<{message_id:number}>("sendPhoto",{chat_id:this.config.ownerId,
      photo:new Blob([new Uint8Array(bytes)],{type:"image/png"}),protect_content:true,caption:"微信绑定二维码：请用自己的微信扫码。建议在电脑 TG 展示、手机微信扫描。"});
    await this.scheduleCommandReplyDeletion(this.config.ownerId,[sent.message_id],300_000);
  }
  async notify(text:string,open?:()=>Promise<import("./panels.js").PanelView>):Promise<void> {
    await this.panels.open(this.config.ownerId,{text,rows:open?[[{text:"微信管理 / 重新绑定",run:open}]]:[]});
  }
  /** Owner-only informational notice; never enters ordinary reply delivery or chat history. */
  async notifyTemporary(text: string, durationMs = 60_000): Promise<void> {
    const sent = await this.api.call<{ message_id: number }>("sendMessage", {
      chat_id: this.config.ownerId, text,
    });
    if (!Number.isSafeInteger(sent?.message_id) || sent.message_id <= 0) {
      throw new Error("Telegram did not acknowledge the temporary notification.");
    }
    await this.scheduleCommandReplyDeletion(this.config.ownerId, [sent.message_id], durationMs);
  }
  async previewVoice():Promise<boolean> {
    return await this.config.sendVoice?.(this.api,this.config.ownerId,"你好，这是语音试听示例。","preview:"+Date.now(),undefined,undefined,undefined,true)??false;
  }

  private debounceMs(): number {
    return this.config.inputDebounceMs ?? 8_000;
  }

  private typingRefreshMs(): number {
    return this.config.typingRefreshMs ?? 4_000;
  }

  private commandReplyAutoDeleteMs(): number {
    return this.config.commandReplyAutoDeleteMs ?? 60_000;
  }

  private async deleteMessage(chatId: string, messageId: string | number): Promise<void> {
    await this.api.call("deleteMessage", {
      chat_id: chatId,
      message_id: Number(messageId),
    }).catch((error) => {
      console.error(
        "[telegram] auto-delete failed:",
        error instanceof Error ? error.message : error,
      );
    });
  }

  // Preserve deletion deadlines across /update: it restarts the Gateway process.
  private resumeCommandReplyDeletions(): void {
    for (const entry of this.state.commandReplyDeletions ?? []) this.armCommandReplyDeletion(entry);
  }

  private armCommandReplyDeletion(entry: TelegramCommandReplyDeletion): void {
    if (!Number.isFinite(entry.expiresAtMs) || !entry.messageIds?.length ||
        !entry.messageIds.every(id => Number.isSafeInteger(id) && id > 0)) return;
    const key = entry.chatId + ":" + entry.messageIds.join(",");
    const existing = this.commandReplyTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.commandReplyTimers.delete(key);
      for (const id of entry.messageIds) this.panels.forget(entry.chatId, id);
      void (async () => {
        await Promise.all(entry.messageIds.map(id => this.deleteMessage(entry.chatId, id)));
        await this.store.mutate(() => {
          const remainder = (this.state.commandReplyDeletions ?? []).filter(item =>
            item.chatId !== entry.chatId || item.expiresAtMs !== entry.expiresAtMs ||
            item.messageIds[0] !== entry.messageIds[0]);
          if (remainder.length) this.state.commandReplyDeletions = remainder;
          else delete this.state.commandReplyDeletions;
        });
      })().catch(error => console.error("[telegram] auto-delete bookkeeping failed:",
        error instanceof Error ? error.message : error));
    }, Math.max(0, entry.expiresAtMs - Date.now()));
    this.commandReplyTimers.set(key, timer);
    timer.unref?.();
  }

  private async scheduleCommandReplyDeletion(chatId: string, messageIds: number[], durationMs = this.commandReplyAutoDeleteMs()): Promise<void> {
    if (!messageIds.length) return;
    const entry: TelegramCommandReplyDeletion = {
      chatId, messageIds, expiresAtMs: Date.now() + durationMs,
    };
    await this.store.mutate(() => {
      // Rendering a panel refreshes its one durable deadline, not an earlier timer.
      this.state.commandReplyDeletions = (this.state.commandReplyDeletions ?? []).filter(item =>
        item.chatId !== chatId || item.messageIds.join(",") !== messageIds.join(","));
      (this.state.commandReplyDeletions ??= []).push(entry);
    });
    this.armCommandReplyDeletion(entry);
  }

  private async withTyping<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const sendTyping = () => this.api.call("sendChatAction", {
      chat_id: chatId,
      action: "typing",
    }).catch(() => undefined);

    await sendTyping();
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started < 60_000) void sendTyping();
      else clearInterval(timer);
    }, this.typingRefreshMs());

    try {
      return await task();
    } finally {
      clearInterval(timer);
    }
  }

  private mutateState<T>(mutator: () => T): Promise<T> { return this.store.mutate(mutator); }

  private clearFlushTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private scheduleBufferedFlush(): void {
    this.clearFlushTimer();
    if (!this.running || this.processingBuffered) return;

    const now = Date.now();
    let delay: number;
    if (this.state.inFlight) {
      if (this.state.inFlight.retryPaused) return;
      delay = Math.max(0, (this.state.inFlight.retryAtMs ?? now) - now);
    } else if (this.state.queuedBuffers?.length || this.state.buffer) {
      const first = this.state.queuedBuffers?.[0] ?? this.state.buffer!;
      const elapsed = Math.max(0, now - first.lastReceivedAtMs);
      delay = Math.max(0, this.debounceMs() - elapsed);
    } else {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const task = this.flushBuffered()
        .catch((error) => {
          console.error("[telegram] buffered input flush failed:", error instanceof Error ? error.message : error);
        })
        .finally(() => {
          if (this.flushTask === task) this.flushTask = undefined;
        });
      this.flushTask = task;
    }, delay);
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    if (update.update_id < this.state.offset) return;

    if (update.callback_query) {
      await this.consumeUpdate(update.update_id);
      try { if (!(await this.config.onCallback?.(update.callback_query, this.api))) await this.panels.callback(update.callback_query); }
      catch { console.error("[telegram] callback failed"); }
      return;
    }
    const message = update.message;
    if (!message || !telegramMessageAllowed(message, this.config.ownerId) || !this.handler) {
      await this.consumeUpdate(update.update_id);
      return;
    }

    const chatId = String(message.chat.id);
    const senderId = String(message.from?.id ?? "");
    const text = message.text ?? message.caption ?? "";
    if (message.text && !immediateCommand(text) && message.reply_to_message) {
      if (await this.panels.input(message)) { await this.consumeUpdate(update.update_id, chatId); return; }
    }
    const replyTo = normalizeReplyTo(message, this.config.ownerId);
    if (replyTo && message.reply_to_message) {
      const replyAttachments = await this.collectAttachments(message.reply_to_message);
      if (replyAttachments.length) replyTo.attachments = replyAttachments;
    }
    this.state.lastChatId = chatId;

    const slashCommand = immediateCommand(text);
    if (slashCommand) {
      this.clearFlushTimer();
      await this.consumeUpdate(update.update_id, chatId);
      await this.processImmediate({
        channel: "telegram", conversationId: chatId, senderId,
        messageId: String(message.message_id), text,
        receivedAt: new Date(message.date * 1000).toISOString(),
        attachments: await this.collectAttachments(message),
        ...(replyTo ? { replyTo } : {}),
      }, false, true);
      this.scheduleBufferedFlush();
      return;
    }

    // A newly received bubble extends the quiet window immediately, even if
    // attachment collection itself takes a little time.
    this.clearFlushTimer();
    const attachments = await this.collectAttachments(message);
    if (!text.trim() && attachments.length === 0) {
      await this.consumeUpdate(update.update_id, chatId);
      this.scheduleBufferedFlush();
      return;
    }

    const accountId = telegramAccountId(this.config.token);
    const platformMessage = accountId && Number.isSafeInteger(message.message_id) && message.message_id > 0
      ? { accountId, conversationId: chatId, direction: "inbound" as const,
          messageId: String(message.message_id), text, ...(attachments.length ? { attachments } : {}) }
      : undefined;
    const part: TelegramBufferedPart = {
      messageId: String(message.message_id),
      text,
      receivedAt: new Date(message.date * 1000).toISOString(),
      attachments,
      ...(replyTo ? { replyTo } : {}),
      ...(platformMessage ? { platformMessage } : {}),
    };

    await this.mutateState(() => {
      const now = Date.now();
      const pending = this.state.inFlight;
      const queued = this.state.buffer;

      if (
        pending &&
        pending.pauseReason === undefined &&
        !this.processingBuffered &&
        !this.state.queuedBuffers?.length &&
        (!queued || batchesCanMerge(pending, queued)) &&
        batchAcceptsReply(pending, chatId, replyTo)
      ) {
        if (queued && batchesCanMerge(pending, queued)) {
          pending.parts.push(...queued.parts);
          pending.lastReceivedAtMs = Math.max(pending.lastReceivedAtMs, queued.lastReceivedAtMs);
          delete this.state.buffer;
        }
        pending.parts.push(part);
        pending.lastReceivedAtMs = now;
        pending.retryAttempts = 0;
        pending.retryPaused = false;
        pending.retryAtMs = now + this.debounceMs();
      } else {
        const existing = this.state.buffer;
        if (existing && batchAcceptsReply(existing, chatId, replyTo)) {
          existing.parts.push(part);
          existing.lastReceivedAtMs = now;
        } else {
          if (existing) (this.state.queuedBuffers ??= []).push(existing);
          this.state.buffer = {
            chatId,
            senderId,
            lastReceivedAtMs: now,
            parts: [part],
          };
        }
      }
      // A new owner message explicitly wakes a paused batch, even if its reply
      // target is different and it must remain in a subsequent ordered batch.
      if (pending?.retryPaused && pending.pauseReason === undefined) {
        pending.retryPaused = false;
        pending.retryAttempts = 0;
        pending.retryAtMs = now + this.debounceMs();
      }
      this.state.offset = Math.max(this.state.offset, update.update_id + 1);
      this.state.lastChatId = chatId;
    });

    if (!this.state.inFlight?.retryPaused) await this.clearPauseNotices();
    this.scheduleBufferedFlush();
  }

  private async consumeUpdate(updateId: number, chatId?: string): Promise<void> {
    await this.mutateState(() => {
      this.state.offset = Math.max(this.state.offset, updateId + 1);
      if (chatId) this.state.lastChatId = chatId;
    });
  }

  private async processImmediate(
    inbound: InboundMessage,
    consumeInFlight = false,
    autoDeleteCommand = false,
  ): Promise<void> {
    // Read/config panels and /retry must remain available while a model is busy.
    if (autoDeleteCommand) {
      await this.processReply(inbound, consumeInFlight, autoDeleteCommand); return;
    }
    const task = this.replyQueue.catch(() => undefined)
      .then(() => this.config.conversationQueue?.run(() => this.processReply(inbound, consumeInFlight, autoDeleteCommand)) ?? this.processReply(inbound, consumeInFlight, autoDeleteCommand));
    this.replyQueue = task;
    await task;
  }

  queueSummary(): string {
    const s=this.state;
    const count=(s.inFlight?.parts.length??0)+(s.buffer?.parts.length??0)+(s.queuedBuffers??[]).reduce((n,b)=>n+b.parts.length,0);
    return "待处理消息："+count+"\n状态："+(s.inFlight?.retryPaused ? "暂停（"+(s.inFlight.pauseReason??"连续失败")+"）" : this.processingBuffered ? "正在回复" : "等待输入或重试")+
      "\n重试次数："+(s.inFlight?.retryAttempts??0);
  }
  private async sendPauseNotice(chatId:string,text:string):Promise<void> {
    const sent=await this.api.call<{message_id:number}>("sendMessage",{chat_id:chatId,text});
    if(Number.isSafeInteger(sent.message_id)) await this.store.mutate(()=>{(this.state.pauseNotices??=[]).push({chatId,messageId:sent.message_id});});
  }
  private async clearPauseNotices():Promise<void> {
    const notices=this.state.pauseNotices??[];
    for(const n of notices) await this.deleteMessage(n.chatId,n.messageId);
    await this.store.mutate(()=>{delete this.state.pauseNotices;});
  }

  private async notifyRetryPaused(chatId: string): Promise<void> {
    // The paused state is committed before notifying. Never replay uncertain
    // Telegram delivery just to ensure this operational notice was seen.
    console.error("[telegram] inbound automatic retry limit reached; pending message preserved and paused");
    await this.sendPauseNotice(chatId, "Gateway 连续 3 次无法完成模型回复，已暂停自动重试。你的消息仍保存在待回复队列中，没有丢失。稍后发新消息或发送 /retry 可以继续尝试；不需要重新发送原问题。").catch((error) => console.error("[telegram] retry pause notice failed:",
      error instanceof Error ? error.message : String(error)));
  }

  private async notifyUsagePaused(chatId: string): Promise<void> {
    // Persist the pause before sending this notice. An ambiguous send is never replayed.
    await this.sendPauseNotice(chatId, "这边的 ChatGPT 额度暂时用完了。原消息已保存并暂停处理；额度恢复后发送 /retry 继续，无需重发问题。").catch((error) => console.error("[telegram] usage pause notice failed:",
      error instanceof Error ? error.message : String(error)));
  }

  private async processReply(
    inbound: InboundMessage,
    consumeInFlight = false,
    autoDeleteCommand = false,
  ): Promise<void> {
    if (!this.handler) return;

    const command = inbound.text.trim().match(/^\/([a-z]+)(?:@[a-z0-9_]+)?\s*$/i)?.[1]?.toLowerCase();
    if (command && this.config.onPanel) {
      const view=await this.config.onPanel(command,inbound);
      if(view) {await this.panels.open(inbound.conversationId,view);await this.deleteMessage(inbound.conversationId,inbound.messageId);return;}
    }

    if (inbound.senderId === this.config.ownerId &&
        /^\/retry(?:@[a-z0-9_]+)?\s*$/i.test(inbound.text.trim())) {
      const outcome = await this.mutateState(() => {
        const pending = this.state.inFlight;
        if (this.processingBuffered) return "busy";
        if (!pending || (!pending.retryPaused && (pending.retryAttempts ?? 0) === 0)) return "empty";
        pending.retryPaused = false;
        delete pending.pauseReason;
        pending.retryAttempts = 0;
        pending.retryAtMs = Date.now();
        return "resumed";
      });
      if (outcome === "resumed") await this.clearPauseNotices();
      const sent = await this.delivery.sendTextCollectMessageIds(inbound.conversationId,
        outcome === "resumed" ? "已恢复待回复消息。" : outcome === "busy"
          ? "模型仍在处理这条消息，不会重复发起请求。" : "没有可重试的待回复消息。").catch(() => []);
      await this.scheduleCommandReplyDeletion(inbound.conversationId, sent);
      if (autoDeleteCommand) await this.deleteMessage(inbound.conversationId, inbound.messageId);
      return;
    }

    await this.withTyping(inbound.conversationId, async () => {
      const result = normalizeInboundReply(await this.handler!(inbound));
      if (result?.kind === "pause") {
        if (!consumeInFlight) return;
        let newlyPaused = false;
        await this.mutateState(() => {
          const pending = this.state.inFlight;
          if (!pending) return;
          newlyPaused = pending.pauseReason !== result.reason;
          pending.retryPaused = true;
          pending.pauseReason = result.reason;
          delete pending.retryAtMs;
        });
        if (newlyPaused) {
          if (result.reason === "subscription_usage_limit") await this.notifyUsagePaused(inbound.conversationId);
          else await this.sendPauseNotice(inbound.conversationId,
            "这次模型调用没有完成，原消息已保留，未当成已回复。发送 /retry 可以重新尝试，不需要重发原问题。")
            .catch(error => console.error("[telegram] model pause notice failed:", error instanceof Error ? error.message : String(error)));
        }
        return;
      }
      if (result?.kind === "retry") {
        if (!consumeInFlight) return;
        let paused = false;
        await this.mutateState(() => {
          const pending = this.state.inFlight;
          if (!pending) return;

          let mergedFollowup = false;
          // Merge only contiguous compatible follow-ups. A later reply must not
          // jump over an earlier batch quoting a different message.
          while (this.state.queuedBuffers?.length && batchesCanMerge(pending, this.state.queuedBuffers[0]!)) {
            const queued = this.state.queuedBuffers.shift()!;
            pending.parts.push(...queued.parts);
            pending.lastReceivedAtMs = Math.max(pending.lastReceivedAtMs, queued.lastReceivedAtMs);
            mergedFollowup = true;
          }
          const queued = this.state.buffer;
          if (!this.state.queuedBuffers?.length && queued && batchesCanMerge(pending, queued)) {
            pending.parts.push(...queued.parts);
            pending.lastReceivedAtMs = Math.max(pending.lastReceivedAtMs, queued.lastReceivedAtMs);
            delete this.state.buffer;
            mergedFollowup = true;
          }

          if (mergedFollowup) pending.retryAttempts = 0;
          const attempt = (pending.retryAttempts ?? 0) + 1;
          pending.retryAttempts = attempt;
          if (attempt >= MAX_AUTOMATIC_RETRY_ATTEMPTS) {
            pending.retryPaused = true;
            delete pending.retryAtMs;
            paused = true;
            return;
          }
          const retryDelayMs = inboundRetryDelayMs(attempt, result.retryAfterMs);
          const retryAt = Date.now() + retryDelayMs;
          const quietUntil = pending.lastReceivedAtMs + this.debounceMs();
          pending.retryAtMs = Math.max(retryAt, quietUntil);
        });
        if (paused) await this.notifyRetryPaused(inbound.conversationId);
        return;
      }

      const reply = result?.text.trim() ?? "";
      if (!reply && !(result?.kind === "model_reply" && result.images?.length)) {
        if (consumeInFlight) {
          await this.mutateState(() => {
            delete this.state.inFlight;
          });
        }
        if (autoDeleteCommand) {
          await this.deleteMessage(inbound.conversationId, inbound.messageId);
        }
        return;
      }

      if (autoDeleteCommand) {
        try {
          const sentMessageIds = await this.delivery.sendTextCollectMessageIds(inbound.conversationId, reply);
          await this.deleteMessage(inbound.conversationId, inbound.messageId);
          await this.scheduleCommandReplyDeletion(inbound.conversationId, sentMessageIds);
        } catch (error) {
          console.error(
            "[telegram] slash command reply delivery failed:",
            error instanceof Error ? error.message : error,
          );
          await this.deleteMessage(inbound.conversationId, inbound.messageId);
        }
        return;
      }

      await this.prepareReply(
        inbound,
        { ...result!, text: reply },
        consumeInFlight,
      );
      await this.resumePendingReply();
    });
  }

  private async flushBuffered(): Promise<void> {
    if (!this.handler || this.processingBuffered) return;
    this.processingBuffered = true;
    try {
      const batch = await this.mutateState(() => {
        if (this.state.inFlight) {
          if (this.state.inFlight.retryPaused || (this.state.inFlight.retryAtMs ?? 0) > Date.now()) return undefined;
          return this.state.inFlight;
        }
        const current = this.state.queuedBuffers?.shift() ?? this.state.buffer;
        if (current) {
          this.state.inFlight = current;
          if (current === this.state.buffer) delete this.state.buffer;
        }
        return current;
      });
      if (!batch) return;

      try {
        await this.processImmediate(mergeBufferedBatch(batch), true);
      } catch (error) {
        let paused = false;
        await this.mutateState(() => {
          const pending = this.state.inFlight;
          if (!pending) return;
          const attempt = (pending.retryAttempts ?? 0) + 1;
          pending.retryAttempts = attempt;
          if (attempt >= MAX_AUTOMATIC_RETRY_ATTEMPTS) {
            pending.retryPaused = true;
            delete pending.retryAtMs;
            paused = true;
          } else {
            pending.retryAtMs = Date.now() + inboundRetryDelayMs(attempt);
          }
        });
        if (paused) await this.notifyRetryPaused(batch.chatId);
        throw error;
      }
    } finally {
      this.processingBuffered = false;
      this.scheduleBufferedFlush();
    }
  }

  private async prepareReply(inbound: InboundMessage, reply: Exclude<ReplyOutcome, { kind: "retry" | "pause" }>, consumeInFlight = false): Promise<void> {
    await this.mutateState(() => {
      this.state.pendingReply = {
        chatId: inbound.conversationId,
        senderId: inbound.senderId,
        ...reply,
      };
      if (consumeInFlight) delete this.state.inFlight;
    });
  }

  private async resumePendingReply(): Promise<void> {
    const pending = await this.mutateState(() => {
      const current = this.state.pendingReply;
      if (current) delete this.state.pendingReply;
      return current;
    });
    if (!pending) return;
    const reply = normalizePendingReply(pending);
    if (!reply.text && !(reply.kind === "model_reply" && reply.images?.length)) return;

    await deliverPreparedReply(this.api, reply, this.config,
      (target, text, onSent, nativeReply, strict) => this.sendText(target, text, onSent, nativeReply, strict),
      telegramAccountId(this.config.token));
  }

  private async collectAttachments(message: TelegramMessage): Promise<Attachment[]> {
    const candidates: Array<{ kind: AttachmentKind; file: TelegramFile | TelegramPhoto }> = [];
    const photo = largestPhoto(message.photo);
    if (photo) candidates.push({ kind: "image", file: photo });
    if (message.document) candidates.push({ kind: "document", file: message.document });
    if (message.audio) candidates.push({ kind: "audio", file: message.audio });
    if (message.voice) candidates.push({ kind: "voice", file: message.voice });
    if (message.video) candidates.push({ kind: "video", file: message.video });

    const attachments: Attachment[] = [];
    for (const candidate of candidates.slice(0, 4)) {
      try {
        const info = await this.api.getFile(candidate.file.file_id);
        if (!info.file_path) throw new Error("附件下载地址缺失");
        const maxBytes = this.config.maxMediaBytes ?? 20 * 1024 * 1024;
        if ((info.file_size ?? candidate.file.file_size ?? 0) > maxBytes) throw new Error("附件超过 20MB 限制");
        const bytes = await this.api.downloadFile(info.file_path, maxBytes);
        const typed = candidate.file as TelegramFile;
        attachments.push({ ...await this.config.mediaStore.save({
          channel: "telegram",
          kind: candidate.kind,
          bytes,
          fileName: typed.file_name ?? basename(info.file_path),
          mimeType: typed.mime_type,
          remoteId: candidate.file.file_id,
        }), ...(["voice","audio"].includes(candidate.kind) ? { sourceMessageId: String(message.message_id) } : {}),
          ...(typed.duration !== undefined ? { durationSeconds: typed.duration } : {}) });
      } catch (error) {
        attachments.push({ kind: candidate.kind, error: "附件下载失败、格式不支持或超过 20MB 限制，请缩小文件后重发。" });
      }
    }
    return attachments;
  }
}
