import { defaultMemoryPrompt, validateMemoryPrompts, type MemoryPromptId } from "../../memory/prompts.js";
import { memoryTaskRequest, type MemoryTask } from "../../memory/tasks.js";
import { classificationRequest, LUNA_MODEL } from "../../memory/classifier.js";
import { MemoryError } from "../../memory/validation.js";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ChatRequest,
  ChatResponse,
  ContextMaintenanceRequest,
  ManagedChatRuntime,
  RuntimeModel,
  RuntimeModelSelection,
  RuntimeSession
} from "../types.js";
import { runDirectResponse } from "../direct-responses.js";
import { readJsonFile, writeJsonAtomic } from "../../util/atomic-json.js";
import { readActiveAccessToken } from "./access-token.js";
import { createCredentialEncryption } from "./credential-encryption.js";
import { loadSiwcModule, type CredentialEncryptionAdapter, type SiwcClient } from "./sdk.js";
import { StatefulResponsesBridge } from "./stateful-responses.js";
import { isBackground, requestMessages } from "../request.js";
import { withHistoryTool } from "../history-tool.js";
import { historyFromMessages } from "../history.js";
import { isRetryableTransportError, isSubscriptionUsageLimitError, tagInboundRetryability } from "../retry-policy.js";

export interface SiwcRuntimeConfig {
  dataDir: string;
  devkitDir: string;
  preferredModel?: string;
  credentialKeyFile?: string;
  redirectPort?: number;
  openBrowser?: (url: string) => Promise<void>;
}

interface ModelState {
  mode: "auto" | "pinned";
  model?: string;
}

// Authentication/model discovery happens before model or tool execution. Retain
// the inbound message so the owner can fix configuration and explicitly retry.
async function prepareModelCall<T>(prepare: () => Promise<T>): Promise<T> {
  try { return await prepare(); }
  catch (error) {
    throw tagInboundRetryability(error,
      isRetryableTransportError(error) || isSubscriptionUsageLimitError(error), true);
  }
}

export class SiwcRuntime implements ManagedChatRuntime {
  private readonly modelStatePath: string;
  private readonly memoryModelPath: string;
  private readonly memoryPromptsPath: string;
  private readonly statefulResponses: StatefulResponsesBridge;
  private readonly memoryResponses: StatefulResponsesBridge;

  constructor(
    private readonly client: SiwcClient,
    private readonly storageDir: string,
    dataDir: string,
    private readonly credentialEncryption: CredentialEncryptionAdapter,
    private readonly preferredModel?: string,
  ) {
    this.memoryPromptsPath = resolve(dataDir, "runtime", "memory-prompts.json");
    this.memoryModelPath = resolve(dataDir, "runtime", "memory-model.json");
    this.modelStatePath = resolve(dataDir, "runtime", "model.json");
    this.statefulResponses = new StatefulResponsesBridge(dataDir);
    this.memoryResponses = new StatefulResponsesBridge(dataDir);
  }

  signIn(options?: { reconsent?: boolean }): Promise<RuntimeSession> {
    return this.client.signIn(options);
  }

  getSession(): Promise<RuntimeSession> {
    return this.client.getSession();
  }

  async listModels(): Promise<RuntimeModel[]> {
    const session = await this.client.getSession();
    if (session.status !== "connected") throw new Error("Sign in with ChatGPT first: npm run auth:login");
    if (!session.sharing) throw new Error("ChatGPT plan usage is not enabled. Run npm run auth:reconsent.");
    const models = await this.client.listModels();
    return models.map((model) => ({ id: model.slug, displayName: model.displayName }));
  }

  private async readModelState(): Promise<ModelState> {
    const fallback: ModelState = this.preferredModel
      ? { mode: "pinned", model: this.preferredModel }
      : { mode: "auto" };
    return readJsonFile<ModelState>(this.modelStatePath, fallback);
  }

  async getModelSelection(): Promise<RuntimeModelSelection> {
    const models = await this.listModels();
    return this.modelSelection(models);
  }

