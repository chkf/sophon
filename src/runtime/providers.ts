import { ProviderDeliveryStore, type BoundDeliveryTicket } from "./delivery-store.js";
import { replyWithPaidImages } from "./image-decorator.js";
import { SerialQueue } from "../util/serial-queue.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../util/atomic-json.js";
import { requestMessages } from "./request.js";
import { tagInboundRetryability } from "./retry-policy.js";
import type { ChatRequest, ChatResponse, ContextMaintenanceRequest, DeliverySettlementOptions, ManagedChatRuntime, ProviderId, RuntimeModelSelection } from "./types.js";

interface Selection {
  provider: ProviderId;
  epoch: number;
  /** Model-specific SIWC generation IDs stay reserved; retired contexts rebuild from history. */
  activeSiwcModel?: string;
  siwcEpochByModel?: Record<string, number>;
  nextEpoch?: number;
}

/** Transport state belongs to a provider/generation; the SessionStore remains shared. */
export class ProviderRuntime implements ManagedChatRuntime {
  private readonly path: string;
  private readonly deliveryStore: ProviderDeliveryStore;
  private readonly operations = new SerialQueue();
  constructor(dataDir: string, private readonly providers: Record<"siwc" | "openrouter", ManagedChatRuntime> & Partial<Record<"api", ManagedChatRuntime>>, private readonly initial: ProviderId = "siwc") {
    this.path = join(dataDir, "runtime", "provider.json");
    this.deliveryStore = new ProviderDeliveryStore(this.path + ".deliveries");
  }
  private runtime(provider: ProviderId): ManagedChatRuntime {
    const runtime = this.providers[provider];
    if (!runtime) throw new Error("Provider unavailable; refusing fallback.");
    return runtime;
  }
  private async imageRuntime(): Promise<ManagedChatRuntime> {
    return this.runtime((await this.state()).provider === "api" ? "api" : "openrouter");
  }
  private async state(): Promise<Selection> {
    const state = await readJsonFile<Selection>(this.path, { provider: this.initial, epoch: 0 });
    if (!["siwc", "openrouter", "api"].includes(state.provider) || !Number.isSafeInteger(state.epoch) || state.epoch < 0) throw new Error("Provider state is invalid; refusing paid fallback.");
    if (state.siwcEpochByModel && (typeof state.siwcEpochByModel !== "object" ||
      Object.entries(state.siwcEpochByModel).some(([model, epoch]) =>
        !model || !Number.isSafeInteger(epoch) || epoch < 0))) {
      throw new Error("SIWC model checkpoint generation map is invalid.");
    }
    return state;
  }
  private generation(state: Selection, model: string): Selection {
    const map = { ...state.siwcEpochByModel };
    if (state.activeSiwcModel && map[state.activeSiwcModel] === undefined && state.provider === "siwc") {
      map[state.activeSiwcModel] = state.epoch;
    }
    if (map[model] === undefined) {
      const next = state.activeSiwcModel || Object.keys(map).length
        ? Math.max(state.nextEpoch ?? state.epoch, state.epoch, ...Object.values(map)) + 1
        : state.epoch; // migration of an existing legacy SIWC lane
      map[model] = next;
    }
    return { ...state, epoch: map[model], nextEpoch: Math.max(state.nextEpoch ?? 0, state.epoch, ...Object.values(map)),
      activeSiwcModel: model, siwcEpochByModel: map };
  }
  private async resolvedState(): Promise<Selection> {
    const state = await this.state();
    if (state.provider !== "siwc") return state;
    if (!this.providers.siwc.getModelSelection) return state;
    const model = (await this.providers.siwc.getModelSelection()).resolvedModel;
    if (!model) return state;
    const next = this.generation(state, model);
    if (JSON.stringify(next) !== JSON.stringify(state)) await writeJsonAtomic(this.path, next);
    return next;
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.operations.run(work);
  }
  async getProvider(): Promise<ProviderId> { return (await this.state()).provider; }
  /** Validate an explicit paid test model without touching persistent selection. */
  async validateTestModel(model: string, provider?: ProviderId): Promise<{ model: string; supportsTools: boolean }> {
    const chosen = provider ?? ((await this.state()).provider === "api" ? "api" : "openrouter");
    const runtime = this.runtime(chosen);
    if (chosen === "siwc" || !runtime.validateTestModel) throw new Error("当前 Provider 不支持 API 模型测试。");
    const session = await runtime.getSession();
    if (session.status !== "connected" || !session.sharing) throw new Error("Provider 未配置或不可用。");
    return runtime.validateTestModel(model);
  }
  async diagnosticModels(provider: ProviderId) {
    return this.runtime(provider).listModels();
  }
  async diagnosticReply(provider: ProviderId, model: string, kind: "text" | "tools" | "vision" | "image"): Promise<string> {
    const runtime=this.runtime(provider);
    if (kind === "image") {
      if(provider!=="openrouter" || !runtime.generateImage) throw new Error("生图诊断仅支持 OpenRouter。");
      const image=await runtime.generateImage({operationId:"diagnostic:"+randomUUID(),prompt:"纯白背景上的一个红色圆形，无文字。",autonomous:false});
      if(!image.images?.length) throw new Error("没有返回有效图片。");
      return "已生成并验证图片；模型："+image.model;
    }
    if (provider === "api") await runtime.validateTestModel?.(model);
    else if(!(await runtime.listModels()).some(m=>m.id===model))throw new Error("模型已不可用，请刷新列表。");
    let toolCalled=false;
    const sessionId="diagnostic:"+randomUUID();
    const dir=kind==="vision"?await mkdtemp(join(tmpdir(),"gateway-diagnostic-")):undefined;
    try {
      if(dir) await writeFile(join(dir,"sample.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHh0AAAAASUVORK5CYII=","base64"));
      const response=await runtime.reply({purpose:"diagnostic",sessionId,stateful:true,ephemeral:true,
        testModel:model,testHistoryTokens:2048,maxToolRounds:2,
        text:kind==="tools"?"请调用 diagnostic_echo 工具，然后只回复检测成功。":kind==="vision"?"请确认你是否能读取附图，并简短描述。":"请只回复：连接成功。",
        ...(dir?{attachments:[{kind:"image" as const,path:join(dir,"sample.png"),mimeType:"image/png"}]}:{}),
        ...(kind==="tools"?{tools:[{name:"diagnostic_echo",description:"返回诊断成功标记，不读写任何用户数据。",readOnly:true,parameters:{type:"object",properties:{},additionalProperties:false}}],
          executeTool:async(name:string)=>{if(name!=="diagnostic_echo")throw new Error("未知诊断工具。");toolCalled=true;return {ok:true};}}:{}),
      });
      if(!response.text.trim() || response.skipped)throw new Error("没有有效模型回复。");
      if(kind==="tools" && !toolCalled)throw new Error("模型未实际调用诊断工具。");
      return "模型："+(response.model??model)+"\n"+response.text.slice(0,500)+(kind==="vision"?"\n已验证图片请求可完成；不代表视觉理解准确率。":"");
    } finally {await runtime.resetSession?.(sessionId);if(dir)await rm(dir,{recursive:true,force:true});}
  }
  async getUsage() {
    const runtime = this.runtime((await this.state()).provider);
    return runtime.getUsage ? runtime.getUsage() : { supported: false };
  }
  async providerStatus() {
    return Promise.all((Object.keys(this.providers) as ProviderId[]).map(async (provider) => {
      try {
        const session = await this.runtime(provider).getSession();
        return { provider, available: session.status === "connected" && session.sharing };
      } catch { return { provider, available: false }; }
    }));
  }
  async selectProvider(provider: ProviderId): Promise<void> {
    return this.exclusive(async () => {
      const runtime = this.runtime(provider);
      const session = await runtime.getSession();
      if (session.status !== "connected" || !session.sharing) throw new Error("Provider unavailable.");
      await runtime.getModelSelection();
      const previous = await this.state();
      if (previous.provider === provider) return;
      if (provider === "siwc") {
        const model = (await runtime.getModelSelection()).resolvedModel;
        if (!model) throw new Error("SIWC model selection unavailable.");
        const original = previous.provider === "siwc" ? this.generation(previous, previous.activeSiwcModel ?? model) : previous;
        await writeJsonAtomic(this.path, this.generation({ ...original, provider: "siwc" }, model));
      } else {
        const oldModel = previous.provider === "siwc"
          ? (await this.providers.siwc.getModelSelection()).resolvedModel : undefined;
        const saved = oldModel ? this.generation(previous, oldModel) : previous;
        const epoch = Math.max(saved.nextEpoch ?? saved.epoch, saved.epoch) + 1;
        await writeJsonAtomic(this.path, { ...saved, provider, epoch, nextEpoch: epoch });
      }
    });
  }
  async getImageSettings() {
    const runtime = await this.imageRuntime();
    if (!runtime.getImageSettings) throw new Error("生图设置不可用。");
    return runtime.getImageSettings();
  }
  async selectImageModel(model: string) {
    return this.exclusive(async () => {
      const runtime = await this.imageRuntime();
      if (!runtime.selectImageModel) throw new Error("生图设置不可用。");
      return runtime.selectImageModel(model);
    });
  }
  async selectImageRoute(route: "provider" | "openrouter") {
    return this.exclusive(async () => {
      const runtime = await this.imageRuntime();
      if (!runtime.selectImageRoute) throw new Error("生图路线不可用。");
      return runtime.selectImageRoute(route);
    });
  }
  async setProactiveImages(enabled: boolean) {
    return this.exclusive(async () => {
      const runtime = await this.imageRuntime();
      if (!runtime.setProactiveImages) throw new Error("生图设置不可用。");
      return runtime.setProactiveImages(enabled);
    });
  }
  async signIn(options?: { reconsent?: boolean }) { return this.runtime((await this.state()).provider).signIn(options); }
  async getSession() { return this.runtime((await this.state()).provider).getSession(); }
  async listModels() { return this.runtime((await this.state()).provider).listModels(); }
  async getModelSelection() { return this.runtime((await this.state()).provider).getModelSelection(); }
  async selectModel(model?: string, expectedProvider?: ProviderId): Promise<RuntimeModelSelection> {
    return this.exclusive(async () => {
      const state = await this.resolvedState();
      if (expectedProvider && state.provider !== expectedProvider) throw new Error("Provider changed; refresh and confirm again.");
      if (state.provider !== "siwc") {
        const epoch = Math.max(state.epoch, state.nextEpoch ?? 0) + 1;
        await writeJsonAtomic(this.path, { ...state, epoch, nextEpoch: epoch });
        return this.runtime(state.provider).selectModel(model);
      }
      const available = await this.providers.siwc.listModels();
      const target = !model || model === "auto" ? available[0]?.id : model;
      if (!target || !available.some(item => item.id === target)) throw new Error("Selected SIWC model is unavailable.");
      const next = this.generation(state, target);
      // Reserve the correct existing model lane BEFORE switching its selection;
      // a crash cannot reuse a checkpoint under an incompatible model name.
      await writeJsonAtomic(this.path, next);
      try { return await this.providers.siwc.selectModel(model); }
      catch (error) { await writeJsonAtomic(this.path, state); throw error; }
    });
  }
  maintainContext(request: ContextMaintenanceRequest): Promise<{ compacted: boolean; skipped?: string }> {
    return this.exclusive(async () => {
      const state = await this.state();
      if (state.provider !== "siwc") return { compacted: false, skipped: "provider" };
      if (await this.deliveryStore.read(request.sessionId)) return { compacted: false, skipped: "pending_delivery" };
      const sessionId = state.epoch === 0 ? request.sessionId : request.sessionId + ":provider:siwc:" + state.epoch;
      return this.providers.siwc.maintainContext?.({ ...request, sessionId }) ?? { compacted: false, skipped: "unsupported" };
    });
  }
  async listMemoryModels(): Promise<import("./types.js").RuntimeModel[]> { return this.providers.siwc.listModels(); }
  async getMemoryModel(): Promise<string> {
    if (!this.providers.siwc.getMemoryModel) throw new Error("记忆模型设置不可用。");
    return this.providers.siwc.getMemoryModel();
  }
  async selectMemoryModel(model: string): Promise<string> {
    if (!this.providers.siwc.selectMemoryModel) throw new Error("记忆模型设置不可用。");
    return this.providers.siwc.selectMemoryModel(model);
  }
  async runMemoryTask(task: import("../memory/tasks.js").MemoryTask,input: string): Promise<string> {
    const runtime=this.providers.siwc;
    if(!runtime.runMemoryTask)throw new Error("SIWC 记忆整理能力不可用。");
    return runtime.runMemoryTask(task,input);
  }
  async classifyMemory(input: string): Promise<string> {
    const siwc = this.providers.siwc;
    if (!siwc.classifyMemory) throw new Error("SIWC 记忆分类能力不可用。");
    return siwc.classifyMemory(input);
  }
  async reply(request: ChatRequest): Promise<ChatResponse> {
    requestMessages(request);
    if (request.purpose === "memory_classify") throw new Error("记忆分类仅可通过独立 SIWC 入口执行。");
    return this.exclusive(async () => {
      if (request.ephemeral && request.testAuthorized?.() === false) throw new Error("测试配置已变更，本轮请求已取消，未调用付费模型。");
      if (request.testProvider !== undefined && (!request.ephemeral || request.purpose !== "chat")) {
        throw new Error("临时 Provider 只能用于隔离的测试对话。");
      }
      if ((request.testModel !== undefined || request.testHistoryTokens !== undefined) && !request.ephemeral) {
        throw new Error("临时模型与上下文设置不能用于正式会话。");
      }
      const state = request.testProvider ? { provider: request.testProvider, epoch: 0 } : await this.resolvedState();
      const runtime = this.runtime(state.provider);
      if ((request.testProvider === "openrouter" || request.testProvider === "api") && !request.testModel) throw new Error("请先发送 /testmode model <model_id> 明确授权付费模型。");
      if (request.testModel && request.testProvider !== "openrouter" && request.testProvider !== "api") throw new Error("测试模型仅支持 API 或 OpenRouter。");
      const id = state.provider === "siwc" && state.epoch === 0
        ? request.sessionId : request.sessionId + ":provider:" + state.provider + ":" + state.epoch;
      if (request.ephemeral && request.deferAssistantCommit === true) throw new Error("临时会话禁止持久化交付票据。");
      const deferred = !request.ephemeral && request.purpose === "chat" && request.deferAssistantCommit === true;
      const previous = !request.ephemeral && request.purpose === "chat" ? await this.deliveryStore.read(request.sessionId) : undefined;
      if (previous?.recordPending) {
        // Another owner channel may enqueue a turn while an acknowledged send
        // still needs its transcript write. Keep that ticket and receipt bound
        // to the original provider, without generating or spending again.
        throw tagInboundRetryability(new Error("先前回复的历史保存尚未完成，等待渠道回执结算后再处理新消息。"), true);
      }
      if (deferred && previous) {
        if (previous.version !== 2) {
          await this.deliveryStore.archiveLegacy(request.sessionId);
          await this.runtime(previous.provider).resetSession?.(previous.id);
        } else {
          await this.runtime(previous.provider).resetSession?.(previous.id, previous.deliveryId);
          await this.deliveryStore.remove(request.sessionId);
        }
      }
      const deliveryId = request.deliveryId ?? randomUUID();
      const ticket: BoundDeliveryTicket = { version: 2, provider: state.provider, id, deliveryId, sessionId: request.sessionId };
      if (deferred) await this.deliveryStore.write(request.sessionId, ticket);
      const turn = { ...request, sessionId: id, ...(deferred ? { deliveryId } : {}) };
      try {
        const response = state.provider === "siwc" && !request.ephemeral ? await replyWithPaidImages(runtime, this.providers.openrouter, turn) : await runtime.reply(turn);
        return deferred ? { ...response, deliveryId } : response;
      } catch (error) {
        if (deferred) {
          await runtime.resetSession?.(id, deliveryId);
          await this.deliveryStore.remove(request.sessionId);
        }
        throw error;
      }
    });
  }
  editHistory(sessionId: string, work: () => Promise<void>): Promise<void> {
    return this.exclusive(async () => {
      if (await this.deliveryStore.read(sessionId)) throw new Error("当前回复尚未完成交付，请稍后再删除记录。");
      if (!this.providers.siwc.editHistory) throw new Error("历史编辑尚未就绪。");
      await this.providers.siwc.editHistory(sessionId, work);
    });
  }
  settleSessionDelivery(sessionId: string, deliveryId: string, text: string | undefined, record: () => Promise<void>, options?: DeliverySettlementOptions): Promise<boolean> {
    return this.settleDelivery(sessionId, deliveryId, text, record, options?.durableReceipt === true);
  }
  private settleDelivery(sessionId: string, deliveryId: string, text: string | undefined, record?: () => Promise<void>, durableReceipt = false): Promise<boolean> {
    return this.exclusive(async () => {
      const ticket = await this.deliveryStore.read(sessionId);
      if (!deliveryId || ticket?.version !== 2 || ticket.deliveryId !== deliveryId || ticket.sessionId !== sessionId) return false;
      // Only the durable channel's recording callback can recover this ticket;
      // a bare commit/reset or an unrelated channel acknowledgement cannot.
      if (ticket.recordPending && (!record || !durableReceipt)) return false;
      const runtime = this.runtime(ticket.provider);
      const settle = async () => {
        if (text === undefined) await runtime.resetSession?.(ticket.id, deliveryId);
        else await runtime.commitSession?.(ticket.id, text, deliveryId);
        await this.deliveryStore.remove(sessionId);
      };
      if (durableReceipt && record) {
        await this.deliveryStore.write(sessionId, { ...ticket, recordPending: true });
        await record();
        // A durable receipt retries either failure after restart. SessionStore
        // deduplicates successful transcript writes by deliveryId.
        await settle();
      } else {
        // Telegram and legacy iLink do not keep a replayable acknowledgement.
        // Preserve their existing settlement even if transcript recording fails.
        try { await record?.(); }
        finally { await settle(); }
      }
      return true;
    });
  }
  commitSession(sessionId: string, text: string, deliveryId?: string): Promise<boolean> {
    return this.settleDelivery(sessionId, deliveryId ?? "", text);
  }
  resetSession(sessionId: string, deliveryId?: string): Promise<boolean | void> {
    if (deliveryId) return this.settleDelivery(sessionId, deliveryId, undefined);
    return this.exclusive(async () => {
      if (await this.deliveryStore.read(sessionId)) return false;
      const state = await this.state();
      const id = state.provider === "siwc" && state.epoch === 0 ? sessionId : sessionId + ":provider:" + state.provider + ":" + state.epoch;
      return this.runtime(state.provider).resetSession?.(id);
    });
  }
  async close(): Promise<void> {
    await this.exclusive(async () => {
      const results = await Promise.allSettled(Object.values(this.providers).map(provider => provider?.close?.()));
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Provider shutdown failed.");
    });
  }
}

