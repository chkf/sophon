import { FUNCTION_CALL_GUIDANCE } from "./responses/tools.js";
import { assertRequestBudget, estimatedTextTokens, historyWindow, OPENROUTER_LIMITS } from "./context-budget.js";
import { ImageGenerationService } from "./images/service.js";
import { safeToolOutput } from "./tool-output.js";
import { ImageTool, IMAGE_TOOL } from "./images/tool.js";
import { OpenRouterError, safeOpenRouterFailure } from "./openrouter-error.js";
import { ApiError } from "./api-error.js";
import { SerialQueue } from "../util/serial-queue.js";
import { createHash } from "node:crypto";
import { blockTextualToolCall } from "./tool-call-integrity.js";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../util/atomic-json.js";
import type { ChatRequest, ChatResponse, ChatUsage, ImageGenerationRequest, ImageSettings, ManagedChatRuntime, RuntimeImage, RuntimeModel, RuntimeModelSelection, RuntimeSession } from "./types.js";
import { attachmentData } from "./openrouter-media.js";
import { readChatStream } from "./openrouter-stream.js";
import { isBackground, requestMessages } from "./request.js";
import { withHistoryTool } from "./history-tool.js";
import { historyFromMessages } from "./history.js";
import { safeTraceStart, safeTraceFinish } from "../observability/runtime-trace.js";
import { reportedTraceUsage, traceContent, tracedToolStatus } from "./trace-content.js";

export interface OpenRouterConfig {
  dataDir: string; apiKey?: string; defaultModel?: string; imageModel?: string; timezone?: string;
  webSearch?: boolean; heartbeat?: boolean;
  fetch?: typeof fetch;
}
export interface ApiConfig {
  baseUrl?: string; apiKey?: string; defaultModel?: string; contextWindow?: number;
  vision?: boolean; heartbeat?: boolean; stream?: boolean;
}
interface SharedConfig extends OpenRouterConfig, ApiConfig {}
interface Model extends RuntimeModel { input: string[]; output: string[]; parameters: string[]; contextLength: number }
interface TurnRecord { status: "started" | "completed" | "failed"; response?: ChatResponse; images?: RuntimeImage[]; usage?: ChatUsage; error?: string }

