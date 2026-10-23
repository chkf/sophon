import { displayText, replyText, visibleSegments } from "../runtime/reply-segments.js";
import type { PlatformMessageFragment } from "../channels/types.js";
import { VoiceTurn, voiceTool, VOICE_TOOL, VoiceSupplementError } from "../voice/tool.js";
import { randomInt } from "node:crypto";
import { join } from "node:path";
import type { ActiveChannelRouter } from "../channels/active.js";
import type { HeartbeatConfig } from "../config/index.js";
import type { ChatRuntime } from "../runtime/types.js";
import type { SessionMessage, SessionStore } from "../sessions/store.js";
import { readSessionView } from "../sessions/view.js";
import type { LocalCoreContextProvider } from "../core/context.js";
import type { LocalKnowledgeStore } from "../knowledge/store.js";
import { readJsonFile, writeJsonAtomic } from "../util/atomic-json.js";
import {
  dateKey,
  heartbeatEligible,
  heartbeatFingerprint,
  isQuietTime,
  type HeartbeatState,
} from "./policy.js";
import { renderLocalContext } from "../core/render.js";
import { personaInstruction, type PersonaStore } from "../persona/store.js";
import { elapsedDescription, formatLocalTimestamp } from "../util/time-context.js";
import { basePlanningWindowOpen, isCurrentMorningPlan, localMinutes, nextDueWake, parseWakePlan } from "./planner.js";
import { recordDeliveredAssistant } from "../delivery/coordinator.js";

function recentConversationText(messages: SessionMessage[], timezone: string): string {
  return messages.slice(-6).map((message) => {
    const role = message.role === "user" ? "用户" : "Gateway";
    const content = message.content.replace(/\s+/g, " ").trim();
    const clipped = content.length > 600 ? content.slice(0, 600) + "…" : content;
    return "[" + formatLocalTimestamp(message.at, timezone) + "] " + role + "：" + clipped;
  }).join("\n");
}

export class HeartbeatRunner {
  private timer?: NodeJS.Timeout;
  private readonly statePath: string;
  private running = false;
  private pendingTick?: Promise<void>;

  constructor(
    dataDir: string,
    private readonly config: HeartbeatConfig,
    private readonly runtime: ChatRuntime,
    private readonly sessions: SessionStore,
    private readonly gateway: Pick<LocalCoreContextProvider, "load" | "peek">,
    private readonly router: ActiveChannelRouter,
    private readonly personas?: PersonaStore,
    private readonly paused: () => boolean | Promise<boolean> = () => false,
    _localKnowledge?: LocalKnowledgeStore,
    private readonly conversationQueue?: import("../util/serial-queue.js").SerialQueue,
    private readonly voiceAllowed?: () => Promise<boolean>,
  ) {
    this.statePath = join(dataDir, "heartbeat", "state.json");
  }

  private async routeView(channel: "telegram" | "wechat", target:string) {
    if (typeof this.sessions.sessionKey === "function") return readSessionView(this.sessions, channel, target);
    const latest=await this.sessions.latestConversation(channel);
    return latest?readSessionView(this.sessions,channel,latest.conversationId):undefined;
  }