  private async modelSelection(models: RuntimeModel[]): Promise<RuntimeModelSelection> {
    if (!models.length) throw new Error("No ChatGPT models are available for the selected profile.");
    const state = await this.readModelState();
    if (state.mode === "pinned" && state.model) {
      const selected = models.find((model) => model.id === state.model);
      if (selected) return { mode: "pinned", model: selected.id, resolvedModel: selected.id };
      await writeJsonAtomic(this.modelStatePath, { mode: "auto" } satisfies ModelState);
    }
    return { mode: "auto", resolvedModel: models[0]!.id };
  }

  async selectModel(model?: string): Promise<RuntimeModelSelection> {
    const models = await this.listModels();
    if (!models.length) throw new Error("No ChatGPT models are available for the selected profile.");
    if (!model || model === "auto") {
      await writeJsonAtomic(this.modelStatePath, { mode: "auto" } satisfies ModelState);
      return { mode: "auto", resolvedModel: models[0]!.id };
    }
    const selected = models.find((item) => item.id === model);
    if (!selected) throw new Error("Model " + model + " is not available.");
    await writeJsonAtomic(this.modelStatePath, { mode: "pinned", model: selected.id } satisfies ModelState);
    return { mode: "pinned", model: selected.id, resolvedModel: selected.id };
  }

  async close(): Promise<void> {
    await Promise.all([this.statefulResponses.close(),this.memoryResponses.close()]);
  }

  async editHistory(sessionId: string, work: () => Promise<void>): Promise<void> {
    return this.statefulResponses.editHistory(sessionId, work);
  }

  async resetSession(sessionId: string, deliveryId?: string): Promise<void | boolean> {
    return this.statefulResponses.resetSession(sessionId, deliveryId);
  }

  async commitSession(sessionId: string, deliveredText: string, deliveryId?: string): Promise<void | boolean> {
    return this.statefulResponses.commitSession(sessionId, deliveredText, deliveryId);
  }

  maintainContext(request: ContextMaintenanceRequest) {
    return this.statefulResponses.maintainContext(request, async () => {
      const model = (await this.getModelSelection()).resolvedModel;
      if (!model) throw new Error("SIWC maintenance model unavailable.");
      return { model, accessToken: await readActiveAccessToken(this.storageDir, this.credentialEncryption) };
    });
  }

  listMemoryModels(): Promise<RuntimeModel[]> { return this.listModels(); }
  async getMemoryModel(): Promise<string> {
    const state = await readJsonFile<{model:string}>(this.memoryModelPath, {model:LUNA_MODEL});
    if (typeof state.model !== "string" || !state.model.trim() || state.model.length>200) throw new MemoryError("INVALID_MODEL_SETTING");
    return state.model;
  }
  async selectMemoryModel(model: string): Promise<string> {
    if (!(await this.listModels()).some(item=>item.id===model)) throw new MemoryError("CLASSIFIER_UNAVAILABLE");
    await writeJsonAtomic(this.memoryModelPath, {model});
    return model;
  }
  private async memoryPrompt(id: MemoryPromptId): Promise<string> {
    const settings = validateMemoryPrompts(await readJsonFile(this.memoryPromptsPath, {revision:0,overrides:{}}));
    return settings.overrides[id] ?? defaultMemoryPrompt(id);
  }
  async runMemoryTask(task: MemoryTask,input: string): Promise<string> {
    return (await this.reply({...memoryTaskRequest(task,input),instructions:await this.memoryPrompt(task)})).text;
  }
  async classifyMemory(input: string): Promise<string> {
    return (await this.reply({...classificationRequest(input),instructions:await this.memoryPrompt("classify")})).text;
  }

