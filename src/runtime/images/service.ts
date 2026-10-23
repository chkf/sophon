import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../../util/atomic-json.js";
import { SerialQueue } from "../../util/serial-queue.js";
import type { ChatResponse, ChatUsage, ImageGenerationRequest } from "../types.js";
import { attachmentData, saveGeneratedImage } from "../openrouter-media.js";
import { ImageSettingsStore, IMAGE_PRESETS } from "../image-settings.js";
import { OpenRouterError } from "../openrouter-error.js";
interface TurnRecord { status: "started" | "completed" | "failed"; response?: ChatResponse; error?: string }

/** Receives visual content only. Owns authorization, quota and paid image journals. */
export class ImageGenerationService {
  private readonly operations = new SerialQueue();
  private readonly imageSettings: ImageSettingsStore;
  constructor(private readonly config: { dataDir: string; imageModel?: string; timezone?: string },
    private readonly request: (path: string, body?: unknown) => Promise<any>,
    private readonly connected: () => Promise<boolean>,
    private readonly usage: (raw: unknown) => ChatUsage) {
    this.imageSettings = new ImageSettingsStore(config.dataDir, config.imageModel, config.timezone);
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> { return this.operations.run(work); }
  async getImageSettings() { return this.imageSettings.get(); }
  private async validateImageModel(model: string) {
    const catalogue = await this.request("images/models");
    const spec = catalogue.data?.find((m: any) => m.id === model);
    if (!spec?.architecture?.output_modalities?.includes("image")) throw new OpenRouterError("生图模型不可用，未切换或消费。");
  }
  selectImageModel(choice: string) {
    return this.exclusive(async () => {
      const model = IMAGE_PRESETS.find(p => p.id === choice)?.model ?? (choice === "auto" ? this.config.imageModel : choice);
      if (!model || model === "openrouter/auto") throw new OpenRouterError("请配置或明确选择生图模型。");
      await this.validateImageModel(model);
      return this.imageSettings.select(model);
    });
  }
  setProactiveImages(enabled: boolean) {
    return this.exclusive(async () => {
      if (enabled) {
        if (!(await this.connected())) throw new OpenRouterError("OpenRouter Key 不可用。");
        const { model } = await this.imageSettings.get();
        if (!model) throw new OpenRouterError("请先选择生图模型。");
        await this.validateImageModel(model);
      }
      return this.imageSettings.enable(enabled);
    });
  }
  selectImageRoute(route: "provider" | "openrouter") {
    return this.exclusive(async () => {
      if (route === "openrouter") {
        if (!(await this.connected())) throw new OpenRouterError("OpenRouter Key 不可用。");
        const { model } = await this.imageSettings.get();
        if (!model) throw new OpenRouterError("请先选择生图模型。");
        await this.validateImageModel(model);
      }
      return this.imageSettings.setRoute(route);
    });
  }
  async canGenerateImage(autonomous: boolean): Promise<boolean> {
    const settings = await this.imageSettings.get();
    return Boolean(settings.model) && (!autonomous || await this.imageSettings.available());
  }
  /** Image-only boundary: accepts no chat transcript, instructions, bootstrap or tools. */
  generateImage(request: ImageGenerationRequest): Promise<ChatResponse> {
    return this.exclusive(() => this.runImage(request));
  }
  private async runImage(request: ImageGenerationRequest): Promise<ChatResponse> {
    const model = (await this.imageSettings.get()).model;
    if (!model || typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 4000) {
      throw new OpenRouterError("生图模型或提示词无效。");
    }
    const digest = createHash("sha256").update(request.operationId).digest("hex");
    const path = join(this.config.dataDir, "runtime", "openrouter-image-turns", digest + ".json");
    const prior = await readJsonFile<TurnRecord | undefined>(path, undefined);
    if (prior?.response) return prior.response;
    if (prior) throw new OpenRouterError("上次图片请求失败或结果不确定，不重复消费。");
    // Journal the preflight too: otherwise an unavailable image model leaves no trace
    // and looks indistinguishable from the model never calling the tool.
    let stage: "model_check" | "image_request" | "image_validation" = "model_check";
    await writeJsonAtomic(path, { status: "started", model, stage });
    try {
      const catalogue = await this.request("images/models");
      const spec = catalogue.data?.find((m: any) => m.id === model);
      if (!spec?.architecture?.output_modalities?.includes("image")) throw new OpenRouterError("生图模型不可用（模型目录校验失败）。");
      const references: any[] = [];
      if (request.reference) {
        if (request.reference.kind !== "image" || !spec.architecture?.input_modalities?.includes("image")) {
          throw new OpenRouterError("模型或附件不支持图片编辑。");
        }
        references.push({ type: "image_url", image_url: { url: await attachmentData(request.reference) } });
      }
      // Reserve both operation and autonomous quota before paid network I/O.
      if (request.autonomous) await this.imageSettings.reserve();
      stage = "image_request";
      await writeJsonAtomic(path, { status: "started", model, stage });
      const generated = await this.request("images", {
        model, prompt: request.prompt, n: 1,
        ...(model === "openai/gpt-image-2.5-sunburst" ? { quality: "high", size: "1024x1024" } : {}),
        provider: { allow_fallbacks: false },
        ...(references.length ? { input_references: references } : {}),
      });
      stage = "image_validation";
      await writeJsonAtomic(path, { status: "started", model, stage });
      if (!Array.isArray(generated.data) || generated.data.length !== 1) throw new OpenRouterError("生图接口未返回一张真实图片。");
      const image = await saveGeneratedImage(this.config.dataDir, generated.data[0], request.prompt, model);
      const response: ChatResponse = { text: "", model, images: [image], usage: this.usage(generated.usage) };
      await writeJsonAtomic(path, { status: "completed", response });
      return response;
    } catch (error) {
      const safe = error instanceof OpenRouterError ? error.message
        : stage === "model_check" ? "生图模型目录查询失败。"
        : stage === "image_validation" ? "图片已返回，但下载、校验或保存失败。"
        : "生图网络请求失败或结果不确定。";
      await writeJsonAtomic(path, { status: "failed", model, stage, error: safe,
        ...(error instanceof OpenRouterError && error.diagnostic ? { diagnostic: error.diagnostic } : {}) });
      throw new OpenRouterError(safe);
    }
  }
  close(): Promise<void> { return this.operations.drain(); }
}