  async start(): Promise<void> {
    if (!this.config.enabled || this.config.dailyCap <= 0) return;
    this.running = true;
    const now = new Date();
    const state = await this.loadState(now);
    const nextCheckTime = state.nextCheckAt ? new Date(state.nextCheckAt).getTime() : Number.NaN;
    const latestAllowed = now.getTime() + this.config.maxIntervalMinutes * 60_000;
    if (!this.config.planningEnabled && (!Number.isFinite(nextCheckTime) || nextCheckTime > latestAllowed)) {
      state.nextCheckAt = this.nextCheck(now).toISOString();
      await writeJsonAtomic(this.statePath, state);
    }
    this.schedule();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.pendingTick?.catch(() => undefined);
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.pendingTick = this.tick()
        .catch((error) => {
          console.error("[heartbeat] tick error:", error instanceof Error ? error.message : error);
        })
        .finally(() => { this.pendingTick = undefined; this.schedule(); });
    }, 60_000);
    this.timer.unref?.();
  }

  private nextCheck(now: Date): Date {
    const min = this.config.minIntervalMinutes * 60_000;
    const max = this.config.maxIntervalMinutes * 60_000;
    const delay = max === min ? min : randomInt(min, max + 1);
    return new Date(now.getTime() + delay);
  }

  private async loadState(now: Date): Promise<HeartbeatState> {
    const currentDate = dateKey(now, this.config.timezone);
    const state = await readJsonFile<HeartbeatState>(this.statePath, {
      dateKey: currentDate,
      sentToday: 0,
      recent: [],
    });
    if (state.dateKey !== currentDate) {
      state.dateKey = currentDate;
      state.sentToday = 0;
    }
    state.recent = state.recent.filter((item) => {
      const at = new Date(item.at).getTime();
      return Number.isFinite(at) && now.getTime() - at < 7 * 24 * 60 * 60_000;
    });
    return state;
  }

  private async flushPending(state: HeartbeatState, now: Date): Promise<void> {
    if (await this.paused()) return;
    const pending = state.pending;
    if (!pending) return;
    // Never defer an old evening message until the next morning after quiet hours.
    const preparedAt = new Date(pending.at).getTime();
    if (!Number.isFinite(preparedAt) || now.getTime() - preparedAt > 45 * 60_000) {
      delete state.pending;
      await writeJsonAtomic(this.statePath, state);
      return;
    }
    if (isQuietTime(now, this.config.timezone, this.config.quietStart, this.config.quietEnd)) return;

    if (!pending.channel) {
      delete state.pending;
      await writeJsonAtomic(this.statePath, state);
      return;
    }
    if (!(await this.router.isActive(pending.channel))) {
      delete state.pending;
      await writeJsonAtomic(this.statePath, state);
      return;
    }

    if (this.personas) {
      const show = (await this.personas.snapshot()).showStageDirections === true;
      if (pending.replySegments) {
        pending.replySegments = visibleSegments(pending.replySegments, show);
        pending.text = replyText(pending.replySegments);
      } else pending.text = displayText(pending.text, show);
    }
    // Reserve the attempt before touching the network. Proactive sends are intentionally
    // at-most-once: an ambiguous network failure must not cause the same message to be
    // replayed after restart or on the next heartbeat tick.
    state.sentToday += 1;
    state.lastSentAt = now.toISOString();
    state.recent.push({
      fingerprint: pending.fingerprint,
      at: now.toISOString(),
      text: pending.text,
    });
    delete state.pending;
    await writeJsonAtomic(this.statePath, state);

    try {
      const deliveryId = "heartbeat:" + pending.at;
      if (pending.images?.length) {
        const sent = await this.router.sendImagesIfActive(pending.channel, pending.target, pending.images, deliveryId);
        if (!sent) return;
      }
      if (pending.text) {
        let platformMessages: PlatformMessageFragment[] | undefined;
        const sent = await this.router.sendIfActive(pending.channel, pending.target, pending.text, pending.voiceText, fragments => { platformMessages = fragments; }, { deliveryId: deliveryId + ":text", at: now.toISOString(), ...(pending.replySegments ? {replySegments:pending.replySegments} : {}), ...(pending.channel==="telegram"&&pending.voiceText&&pending.voiceInstruction ? {voiceInstruction:pending.voiceInstruction} : {}) });
        if (!sent) return;
        await recordDeliveredAssistant(this.sessions, pending.channel, pending.target,
          pending.target, pending.text, undefined, deliveryId + ":text", now.toISOString(), { origin: "proactive" }, platformMessages);
      }
      if (pending.stickerIndex) {
        const sent = await this.router.sendStickerIfActive(pending.channel, pending.target, pending.stickerIndex);
        if (sent) await recordDeliveredAssistant(this.sessions, pending.channel, pending.target,
          pending.target, "[贴纸]", undefined, deliveryId + ":sticker", now.toISOString());
      }
    } catch (error) {
      if(error instanceof VoiceSupplementError) {
        await recordDeliveredAssistant(this.sessions,pending.channel,pending.target,pending.target,
          error.deliveredText,undefined,"heartbeat:"+pending.at+":text",now.toISOString(),{origin:"proactive",partial:true});
      }
      console.error(
        "[heartbeat] proactive delivery failed or is uncertain; not retrying to avoid duplicates:",
        error instanceof Error ? error.message : error,
      );
    }
  }


  /**
   * The persistent plan is only a set of opportunities. A new user message
   * invalidates its intents; the model decides again when a wake comes due.
   */
  private async plannedDue(now: Date, state: HeartbeatState): Promise<string | undefined> {
    // Do not create today's plan in the midnight–01:00 active window.
    // The first eligible wake at or after 07:00 starts the day's planning.
    if (!basePlanningWindowOpen(now, this.config.timezone)) return undefined;
    const today = dateKey(now, this.config.timezone);
    if (state.dateKey === today && state.sentToday >= this.config.dailyCap) return undefined;
    if (isQuietTime(now, this.config.timezone, this.config.quietStart, this.config.quietEnd)) return undefined;
    const route = await this.router.resolve();
    if (!route) return undefined;

    const view = await this.routeView(route.channel, route.target);
    const messages = view?.tail ?? [];
    const lastUser = view?.lastUser;
    const lastUserAt = lastUser?.at;
    let plan = state.plan;
    const stale = !isCurrentMorningPlan(plan, now, this.config.timezone) ||
      plan?.channel !== route.channel || plan?.lastUserAt !== lastUserAt;

    if (stale) {
      // Avoid planning around an unfinished burst of user messages.
      const sinceUserMs = lastUserAt ? now.getTime() - new Date(lastUserAt).getTime() : Infinity;
      if (sinceUserMs >= 0 && sinceUserMs < 10 * 60_000) return undefined;
      const lastAttempt = state.planAttemptAt ? new Date(state.planAttemptAt) : undefined;
      const attemptedThisMorning = lastAttempt && Number.isFinite(lastAttempt.getTime()) &&
        dateKey(lastAttempt, this.config.timezone) === today &&
        basePlanningWindowOpen(lastAttempt, this.config.timezone);
      const lastAttemptMs = lastAttempt ? now.getTime() - lastAttempt.getTime() : Infinity;
      if (attemptedThisMorning && lastAttemptMs >= 0 && lastAttemptMs < 20 * 60_000) return undefined;

      const context = await this.gateway.load();
      if (!context.available) return undefined;
      state.planAttemptAt = now.toISOString();
      await writeJsonAtomic(this.statePath, state);

      try {
        const response = await this.runtime.reply({
          sessionId: "heartbeat-planner",
          purpose: "heartbeat_plan",
          text: "为今天剩余时间提出主动聊天的候选唤醒计划。",
          operationId: "heartbeat-plan:" + now.toISOString(),
          imageOutputAllowed: route.channel === "telegram",
          instructions: [
            "你正在为今天剩余时间安排 Gateway 主动聊天的候选唤醒机会，不是在发送消息。",
            "无合适时间返回 {\"wakes\":[]}。只返回 JSON 对象：{\"wakes\":[{\"time\":\"HH:MM\",\"intent\":\"简短的唤醒原因\"}]}，不要其他文字。",
            "时间均为 " + this.config.timezone + " 本地时间。现在：" + formatLocalTimestamp(now, this.config.timezone) + "。",
            "候选时间必须晚于当前时间至少 20 分钟，避免 " + this.config.quietStart + "–" + this.config.quietEnd + " 免打扰时段。",
            "今天最多安排 " + Math.min(8, this.config.dailyCap + 2) + " 次候选；它们不保证实际发送消息。",
            "根据可靠的本地 Recent、近期对话和用户明确配置的作息规划；缺少记录不代表空闲。",
            "尽量包括少量可以无任务闲聊的机会，不要全是复习、吃饭、睡觉提醒。",
            "候选间隔至少 45 分钟，用户近期明确不希望打扰时可以返回空数组；用户已有回答或刚问过不要重复问。",
            "不要编造事件、安排或经历；这里只提出候选理由，不决定实际聊天内容。",
            "最近会话末尾：\n" + (recentConversationText(messages, this.config.timezone) || "没有历史消息。"),
            renderLocalContext(context),
            ...(this.personas && !context.data?.persona ? [personaInstruction(await this.personas.snapshot())] : []),
          ].join("\n"),
        });
        if (response.skipped) return undefined;
        plan = parseWakePlan(response.text, now, this.config.timezone, this.config.quietStart,
          this.config.quietEnd, this.config.dailyCap, route.channel, lastUserAt);
      } catch (error) {
        console.error("[heartbeat] daily planning failed; retry at next planning window:",
          error instanceof Error ? error.message : error);
        return undefined;
      }
      state.plan = plan;
      await writeJsonAtomic(this.statePath, state);
    }

    const due = nextDueWake(plan!, now, this.config.timezone);
    const currentMinute = localMinutes(now, this.config.timezone);
    // Consume all passed slots durably, including stale slots missed during downtime.
    let changed = false;
    for (const wake of plan!.wakes) {
      const minute = Number(wake.time.slice(0, 2)) * 60 + Number(wake.time.slice(3, 5));
      if (!wake.consumed && minute <= currentMinute) {
        wake.consumed = true;
        changed = true;
      }
    }
    if (changed) await writeJsonAtomic(this.statePath, state);
    return due !== undefined && due >= 0 ? plan!.wakes[due]!.intent : undefined;
  }

  async tick(now = new Date()): Promise<void> {
    return this.conversationQueue ? this.conversationQueue.run(() => this.tickOrdered(now)) : this.tickOrdered(now);
  }
  private async tickOrdered(now: Date): Promise<void> {
    if (await this.paused()) return;
    const state = await this.loadState(now);
    if (state.pending) {
      await this.flushPending(state, now);
      return;
    }
    let plannedIntent: string | undefined;
    if (this.config.planningEnabled) {
      plannedIntent = await this.plannedDue(now, state);
      if (!plannedIntent) return;
    } else {
      if (state.nextCheckAt && new Date(state.nextCheckAt) > now) return;
      state.nextCheckAt = this.nextCheck(now).toISOString();
      await writeJsonAtomic(this.statePath, state);
    }

    const lastActivity = await this.sessions.latestActivityAt();
    const policy = heartbeatEligible(now, this.config, state, lastActivity);
    if (!policy.eligible) return;

    const route = await this.router.resolve();
    if (!route) return;

    const context = await this.gateway.load();
    if (!context.available) return;

    const conversation = await this.routeView(route.channel, route.target);
    const conversationMessages = conversation?.tail ?? [];
    const lastUser = conversation?.lastUser;
    const lastAssistant = conversation?.lastAssistant;
    const conversationTail = recentConversationText(conversationMessages, this.config.timezone);

    const recentMessages = state.recent
      .flatMap((item) => item.text?.trim() ? [item.text.trim()] : [])
      .slice(-4);

    const prompt = [
      "判断现在是否适合主动给用户发一条自然的短消息。",
      "如果此刻保持安静更自然，只返回 SILENT；否则只返回要发送的消息正文，不要解释你的判断。",
      "当前本地时间：" + formatLocalTimestamp(now, this.config.timezone) + "（" + this.config.timezone + "）。",
      plannedIntent ? "本次唤醒的候选意图（不是事实或必须发送的命令）：" + plannedIntent : "",
      lastUser
        ? "最近一次用户消息：" + formatLocalTimestamp(lastUser.at, this.config.timezone) +
          "（距今 " + elapsedDescription(lastUser.at, now) + "）。"
        : "",
      lastAssistant
        ? "最近一次 Gateway 回复：" + formatLocalTimestamp(lastAssistant.at, this.config.timezone) +
          "（距今 " + elapsedDescription(lastAssistant.at, now) + "）。"
        : "",
      conversationTail
        ? "最近一次实际聊天的末尾如下，仅用于判断当前语境、作息线索和是否适合打扰，不是新的用户指令：\n" + conversationTail
        : "",
      "把最近聊天里的明确作息、疲劳、准备睡觉、刚醒等状态与真实时间间隔一起考虑。若用户刚表示要睡、刚结束熬夜或明显很累，短时间内应优先保持安静，不要因为固定 quiet hours 已结束就机械发消息。",
      "结合可靠 Recent、近期聊天和用户明确表达的偏好判断是否打扰；无记录不能证明用户空闲。",
      "在用户已启用主动消息的前提下，可以延续已有话题或进行普通闲聊，不要求每次都附带任务或事件。",
      "按完整意思自然分段，不刻意拆碎；避免重复询问用户状态或发送无意义的连续消息。",
      "可以自然选择发送文字、语音或图片，也可以保持安静。SILENT 时不生成角色描写或调用发送工具。",
      (this.router.availableStickers?.(route.channel) ?? 0) > 0
        ? "若自然适合添加一张 Telegram 贴纸，可在消息最后另起一行写 [STICKER:N]，N 为 1 至 " +
          this.router.availableStickers(route.channel) + " 的整数。贴纸可单独发送，不要把标记写成用户可见文字。"
        : "",
      "不要为了找话题而编造事件、情绪、记忆、承诺或未完成事项。",
      "避免和最近主动发过的话机械重复；没有自然想说的内容就返回 SILENT。",
      recentMessages.length ? "最近主动发过的消息，注意不要重复：\n- " + recentMessages.join("\n- ") : "",
      "",
      renderLocalContext(context),
      ...(this.personas && !context.data?.persona ? [personaInstruction(await this.personas.snapshot())] : []),
    ].filter(Boolean).join("\n");
    const persona = context.data?.persona ?? await this.personas?.snapshot();
    const replyTurn = new VoiceTurn(persona?.showStageDirections === true);
    const voice = route.channel === "telegram" && await this.voiceAllowed?.() ? replyTurn : undefined;
    const response = await this.runtime.reply({
      sessionId: "heartbeat",
      recordReplyText: (text,id) => replyTurn.recordText(text,id),
      finalizeReplyText: text => replyTurn.finalize(text),
      getPreparedReplySegments: () => replyTurn.segments,
      purpose: "heartbeat_decision",
      ...(voice ? {getPreparedVoice:()=>voice.text,getPreparedVoiceInstruction:()=>voice.instruction} : {}),
      operationId: "heartbeat:" + now.toISOString(),
      text: "进行一次主动消息判断。",
      imageOutputAllowed: route.channel === "telegram",
      instructions: prompt+(voice ? "\n"+voice.guidance+"\nTelegram 主动语音已启用，按情境自由选择，尊重近期明确偏好；决定静默时不要调用。" : ""),
      ...(voice ? { tools: [voiceTool], executeTool: async (name: string, args: Record<string, unknown>) => {
        if (name !== VOICE_TOOL) throw new Error("本轮未授权该工具。");
        return voice.select(args);
      } } : {}),
    });
    if (!response.replySegments && voice && response.voiceText && !voice.text) voice.select({text:response.voiceText,...(response.voiceInstruction?{instruction:response.voiceInstruction}:{})});
    const images = response.images?.slice(0, 1);
    const rawText = response.text.trim();
    const stickerMatch = rawText.match(/(?:^|\n)\[STICKER:(\d+)\]\s*$/i);
    const count = this.router.availableStickers?.(route.channel) ?? 0;
    const requestedIndex = stickerMatch ? Number(stickerMatch[1]) : 0;
    const stickerIndex = Number.isSafeInteger(requestedIndex) && requestedIndex >= 1 &&
      requestedIndex <= count ? requestedIndex : undefined;
    const cleaned = stickerMatch ? rawText.slice(0, stickerMatch.index).trim() : rawText;
    const silent=displayText(cleaned,false).toUpperCase() === "SILENT";
    if (silent) return;
    if (response.replySegments) replyTurn.restore(response.replySegments, Boolean(voice));
    else replyTurn.combine(cleaned);
    // Sticker control tokens are never a delivered text fragment.
    const replySegments = replyTurn.segments.map(part=>({...part, text:part.text.replace(/(?:^|\n)\[STICKER:\d+\]\s*$/i, "").trim()})).filter(part=>part.text);
    const text = replyText(replySegments);
    if (!text && !images?.length && !stickerIndex) return;

    const fingerprint = heartbeatFingerprint(text + (images?.[0]?.sha256 ?? "") + (stickerIndex ? ":sticker:" + stickerIndex : ""));
    if (state.recent.some((item) => item.fingerprint === fingerprint)) return;

    state.pending = {
      fingerprint,
      text,
      replySegments,
      ...(images?.length ? { images } : {}),
      ...(stickerIndex ? { stickerIndex } : {}),
      target: route.target,
      channel: route.channel,
      at: now.toISOString(),
    };
    await writeJsonAtomic(this.statePath, state);
    await this.flushPending(state, now);
  }
}