  async reply(request: ChatRequest): Promise<ChatResponse> {
    const messages = requestMessages(request);
    if (request.purpose === "chat" && !request.temporaryMode) request = withHistoryTool(request, request.history ?? historyFromMessages(messages.slice(0, -1)));
    if (request.purpose === "memory_classify" && (!request.ephemeral || !request.stateful || request.history ||
      request.context || request.memory || request.tools?.length || request.executeTool || request.attachments?.length || request.deferAssistantCommit || request.testModel))
      throw new MemoryError("INVALID_MEMORY_REQUEST");
    const selected = await prepareModelCall(async () => {
      const models = await this.listModels();
      if (request.purpose === "memory_classify" && !["fuse","verify"].includes(request.memoryTask ?? "")) {
        const id = await this.getMemoryModel();
        const classifier = models.find(model => model.id === id);
        if (!classifier) throw new MemoryError("CLASSIFIER_UNAVAILABLE");
        return classifier;
      }
      const selection = await this.modelSelection(models);
      const model = models.find((model) => model.id === (request.purpose === "diagnostic" && request.ephemeral && request.testModel ? request.testModel : selection.resolvedModel));
      if (!model) throw new Error("No ChatGPT models are available for the selected profile.");
      return model;
    });

    // Background planning/decisions need the same authenticated SIWC WS tool
    // protocol as interactive chat. The non-stateful HTTP Responses route does
    // not carry ChatGPT subscription session semantics. Use one short-lived lane
    // per background operation; never contaminate a user's conversation lane.
    const background = isBackground(request);
    if (request.stateful || background) {
      const accessToken = await prepareModelCall(() => readActiveAccessToken(this.storageDir, this.credentialEncryption));
      const sessionId = background ? "background:" + randomUUID() : request.sessionId;
      const responseBridge=request.purpose==="memory_classify"?this.memoryResponses:this.statefulResponses;
      try {
      const result = await responseBridge.reply({
        ...(request.memory && request.purpose === "chat" && !request.ephemeral ? {memory:request.memory} : {}),
        ...(["recent_review", "memory_classify"].includes(request.purpose) ? { webSearchAllowed: false } : {}),
        ...(request.trace ? { trace: request.trace, contextSources: request.contextSources } : {}),
        accessToken,
        model: selected.id,
        sessionId,
        messages,
        ...(background || request.ephemeral ? { ephemeral: true } : {}),
        ...(request.history ? { history: request.history } : {}),
        ...(request.deliveryId ? { deliveryId: request.deliveryId } : {}),
        ...(request.deferAssistantCommit ? { deferAssistantCommit: true } : {}),
        ...(request.instructions ? { instructions: request.instructions } : {}),
        ...(request.turnInstructions ? { turnInstructions: request.turnInstructions } : {}),
        ...(request.resetVoicePreferenceOnReconnect ? { resetVoicePreferenceOnReconnect: true } : {}),
        ...(request.timezone ? { timezone: request.timezone } : {}),
        ...(request.context ? { context: request.context } : {}),
        ...(request.attachments?.length ? { attachments: request.attachments } : {}),
        ...(request.tools?.length ? { tools: request.tools } : {}),
        ...(request.executeTool ? { executeTool: request.executeTool } : {}),
        ...(request.recordReplyText ? {recordReplyText:request.recordReplyText} : {}),
        ...(request.getPreparedReplySegments ? {getPreparedReplySegments:request.getPreparedReplySegments} : {}),
        ...(request.getPreparedVoice ? {getPreparedVoice:request.getPreparedVoice} : {}),
        ...(request.getPreparedVoiceInstruction ? {getPreparedVoiceInstruction:request.getPreparedVoiceInstruction} : {}),
        ...(request.getPreparedSticker ? {getPreparedSticker:request.getPreparedSticker} : {}),
        ...(request.getPreparedNativeReply ? {getPreparedNativeReply:request.getPreparedNativeReply} : {}),
        ...(request.finalizeReplyText ? { finalizeReplyText: request.finalizeReplyText } : {}),
        ...(request.maxToolRounds !== undefined ? { maxToolRounds: request.maxToolRounds } : {}),
      });
      return {
        text: result.text,
        ...(result.replySegments ? {replySegments:result.replySegments} : {}),
        ...(result.voiceText ? {voiceText:result.voiceText} : {}),
        ...(result.voiceInstruction ? {voiceInstruction:result.voiceInstruction} : {}),
        ...(result.sticker ? {sticker:result.sticker} : {}),
        ...(result.nativeReply ? {nativeReply:result.nativeReply} : {}),
        model: selected.id,
        usage: result.usage,
        compacted: result.compacted,
        ...(result.compaction ? { compaction: result.compaction } : {}),
        contextEffect: result.compacted ? "checkpoint_compacted" : result.historyWindowed ? "history_windowed" : "none",
      };
      } finally {
        if (background || request.temporaryMode) await responseBridge.resetSession(sessionId);
      }
    }

    if (request.ephemeral) throw new Error("临时测试请求必须使用 SIWC 沙盒会话。");
    const needsDirect = Boolean(request.attachments?.length || request.tools?.length);
    if (needsDirect) {
      const accessToken = await prepareModelCall(() => readActiveAccessToken(this.storageDir, this.credentialEncryption));
      const text = await runDirectResponse({
        accessToken,
        model: selected.id,
        messages,
        ...(request.instructions ? { instructions: request.instructions } : {}),
        ...(request.attachments?.length ? { attachments: request.attachments } : {}),
        ...(request.tools?.length ? { tools: request.tools } : {}),
        ...(request.executeTool ? { executeTool: request.executeTool } : {}),
        ...(request.recordReplyText ? {recordReplyText:request.recordReplyText} : {}),
        ...(request.getPreparedReplySegments ? {getPreparedReplySegments:request.getPreparedReplySegments} : {}),
        ...(request.finalizeReplyText ? { finalizeReplyText: request.finalizeReplyText } : {}),
        ...(request.maxToolRounds !== undefined ? { maxToolRounds: request.maxToolRounds } : {}),
      });
      return { text, model: selected.id, ...(request.getPreparedReplySegments ? {replySegments:request.getPreparedReplySegments()} : {}), ...(request.getPreparedSticker?.() ? {sticker:request.getPreparedSticker!()} : {}), ...(request.getPreparedNativeReply?.() ? { nativeReply: request.getPreparedNativeReply!() } : {}) };
    }

    const result = await this.client.streamResponse({
      model: selected.id,
      input: messages,
      ...(request.instructions ? { instructions: request.instructions } : {}),
    });
    const text = request.finalizeReplyText?.(result.text) ?? result.text;
    if (!text.trim()) throw new Error("The ChatGPT runtime returned an empty response.");
    return { text, model: selected.id, ...(request.getPreparedReplySegments ? {replySegments:request.getPreparedReplySegments()} : {}), ...(request.getPreparedSticker?.() ? {sticker:request.getPreparedSticker!()} : {}), ...(request.getPreparedNativeReply?.() ? { nativeReply: request.getPreparedNativeReply!() } : {}) };
  }
}