/** API providers can start without loading the optional SIWC SDK or credentials. */
export function lazyRuntime(factory: () => Promise<ManagedChatRuntime>): ManagedChatRuntime {
  let promise: Promise<ManagedChatRuntime> | undefined;
  const get = () => promise ??= factory().catch(error => { promise = undefined; throw error; });
  return {
    signIn: async options => (await get()).signIn(options),
    getSession: async () => (await get()).getSession(),
    listModels: async () => (await get()).listModels(),
    getModelSelection: async () => (await get()).getModelSelection(),
    validateTestModel: async model => { const runtime = await get(); if (!runtime.validateTestModel) throw new Error("临时 OpenRouter 模型验证不可用。"); return runtime.validateTestModel(model); },
    selectModel: async model => (await get()).selectModel(model),
    reply: async request => (await get()).reply(request),
    listMemoryModels: async () => (await get()).listModels(),
    getMemoryModel: async () => { const runtime=await get(); if (!runtime.getMemoryModel) throw new Error("记忆模型设置不可用。"); return runtime.getMemoryModel(); },
    selectMemoryModel: async model => { const runtime=await get(); if (!runtime.selectMemoryModel) throw new Error("记忆模型设置不可用。"); return runtime.selectMemoryModel(model); },
    runMemoryTask: async (task,input) => { const runtime=await get(); if(!runtime.runMemoryTask)throw new Error("SIWC 记忆整理能力不可用。"); return runtime.runMemoryTask(task,input); },
    classifyMemory: async input => { const runtime=await get(); if (!runtime.classifyMemory) throw new Error("SIWC 记忆分类能力不可用。"); return runtime.classifyMemory(input); },
    maintainContext: async request => (await get()).maintainContext?.(request) ?? { compacted: false, skipped: "unsupported" },
    commitSession: async (id, text, deliveryId) => (await get()).commitSession?.(id, text, deliveryId),
    editHistory: async (id, work) => { if (!promise) return work(); const runtime = await promise; if (!runtime.editHistory) throw new Error("历史编辑尚未就绪。"); await runtime.editHistory(id, work); },
    resetSession: async (id, deliveryId) => (await get()).resetSession?.(id, deliveryId),
    // Do not initialize an unused provider just to close a CLI runtime.
    close: async () => {
      if (promise) await (await promise).close?.();
    },
  };
}
