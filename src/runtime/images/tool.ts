import { createHash } from "node:crypto";
import { OpenRouterError } from "../openrouter-error.js";
import type { ChatRequest, ChatResponse, ImageGenerationRequest, RuntimeImage, RuntimeTool } from "../types.js";
export const IMAGE_TOOL = "gateway_generate_image";

/** Per-turn adapter: one attempt, narrow paid request, and acknowledged image evidence. */
export class ImageTool {
  attempted = false;
  readonly images: RuntimeImage[] = [];
  readonly definition: RuntimeTool;
  constructor(private readonly turn: ChatRequest, private readonly autonomous: boolean,
    private readonly generate: (request: ImageGenerationRequest) => Promise<ChatResponse>) {
    this.definition = {
      name: IMAGE_TOOL,
      description: (autonomous ? "用户已授权主动生图：可以在日常聊天中自由生成图片，让交流更有趣，不必等待用户要求。" : "按本轮用户要求生成或编辑一张图片。") +
        "只有图片生成走付费 OpenRouter。提示词只写必要的视觉内容，不复制聊天历史、Gateway 规则、Core、Persona 或 Recent。不要制造真实经历。每轮最多一次尝试，失败不得重试。",
      parameters: { type: "object", properties: { prompt: { type: "string" },
        use_input_image: { type: "boolean" } },
        required: ["prompt"], additionalProperties: false },
    };
  }
  async execute(args: Record<string, unknown>): Promise<{ output: unknown; response?: ChatResponse }> {
    if (this.attempted) return { output: { success: false, error: "本轮生图已尝试，禁止重复调用。" } };
    this.attempted = true;
    try {
      if (typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 4000 ||
          (args.use_input_image !== undefined && typeof args.use_input_image !== "boolean")) throw new Error("提示词或参数无效。");
      const reference = args.use_input_image ? this.turn.attachments?.find(a => a.kind === "image") : undefined;
      if (args.use_input_image && !reference) throw new Error("本轮没有参考图片。");
      const operationId = this.turn.operationId ?? createHash("sha256")
        .update(JSON.stringify([this.turn.sessionId, this.turn.messages, this.turn.text])).digest("hex");
      const response = await this.generate({ operationId: operationId + ":image", prompt: args.prompt,
        autonomous: this.autonomous, ...(reference ? { reference } : {}) });
      const image = response.images?.[0];
      if (!image) throw new Error("图片输出为空。");
      this.images.push(image);
      return { response, output: { success: true, image: { model: image.model, sha256: image.sha256,
        mimeType: image.mimeType, width: image.width, height: image.height }, delivery: "由 Gateway 发送真实图片，不输出本地路径。" } };
    } catch (error) {
      // The OpenRouter adapter already strips upstream bodies, prompts and credentials.
      const safe = error instanceof OpenRouterError ? error.message
        : error instanceof Error && ["提示词或参数无效。", "本轮没有参考图片。", "图片输出为空。"].includes(error.message) ? error.message
        : "生图工具异常，未自动重试。";
      return { output: { success: false, error: safe } };
    }
  }
}