export async function createSiwcRuntime(config: SiwcRuntimeConfig): Promise<ManagedChatRuntime> {
  const sdk = await loadSiwcModule(config.devkitDir);
  const credentialEncryption = createCredentialEncryption(process.platform, config.credentialKeyFile);
  if (!(await credentialEncryption.isAvailable())) {
    const hint = config.credentialKeyFile
      ? "Check GATEWAY_CREDENTIAL_KEY_FILE permissions and contents."
      : process.platform === "linux"
        ? "Install secret-tool and provide a user Secret Service keyring, or configure GATEWAY_CREDENTIAL_KEY_FILE."
        : "Ensure Windows PowerShell and DPAPI are available for the current user.";
    throw new Error("Secure credential encryption is unavailable. " + hint);
  }

  const storageDir = resolve(config.dataDir, "chatgpt");
  const client = sdk.createChatGPT({
    appName: "Sophon",
    // Stable authentication identity, independent of the display or repository name.
    appId: "gateway-framework",
    redirectPort: config.redirectPort ?? 0,
    storageDir,
    credentialEncryption,
    sendHostId: true,
    ...(config.openBrowser ? { openBrowser: config.openBrowser } : {}),
  });
  return new SiwcRuntime(client, storageDir, config.dataDir, credentialEncryption, config.preferredModel);
}
