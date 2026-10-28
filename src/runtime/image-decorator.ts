import { ImageTool } from "./images/tool.js";
import { OpenRouterError } from "./openrouter-error.js";
import type { ChatRequest, ChatResponse, ManagedChatRuntime } from "./types.js";

export async function replyWithPaidImages(runtime: ManagedChatRuntime, imagesRuntime: ManagedChatRuntime, request: ChatRequest): Promise<ChatResponse> {
    // Existing installations never opt in to the paid image side channel implicitly.
    const settings = await imagesRuntime.getImageSettings?.();
    const autonomous = request.allowImageGeneration !== true;
    const enabled = request.purpose !== "heartbeat_plan" && settings?.route === "openrouter" && request.imageOutputAllowed === true &&
      Boolean(imagesRuntime.generateImage) && await imagesRuntime.canGenerateImage?.(autonomous);
    if (!enabled) return runtime.reply(request);
    const imageTool = new ImageTool(request, autonomous, imageRequest => imagesRuntime.generateImage!(imageRequest));
    const images = imageTool.images;
    const executeTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      request.authorizeTool?.(name);
      if (name === imageTool.definition.name) return (await imageTool.execute(args)).output;
      if (!request.executeTool || !(request.getTools?.() ?? request.tools)?.some(t => t.name === name)) throw new Error("工具未授权。");
      return request.executeTool(name, args);
    };
    try {
      const response = await runtime.reply({ ...request, tools: [...(request.tools ?? []), imageTool.definition],
        getTools: () => [...(request.getTools?.() ?? request.tools ?? []), imageTool.definition], executeTool });
      if (images.length) return { ...response, images };
      if (imageTool.attempted || request.allowImageGeneration) return { ...response,
        text: "本轮没有成功生成图片。" + (response.text ? "\n" + response.text : ""),
        ...(response.replySegments ? { replySegments: [{kind:"text" as const,text:"本轮没有成功生成图片。"}, ...response.replySegments] } : {}) };
      return response;
    } catch (error) {
      // Keep successfully paid-for bytes even if the SIWC continuation fails.
      if (images.length) return { text: "图片已生成，后续文字回复未完成。", images };
      if (imageTool.attempted) throw new OpenRouterError("图片调用后本轮未完成，不自动重试，避免重复消费。");
      throw error;
    }
  }