/** Dedicated Chat Completions client. Never carries SIWC response IDs or opaque state. */
export class ChatCompletionsRuntime implements ManagedChatRuntime {
  private readonly fetcher: typeof fetch;
  private pendingModels?: Promise<Model[]>;
  private pendingSession?: Promise<RuntimeSession>;
  private models?: { at: number; values: Model[] };
  private readonly operations = new SerialQueue();
  private readonly images?: ImageGenerationService;
  constructor(private readonly config: SharedConfig, private readonly provider: "api" | "openrouter") {
    this.fetcher = config.fetch ?? fetch;
    if (provider === "openrouter") this.images = new ImageGenerationService(config, (path, body) => this.request(path, body),
      async () => (await this.getSession()).status === "connected", raw => this.usage(raw));
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.operations.run(work);
  }
  async getImageSettings(): Promise<ImageSettings> {
    return this.images ? this.images.getImageSettings() : { route: "provider", proactive: false, dailyLimit: 0 };
  }
  private imageService(): ImageGenerationService {
    if (!this.images) throw this.failure("通用 API 不支持内建生图；没有请求其他 Provider。");
    return this.images;
  }
  async selectImageModel(choice: string) { return this.imageService().selectImageModel(choice); }
  async selectImageRoute(route: "provider" | "openrouter") { return this.imageService().selectImageRoute(route); }
  async setProactiveImages(enabled: boolean) { return this.imageService().setProactiveImages(enabled); }
  async canGenerateImage(autonomous: boolean) { return this.images ? this.images.canGenerateImage(autonomous) : false; }
  async generateImage(request: ImageGenerationRequest) { return this.imageService().generateImage(request); }
  private failure(message: string, diagnostic?: ConstructorParameters<typeof OpenRouterError>[1]): Error {
    return this.provider === "api"
      ? new ApiError(message.replaceAll("OpenRouter", "API").replaceAll("OPENROUTER_DEFAULT_MODEL", "GATEWAY_API_MODEL"))
      : new OpenRouterError(message, diagnostic);
  }
  private modelPath() { return join(this.config.dataDir, "runtime", this.provider + "-model.json"); }
  private apiBaseUrl(): string {
    if (!this.config.baseUrl?.trim()) throw this.failure("请配置 GATEWAY_API_BASE_URL 后再发起请求。");
    try {
      const url = new URL(this.config.baseUrl.trim());
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || /\/chat\/completions\/?$/i.test(url.pathname)) throw new Error("invalid");
      return url.href.replace(/\/+$/, "");
    } catch { throw this.failure("GATEWAY_API_BASE_URL 必须是无账号、查询参数和片段的 HTTP(S) 基础地址，不包含 /chat/completions。"); }
  }
  private manualModel(model: string | undefined): string {
    if (!model || !/^[^\s\x00-\x1f\x7f]{1,256}$/.test(model)) throw this.failure("请配置 GATEWAY_API_MODEL 或手动选择有效模型 ID；不会自动选择模型。");
    return model;
  }
  private apiSpec(model: string): Model {
    const contextLength = this.config.contextWindow ?? 32768;
    if (!Number.isSafeInteger(contextLength) || contextLength < 8192) throw this.failure("GATEWAY_API_CONTEXT_WINDOW 必须是至少 8192 的整数。");
    return { id: this.manualModel(model), displayName: model, input: this.config.vision ? ["text", "image"] : ["text"],
      output: ["text"], parameters: ["tools"], contextLength };
  }
  private headers(): Record<string, string> {
    if (this.provider === "openrouter" && !this.config.apiKey) throw this.failure("OpenRouter Key 未配置。");
    return { ...(this.config.apiKey ? { Authorization: "Bearer " + this.config.apiKey } : {}), "Content-Type": "application/json" };
  }
  private async request(path: string, body?: unknown, stream = false): Promise<any> {
    try {
      if (this.provider === "api" && path !== "chat/completions") throw this.failure("通用 API 不支持此端点。");
      const baseUrl = this.provider === "api" ? this.apiBaseUrl() : "https://openrouter.ai/api/v1";
      const response = await this.fetcher(baseUrl + "/" + path, {
        method: body === undefined ? "GET" : "POST", headers: this.headers(), redirect: "error",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(path === "images" ? 180_000 : 90_000),
      });
      if (!response.ok) {
        // The image API can explain HTTP 400, but its raw body may echo private prompts.
        // Record only an allowlisted diagnostic category; preserve the no-retry boundary.
        const diagnostic = path === "images" ? await safeOpenRouterFailure(response) : undefined;
        if (!diagnostic) await response.body?.cancel().catch(() => undefined);
        const label = response.status === 401 || response.status === 403 ? "认证失败" : response.status === 402 ? "余额或 Key 额度不足" : response.status === 429 ? "请求限流" : "请求失败";
        const reason = diagnostic && response.status === 400 ? "，原因分类：" + diagnostic.category : "";
        throw this.failure("OpenRouter " + label + "（HTTP " + response.status + reason + "），未自动重试或切换模型。", diagnostic);
      }
      if (stream) return await readChatStream(response);
      if (!response.body) throw this.failure("OpenRouter 返回空响应。");
      const reader = response.body.getReader(); const pieces: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          length += chunk.value.length;
          if (length > 16 * 1024 * 1024) throw this.failure("OpenRouter 响应超过安全大小限制。");
          pieces.push(chunk.value);
        }
      } finally { await reader.cancel().catch(()=>undefined); }
      const payload = JSON.parse(Buffer.concat(pieces).toString("utf8"));
      if (payload.error) throw this.failure("OpenRouter 返回错误，未自动重试。");
      if (this.provider === "api" && !["stop", "tool_calls"].includes(payload.choices?.[0]?.finish_reason)) throw this.failure("API 回复不完整或被中止，未自动重试。");
      return payload;
    } catch (error) {
      if (error instanceof OpenRouterError || error instanceof ApiError) throw error;
      // Never expose request headers, URLs containing secrets or upstream error bodies.
      throw this.failure("OpenRouter 连接失败或结果不确定，未自动重试；请检查状态后再发新消息。");
    }
  }
  async close(): Promise<void> { await this.operations.drain(); await this.images?.close(); }
  async signIn(): Promise<RuntimeSession> { return this.getSession(); }
  async getUsage() {
    if (this.provider === "api") return { supported: false, source: "通用 API 未定义账户额度接口。" };
    const { data } = await this.request("key");
    const costUsd = typeof data?.usage === "number" && Number.isFinite(data.usage) && data.usage >= 0 ? data.usage : undefined;
    const limitRemainingUsd = typeof data?.limit_remaining === "number" && Number.isFinite(data.limit_remaining) && data.limit_remaining >= 0 ? data.limit_remaining : undefined;
    return { supported: costUsd !== undefined, source: "OpenRouter key lifetime usage (all applications using this key)",
      ...(costUsd === undefined ? {} : { costUsd }), ...(limitRemainingUsd === undefined ? {} : { limitRemainingUsd }) };
  }
  getSession(): Promise<RuntimeSession> {
    if (this.pendingSession) return this.pendingSession;
    return this.pendingSession = this.readSession().finally(() => { this.pendingSession = undefined; });
  }
  private async readSession(): Promise<RuntimeSession> {
    if (this.provider === "api") {
      try {
        this.apiBaseUrl();
        this.apiSpec((await this.getModelSelection()).resolvedModel!);
        return { status: "connected", sharing: true, profileLabel: "API（已配置，尚未验证连接）" };
      } catch {
        return { status: "disconnected", sharing: false, error: { code: "api_unconfigured", message: "请检查 GATEWAY_API_BASE_URL、GATEWAY_API_MODEL 和上下文设置。", retryable: false } };
      }
    }
    if (!this.config.apiKey) return { status: "disconnected", sharing: false };
    try { const key = await this.request("key"); if (!key.data || typeof key.data !== "object") throw this.failure("OpenRouter Key 状态无效。"); return { status: "connected", sharing: true, profileLabel: "OpenRouter" }; }
    catch { return { status: "disconnected", sharing: false, error: { code: "openrouter_unavailable", message: "OpenRouter Key 或接口不可用。", retryable: false } }; }
  }
  private async catalogue(): Promise<Model[]> {
    if (this.provider === "api") {
      const state = await readJsonFile<RuntimeModelSelection>(this.modelPath(), { mode: "auto" });
      const model = state.mode === "pinned" ? state.model : this.config.defaultModel;
      return model ? [this.apiSpec(model)] : [];
    }
    if (this.models && Date.now() - this.models.at < 60_000) return this.models.values;
    if (this.pendingModels) return this.pendingModels;
    return this.pendingModels = this.readCatalogue().finally(() => { this.pendingModels = undefined; });
  }
  private async readCatalogue(): Promise<Model[]> {
    const payload = await this.request("models");
    if (!Array.isArray(payload.data)) throw this.failure("OpenRouter 模型目录无效。");
    const values: Model[] = payload.data.map((item: any) => ({
      id: String(item.id), displayName: String(item.name ?? item.id), input: item.architecture?.input_modalities ?? [],
      output: item.architecture?.output_modalities ?? [], parameters: item.supported_parameters ?? [], contextLength: Number(item.context_length ?? 0),
    })).filter((m: Model) => m.input.includes("text") && m.output.includes("text") && m.id !== "openrouter/auto")
      .sort((a: Model,b: Model)=>a.id.localeCompare(b.id));
    this.models = { at: Date.now(), values }; return values;
  }
  async listModels(): Promise<RuntimeModel[]> {
    return (await this.catalogue()).filter(m => m.parameters.includes("tools")).map(({id,displayName})=>({id,displayName}));
  }
  async validateTestModel(model: string): Promise<{ model: string; supportsTools: boolean }> {
    const spec = this.provider === "api" ? this.apiSpec(model) : (await this.catalogue()).find(m => m.id === model);
    if (!spec) throw this.failure("模型不可用或不支持文字对话。");
    return { model: spec.id, supportsTools: spec.parameters.includes("tools") };
  }
  async getModelSelection(): Promise<RuntimeModelSelection> {
    const state = await readJsonFile<RuntimeModelSelection>(this.modelPath(), { mode: "auto" });
    const model = state.mode === "pinned" ? state.model : this.config.defaultModel;
    if (!model) throw this.failure("请配置 OPENROUTER_DEFAULT_MODEL 并重启，然后在 /model 面板选择 Auto；不会自动选择付费模型。");
    if (this.provider === "api") this.apiSpec(model);
    else if (!(await this.catalogue()).some(m=>m.id===model && m.parameters.includes("tools"))) throw this.failure("Model unavailable: 该 OpenRouter 模型不支持文字与工具调用或已不可用。");
    return { mode: state.mode, ...(state.mode === "pinned" ? { model } : {}), resolvedModel: model };
  }
  async selectModel(model?: string): Promise<RuntimeModelSelection> {
    const selected = !model || model === "auto" ? this.config.defaultModel : model;
    if (this.provider === "api") this.apiSpec(this.manualModel(selected));
    else if (!selected || !(await this.catalogue()).some(m=>m.id===selected && m.parameters.includes("tools"))) throw this.failure("Model unavailable: 请先配置可用默认模型，或选择支持工具调用的模型。");
    const state: RuntimeModelSelection = !model || model === "auto" ? { mode: "auto" } : { mode: "pinned", model };
    await writeJsonAtomic(this.modelPath(), state); return { ...state, resolvedModel: selected };
  }
  async resetSession(): Promise<void> { /* Stateless HTTP: shared transcript is the recovery source. */ }
  async commitSession(): Promise<void> { /* Assistant commits are owned by Gateway delivery acknowledgements. */ }
  reply(request: ChatRequest): Promise<ChatResponse> {
    if(request.purpose === "memory_classify") return Promise.reject(new Error("记忆分类仅通过独立 SIWC 入口执行。"));
    return this.exclusive(() => this.run(request));
  }
  private usage(raw: any): ChatUsage {
    return { inputTokens: Number(raw?.prompt_tokens ?? 0), outputTokens: Number(raw?.completion_tokens ?? 0), cachedInputTokens: Number(raw?.prompt_tokens_details?.cached_tokens ?? 0), reasoningTokens: Number(raw?.completion_tokens_details?.reasoning_tokens ?? 0), totalTokens: Number(raw?.total_tokens ?? 0), ...(typeof raw?.cost === "number" ? { costUsd: raw.cost } : {}) };
  }
  private async run(request: ChatRequest): Promise<ChatResponse> {
    const captureTraceContent = Boolean(request.trace && request.trace.captureContent !== false);
    const input = requestMessages(request);
    if (request.purpose === "chat" && !request.ephemeral) request = withHistoryTool(request, request.history ?? historyFromMessages(input.slice(0, -1)));
    if (request.ephemeral && (!request.testModel || ![2048, 4096, 8192].includes(request.testHistoryTokens ?? -1))) {
      throw this.failure("临时 OpenRouter 调用必须明确指定模型和受限历史预算。");
    }
    if (!request.ephemeral && (request.testModel || request.testHistoryTokens !== undefined)) throw this.failure("正式对话禁止使用临时模型覆盖。");
    if (request.ephemeral && estimatedTextTokens(input.at(-1)!.content) > 4096) throw this.failure("测试消息超出单条 4096 估算 token 上限，请缩短后发送。");
    if (request.ephemeral && (request.allowImageGeneration === true || request.imageOutputAllowed === true || (request.attachments?.length && request.purpose !== "diagnostic"))) {
      throw this.failure("临时 OpenRouter 模式仅支持文字，不允许付费生图或媒体附件。");
    }
    const imageSettings = request.ephemeral ? undefined : await this.getImageSettings();
    const imageHeartbeat = (request.purpose === "heartbeat_plan" || request.purpose === "heartbeat_decision") &&
      request.imageOutputAllowed === true && await this.canGenerateImage(true);
    // Recent maintenance is bundled independently of proactive messages.
    // Other background calls retain the text/image spending gates.
    if (isBackground(request) && request.purpose !== "recent_review" && !this.config.heartbeat && !imageHeartbeat) {
      return { text: "SILENT", skipped: "background_disabled" };
    }
    const autonomousImage = request.allowImageGeneration !== true && request.imageOutputAllowed === true &&
      request.purpose !== "heartbeat_plan" &&
      Boolean(imageSettings?.model) && await this.canGenerateImage(true);
    const imageModel = imageSettings?.model;
    const model = request.ephemeral ? request.testModel! : (await this.getModelSelection()).resolvedModel!;
    let tail = request.history ? await request.history.readTail(Math.max(0, OPENROUTER_LIMITS.historyMessages - input.length)) : [];
    if (request.ephemeral) {
      let tokens = 0; const limited = [] as typeof tail;
      for (let index = tail.length - 1; index >= 0; index--) {
        const message = tail[index]!;
        const size = estimatedTextTokens(message.content);
        if (tokens + size > request.testHistoryTokens!) break;
        limited.unshift(message); tokens += size;
      }
      tail = limited;
    }
    const all = [...tail, ...input];
    const historyBase = request.history ? request.history.count - tail.length : 0;
    const spec = this.provider === "api" ? this.apiSpec(model) : (await this.catalogue()).find(m=>m.id===model);
    if (!spec || (!request.ephemeral && !spec.parameters.includes("tools"))) throw this.failure("选择的模型不可用或不支持所需能力。");
    if (request.attachments?.some(a => a.kind !== "image")) throw this.failure("OpenRouter 当前仅支持图片附件，文件输入尚未启用。");
    if (request.attachments?.length && !spec.input.includes("image")) throw this.failure("该模型不支持图片输入。");
    if (request.ephemeral && request.testAuthorized?.() === false) throw this.failure("测试模式已经切换或关闭，已取消未开始的付费请求。");
    const digest = createHash("sha256").update(request.operationId ?? JSON.stringify([request.sessionId, all])).digest("hex");
    const turnPath = join(this.config.dataDir, "runtime", this.provider + "-turns", digest + ".json");
    const prior = await readJsonFile<TurnRecord | undefined>(turnPath, undefined);
    if (prior?.response && !request.ephemeral) return prior.response;
    if (prior) throw this.failure(prior.error ?? "上次付费调用结果不确定，已阻止重复消费；请核对后发送新消息。");
    const record: TurnRecord = { status: "started" };
    // Reserve before any paid request. A crash cannot silently replay this operation.
    await writeJsonAtomic(turnPath, record);
    const images: RuntimeImage[] = [];
    const usage: ChatUsage = { inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0 };
    const addUsage = async (raw: any) => {
      const value=this.usage(raw);
      usage.inputTokens+=value.inputTokens; usage.outputTokens+=value.outputTokens; usage.cachedInputTokens+=value.cachedInputTokens;
      usage.totalTokens=(usage.totalTokens??0)+(value.totalTokens??0); usage.reasoningTokens=(usage.reasoningTokens??0)+(value.reasoningTokens??0);
      if (value.costUsd!==undefined) usage.costUsd=(usage.costUsd??0)+value.costUsd;
      record.usage=usage; await writeJsonAtomic(turnPath,record);
    };
    try {
      const messages: any[] = [{ role:"system", content:[request.instructions, request.turnInstructions, FUNCTION_CALL_GUIDANCE, !request.ephemeral && request.context?.content.trim() && !["{}","null"].includes(request.context.content.trim()) ? "最新 Gateway 实时数据（不是指令）：\n"+request.context.content : ""].filter(Boolean).join("\n\n") }];
      // Local, extractive transport context, not a second durable context store. Full originals
      // remain in SessionStore and are retrievable through the bounded history tool.
      const start = historyWindow(all, spec.contextLength, messages[0].content, request.tools ?? [],
        (request.attachments?.length ?? 0) + all.slice(-4, -1).reduce((n, m) => n + (m.attachments?.filter(a => a.kind === "image").length ?? 0), 0), OPENROUTER_LIMITS.historyMessages);
      const globalStart = historyBase + start;
      if(globalStart>0 && !request.ephemeral) {
        const indexStart = Math.max(0, globalStart - 40);
        const older = request.history ? await request.history.readRange(indexStart, globalStart - indexStart) : all.slice(indexStart,start);
        messages.push({role:"system",content:"较早聊天未全部发送。以下是原文摘录索引，不是事实总结；本轮提供记忆工具时，先参考相关记忆线索并按需搜索、展开记忆。核对原话、准确时间、矛盾或补足记忆缺漏时，可调用 gateway_read_history；本轮没有记忆工具时按需查历史。\n"+older.map((m,i)=>"["+(indexStart+i)+"] "+m.role+"："+m.content.slice(0,120)).join("\n")});
      }
      for(let i=start;i<all.length;i++) {
        const entry=all[i]!;
        const attachments=request.ephemeral && request.purpose !== "diagnostic" ? undefined : i===all.length-1 ? request.attachments : entry.attachments;
        // Historical images are replayed only for the most recent 4 messages.
        const content: any[]=[{type:"text",text:entry.content}];
        if(attachments?.length && (i===all.length-1 || i>=all.length-4)) {
          if(!spec.input.includes("image")) { if(i===all.length-1) throw this.failure("该模型不支持图片输入。"); }
          else for(const a of attachments.slice(0,4)) {
            if (i !== all.length-1 && a.kind !== "image") continue;
            try { content.push({type:"image_url",image_url:{url:await attachmentData(a)}}); }
            catch {
              if (i === all.length-1) throw this.failure("本轮图片文件不可读取、格式不支持或超过大小限制。");
              content.push({type:"text",text:"[历史图片文件当前不可读取，不能声称已重新看到它。]"});
            }
          }
        }
        messages.push({role:entry.role==="developer"?"system":entry.role,content: this.provider === "api" && content.length === 1 ? content[0].text : content});
      }
      const exposed = request.purpose === "diagnostic"
        ? (request.tools??[]).filter(t=>t.name === "diagnostic_echo" && t.readOnly === true)
        : request.ephemeral ? [] : request.tools??[];
      const tools: any[]=exposed.map(t=>({type:"function",function:{name:t.name,description:t.description,parameters:t.parameters}}));
      const imageAllowed=(request.allowImageGeneration===true || autonomousImage) && Boolean(imageModel);
      if (!imageAllowed) messages[0].content += this.provider === "api"
        ? "\n本轮没有图片生成能力，不得声称已生成图片或切换到其他 Provider。"
        : "\n本轮没有图片生成能力。不得声称已生成图片，不得切换 Provider；若用户要求生图，说明需要明确选择 OpenRouter 并配置生图模型。";
      const imageTool = imageAllowed ? new ImageTool(request, autonomousImage,
        imageRequest => this.imageService().generateImage(imageRequest)) : undefined;
      if (imageTool) tools.push({ type: "function", function: imageTool.definition });
      if(this.provider === "openrouter" && this.config.webSearch && !request.ephemeral && request.purpose !== "recent_review") tools.push({type:"openrouter:web_search",parameters:{engine:"exa",max_results:3,max_uses:1,max_total_results:3}});
      if (request.purpose === "media_exploration" && (this.provider === "api" || !this.config.webSearch)) messages[0].content += "\n本轮联网检索未启用，不能声称核实了实时热点。仅依据已提供的明确兴趣，或返回空 candidates。";
      let toolCount=0;
      const seen=new Set<string>();
      const maxRounds=request.maxToolRounds && request.maxToolRounds>0 ? Math.min(request.maxToolRounds,OPENROUTER_LIMITS.toolRounds):OPENROUTER_LIMITS.toolRounds;
      for(let round=0;round<=maxRounds;round++) {
        assertRequestBudget(messages, tools, spec.contextLength);
        if (request.ephemeral && request.testAuthorized?.() === false) throw this.failure("测试模式已经切换或关闭，未发送付费请求。");
        const stream = this.provider === "openrouter" || this.config.stream !== false;
        const traceStep = safeTraceStart(request.trace, { kind: "model", name: "chat.completions", provider: this.provider, model,
          input: captureTraceContent ? { messages: traceContent(messages), tools: tools.map(tool => tool.function?.name ?? tool.type), stream } : undefined });
        let response: any;
        try {
          response=await this.request("chat/completions",{model,messages,
            ...((!request.ephemeral || request.purpose === "diagnostic") && (this.provider === "openrouter" || tools.length) ? { tools } : {}),
            stream,max_tokens:request.ephemeral?1024:OPENROUTER_LIMITS.responseTokens,
            ...(this.provider === "openrouter" ? {stream_options:{include_usage:true},provider:{allow_fallbacks:false,...(tools.length?{require_parameters:true}:{})}} : {})},stream);
          const valid = response.choices?.[0]?.message?.role === "assistant";
          safeTraceFinish(request.trace, traceStep, { status: valid ? "completed" : "failed",
            ...(valid ? { output: captureTraceContent ? traceContent(response.choices[0].message) : undefined } : { error: "模型未返回有效 assistant 回复。" }),
            ...(reportedTraceUsage(response.usage, "chat") ? { usage: reportedTraceUsage(response.usage, "chat") } : {}),
            ...(typeof response.model === "string" ? { model: response.model } : {}) });
        } catch (error) {
          safeTraceFinish(request.trace, traceStep, { status: "failed", error: error instanceof Error ? error.message : "模型调用失败。" });
          throw error;
        }
        await addUsage(response.usage);
        const reply=response.choices?.[0]?.message;
        if(!reply || reply.role!=="assistant") throw this.failure("OpenRouter 没有返回有效回复。");
        const calls=reply.tool_calls??[];
        if(request.ephemeral && calls.length && !(request.purpose === "diagnostic" &&
          calls.every((call: any) => call.function?.name === "diagnostic_echo") &&
          tools.some(t=>t.function?.name === "diagnostic_echo"))) throw this.failure("临时模式禁止未经授权的外部工具调用。");
        if(!calls.length) {
          let text=typeof reply.content==="string"?reply.content.trim():"";
          const citations=(reply.annotations??[]).map((a:any)=>a.url_citation).filter((a:any)=>a?.url && /^https?:\/\//.test(a.url));
          if(citations.length) text+="\n\n"+[...new Set(citations.map((a:any)=>a.url))].slice(0,6).join("\n");
          if(request.allowImageGeneration && !images.length) {
            const prefix = imageAllowed ? "本轮图片生成未成功，没有图片可发送。" : (this.provider === "api" ? "通用 API 未启用内建生图，没有请求其他 Provider。" : "本轮未启用图片生成，请配置 OPENROUTER_IMAGE_MODEL。");
            text = prefix + (text ? "\n\n" + text : "");
          }
          text = blockTextualToolCall(text,tools.map(t=>String(t.function?.name??"")),this.provider);
          text = request.finalizeReplyText?.(text) ?? text;
          const replySegments=request.getPreparedReplySegments?.();
          const voiceText=request.getPreparedVoice?.();
          const voiceInstruction=voiceText ? request.getPreparedVoiceInstruction?.() : undefined;
          const nativeReply=request.getPreparedNativeReply?.();
          const sticker=request.getPreparedSticker?.();
          if(!text && !images.length && !voiceText && !replySegments?.length && !sticker) throw this.failure("OpenRouter 返回空回复。");
          const result: ChatResponse={text,model,usage,...(replySegments?{replySegments}:{}),...(images.length?{images}:{}),...(voiceText?{voiceText}:{}),...(voiceInstruction?{voiceInstruction}:{}),...(nativeReply?{nativeReply}:{}),...(sticker?{sticker}:{}),contextEffect:globalStart>0 ? "history_windowed" : "none"};
          await writeJsonAtomic(turnPath,request.ephemeral ? { status:"completed", usage } : {status:"completed",response:result}); return result;
        }
        if(round===maxRounds || toolCount+calls.length>OPENROUTER_LIMITS.toolCalls) throw this.failure("OpenRouter 工具调用达到本轮上限。");
        if (typeof reply.content === "string") request.recordReplyText?.(blockTextualToolCall(reply.content,tools.map(t=>String(t.function?.name??"")),this.provider), this.provider + ":" + round);
        messages.push(this.provider === "api" ? {role:"assistant",content:reply.content ?? null,tool_calls:calls} : reply);
        for(const call of calls) {
          toolCount++;
          if(call.type!=="function" || typeof call.id!=="string" || !call.id || seen.has(call.id)) throw this.failure("OpenRouter 工具调用无效或重复。");
          seen.add(call.id);
          let output: unknown;
          let toolTrace: string | undefined;
          try {
            const args=JSON.parse(call.function?.arguments??"{}");
            if(!args || typeof args!=="object" || Array.isArray(args)) throw new Error("Invalid arguments.");
            const name=call.function?.name;
            if(name===IMAGE_TOOL && imageAllowed) {
              toolTrace = safeTraceStart(request.trace, { kind: "tool", name, provider: this.provider, parentId: traceStep, input: captureTraceContent ? args : undefined });
              const result = await imageTool!.execute(args);
              output = result.output;
              if (result.response) {
                const image = result.response.images![0]!;
                const imageUsage = result.response.usage!;
                usage.inputTokens += imageUsage.inputTokens; usage.outputTokens += imageUsage.outputTokens;
                usage.totalTokens = (usage.totalTokens ?? 0) + (imageUsage.totalTokens ?? 0);
                if (imageUsage.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + imageUsage.costUsd;
                images.push(image); if (!request.ephemeral) record.images = images; await writeJsonAtomic(turnPath, record);
              }
            } else if(tools.some(t=>t.function?.name===name) && request.executeTool) {
              toolTrace = safeTraceStart(request.trace, { kind: "tool", name, provider: this.provider, parentId: traceStep, input: captureTraceContent ? args : undefined });
              output=await request.executeTool(name,args);
            }
            else throw new Error("工具不可用或未授权。");
            safeTraceFinish(request.trace, toolTrace, { status: tracedToolStatus(output), output: captureTraceContent ? output : undefined });
          } catch {
            output={success:false,error:"工具调用失败、参数无效或能力不支持。不要声称已成功；生图失败不得重试。"};
            if (toolTrace) safeTraceFinish(request.trace, toolTrace, { status: "failed", output: captureTraceContent ? output : undefined, error: "工具调用失败。" });
            else {
              const rejected = safeTraceStart(request.trace, { kind: "system", name: "tool_rejected", parentId: traceStep,
                input: captureTraceContent ? { name: call.function?.name, arguments: call.function?.arguments } : undefined });
              safeTraceFinish(request.trace, rejected, { status: "failed", output: captureTraceContent ? output : undefined });
            }
          }
          messages.push({role:"tool",tool_call_id:call.id,content:safeToolOutput(output)});
        }
      }
      throw this.failure("OpenRouter 工具调用超限。");
    } catch(error) {
      // A successfully generated image survives a subsequent text-model failure.
      if(images.length) {
        const result={text:"图片已生成，后续文字回复未完成。",images,model,usage};
        await writeJsonAtomic(turnPath,request.ephemeral
          ? {status:"completed",usage} : {status:"completed",response:result}); return result;
      }
      const safe=error instanceof OpenRouterError || error instanceof ApiError?error.message:this.failure("OpenRouter 本轮未完成，未自动重试。").message;
      await writeJsonAtomic(turnPath,{...record,status:"failed",error:safe}); throw this.failure(safe);
    }
  }
}
