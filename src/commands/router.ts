import { IMAGE_PRESETS } from "../runtime/image-settings.js";
import { HOST_TEST_SCRIPTS, isHostTestScript, type HostTestRunner } from "./host-tests.js";
import type { InboundMessage } from "../channels/types.js";
import type { ActiveChannelRouter, ActiveProactiveChannel } from "../channels/active.js";
import type { CommandRuntime } from "../runtime/types.js";
import type { ExpressionStore } from "../expression/store.js";
import { API_UNSUPPORTED_IMAGES, isProvider, providerLabel } from "./providers.js";

export const TELEGRAM_COMMANDS = [
  { command: "retry", description: "重试失败的待回复消息" },
  { command: "expression", description: "开启或关闭心理和动作描写" },
  { command: "model", description: "Provider/聊天模型/生图设置" },
  { command: "proactive", description: "选择 Telegram/微信/关闭主动消息" },
  { command: "logs", description: "查看最近 15 分钟日志" },
  { command: "test", description: "打开诊断面板" },
  { command: "status", description: "打开 Sophon 控制中心" },
] as const;

interface ParsedCommand {
  name: string;
  args: string;
}

function parseCommand(text: string): ParsedCommand | undefined {
  const match = text.trim().match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return undefined;
  return { name: match[1]!.toLowerCase(), args: (match[2] ?? "").trim() };
}

function channelLabel(channel: ActiveProactiveChannel): string {
  if (channel === "telegram") return "Telegram";
  if (channel === "wechat") return "微信";
  return "关闭";
}


export type GatewayLogReader = () => Promise<string>;

export class GatewayCommandRouter {
  constructor(
    private readonly runtime: CommandRuntime,
    private readonly channels: ActiveChannelRouter,
    private readonly logReader?: GatewayLogReader,
    private readonly testRunner?: HostTestRunner,
    _expressions?: ExpressionStore,
    private readonly controlEntry?: (message: InboundMessage) => string | Promise<string>,
  ) {}

  async handle(message: InboundMessage): Promise<string | undefined> {
    const parsed=parseCommand(message.text);
    if (/^npm\s+run(?:\s|$)/i.test(message.text.trim())) return "请使用 /test 诊断面板。";
    if (parsed?.name === "model" && (parsed.args==='memory'||parsed.args.startsWith('memory '))) {
      return this.execute(message);
    }
    if (parsed && ["model","expression","proactive","test","logs"].includes(parsed.name)) {
      return "请发送 /"+parsed.name+"，通过面板按钮操作。";
    }
    if (parsed?.name === "channel") return "此入口已改为 /proactive。";
    return this.execute(message);
  }

  /** Internal operations for authenticated panels; not a text-command entrypoint. */
  async execute(message: InboundMessage): Promise<string | undefined> {
    if (message.channel === "telegram" && /^npm\s+run(?:\s|$)/i.test(message.text.trim())) {
      const script = message.text.trim().match(/^npm run ([a-z:]+)$/)?.[1] ?? "";
      return isHostTestScript(script)
        ? this.hostTest(script)
        : "仅支持白名单测试，不接受参数或其他 shell 命令。发送 /test 查看可用指令。";
    }
    const parsed = parseCommand(message.text);
    if (!parsed) return undefined;

    switch (parsed.name) {
      case "status":
        if (parsed.args) return "请直接发送 /status 获取控制中心入口。";
        return this.controlEntry ? this.controlEntry(message) : "控制中心未启用；请配置 GATEWAY_CONTROL_PUBLIC_URL。";
      case "retry":
        return "恢复待回复消息仅在所有者的 Telegram 私聊提供。";
      case "expression":
        return "请发送 /expression，通过面板切换心理和动作描写。";
      case "model":
        return this.modelCommand(parsed.args);
      case "channel":
        return this.channel(parsed.args);
      case "logs":
        return this.logs(parsed.args);
      case "update":
        return this.update(parsed.args);
      case "test":
        return message.channel === "telegram" ? this.hostTest(parsed.args) : "Host 测试仅在 Telegram 私聊可用。";
      default:
        return "这个命令不存在。";
    }
  }

  private async image(args: string): Promise<string> {
    try {
      if(await this.runtime.getProvider?.()==="api")return API_UNSUPPORTED_IMAGES;
      if (!this.runtime.getImageSettings) return "当前运行方式没有生图设置。";
      const match = args.match(/^proactive (on|off)$/);
      if (match) {
        if (!this.runtime.setProactiveImages) return "主动生图设置不可用。";
        await this.runtime.setProactiveImages(match[1] === "on");
      } else if (args === "route openrouter" || args === "route provider") {
        if (!this.runtime.selectImageRoute) return "生图路线设置不可用。";
        await this.runtime.selectImageRoute(args.endsWith("openrouter") ? "openrouter" : "provider");
      } else if (args.startsWith("model ")) {
        if (!this.runtime.selectImageModel) return "生图模型切换不可用。";
        await this.runtime.selectImageModel(args.slice(6).trim());
      } else if (args) return "用法：/model image；/model image proactive on|off；/model image model economy|balanced|premium|<model_id>|auto；/model image route openrouter|provider";
      const state = await this.runtime.getImageSettings();
      return ["Provider：" + (await this.runtime.getProvider?.() ?? "未知"),
        "生图路线：" + (state.route === "openrouter" ? "独立 OpenRouter（SIWC 聊天也可生图）" : "跟随聊天 Provider（SIWC 不调用付费生图）"),
        "生图模型：" + (state.model ?? "未配置"), "主动与明确请求生图共用上述模型", "主动生图：" + (state.proactive ? "开启" : "关闭"),
        ...IMAGE_PRESETS.map(p => p.id + "：" + p.label),
        "切换：/model image model balanced；开关：/model image proactive on 或 off",
        "仅 Telegram 生效，不自动切换聊天 Provider。独立路线：/model image route openrouter",
        "主动尝试每天最多 " + state.dailyLimit + " 次（北京时间），无冷却间隔；失败也计数。",
        "SIWC 下聊天和主动判断使用套餐；独立路线仅把必要提示词/参考图片发给 OpenRouter。",
        "OpenRouter 聊天模式的后台文字判断也收费；图片次数限制不等于美元消费上限。",
      ].join("\n");
    } catch { return "生图设置未完成：请检查 OpenRouter Key、文字/生图模型可用性或本地状态；不会自动替换模型。"; }
  }

  private async modelCommand(args: string): Promise<string> {
    if (args === "provider" || args.startsWith("provider ")) return this.provider(args.slice("provider".length).trim());
    if (args === "image" || args.startsWith("image ")) return this.image(args.slice("image".length).trim());
    if (args === "memory" || args.startsWith("memory ")) {
      if (!this.runtime.listMemoryModels || !this.runtime.getMemoryModel || !this.runtime.selectMemoryModel) return "记忆模型设置不可用。";
      const model=args.slice(6).trim();
      if (model) return "记忆分类模型已设为："+await this.runtime.selectMemoryModel(model);
      return "记忆分类模型（SIWC）："+await this.runtime.getMemoryModel()+"\n"+(await this.runtime.listMemoryModels()).map(m=>m.id).join("\n");
    }
    return this.model(args);
  }

  private async provider(args: string): Promise<string> {
    if (!this.runtime.getProvider || !this.runtime.selectProvider) return "当前运行方式未启用 Provider 切换。";
    if (args && !isProvider(args)) return "用法：/model provider [api|siwc|openrouter]";
    try {
      if (isProvider(args)) await this.runtime.selectProvider(args);
      const current = await this.runtime.getProvider();
      let model = "未配置或不可用";
      try { const selection = await this.runtime.getModelSelection(); model = selection.model ?? selection.resolvedModel ?? model; } catch {}
      const status = current==="api"?[]:await this.runtime.providerStatus?.() ?? [];
      return [args ? "已切换。" : "当前状态：", "Provider：" + providerLabel(current) + "；模型：" + model,
        ...status.map(item => providerLabel(item.provider) + "：" + (item.available ? "可用" : "未配置或不可用")),
        current === "api" ? "使用自行配置的 API 端点和模型；本页连接未验证，可在 /test 显式测试。后续聊天及已启用的后台活动可能收费。\n"+API_UNSUPPORTED_IMAGES : current === "openrouter" ? "OpenRouter 使用付费 API 额度；正式聊天和已启用的后台 Heartbeat 任务都可能产生费用；不会自动切换付费模型。" : "SIWC 使用 ChatGPT 套餐额度。",
      ].join("\n");
    } catch { return "Provider 未配置、认证失败或默认模型不可用，切换未完成。"; }
  }

  private async model(args: string): Promise<string> {
    try {
      const models = await this.runtime.listModels();
      if (!models.length) return "当前没有可用模型。";

      const pageMatch = args.match(/^page\s+(\d+)$/i);
      if (!args || pageMatch) {
        const current = await this.runtime.getModelSelection();
        const title = current.mode === "auto"
          ? "当前：Auto → " + (current.resolvedModel ?? "未知")
          : "当前：" + (current.model ?? current.resolvedModel ?? "未知");
        const pageSize = 12;
        const pages = Math.ceil(models.length / pageSize);
        const page = pageMatch ? Number(pageMatch[1]) : 1;
        if (page < 1 || page > pages) return "模型页码无效。";
        const options = models.slice((page - 1) * pageSize, page * pageSize).map((model, index) =>
          ((page - 1) * pageSize + index + 1) + ". " + model.displayName.slice(0, 60) + " · " + model.id.slice(0, 120)
        );
        return [
          (await this.runtime.getProvider?.()) ? "Provider：" + providerLabel(await this.runtime.getProvider?.()) + "\n" + title : title,
          "",
          ...options,
          "",
          "切换：/model 2、/model <slug> 或 /model auto",
          ...(pages > 1 ? ["第 " + page + "/" + pages + " 页；翻页：/model page <页码>"] : []),
        ].join("\n");
      }

      if (args.toLowerCase() === "auto") {
        const selected = await this.runtime.selectModel();
        return ((await this.runtime.getProvider?.()) ? "Provider：" + providerLabel(await this.runtime.getProvider?.()) + "\n" : "") + "已切到 Auto → " + (selected.resolvedModel ?? "默认模型");
      }

      const index = Number(args);
      const selectedId = Number.isInteger(index) && index >= 1 && index <= models.length
        ? models[index - 1]!.id
        : args;
      const selected = await this.runtime.selectModel(selectedId);
      return ((await this.runtime.getProvider?.()) ? "Provider：" + providerLabel(await this.runtime.getProvider?.()) + "\n" : "") + "已切到 " + (selected.model ?? selected.resolvedModel ?? selectedId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return message.startsWith("Model ") ? "这个模型当前不可用。" : "暂时无法切换模型。";
    }
  }

  private async hostTest(args: string): Promise<string> {
    if (!args) return "可用测试：\n" + HOST_TEST_SCRIPTS.map((script) => "npm run " + script).join("\n") + "\n\n发送完整指令即可运行，也可使用 /test runtime:test。";
    if (!isHostTestScript(args)) return "不支持此测试。发送 /test 查看白名单。";
    if (!this.testRunner) return "当前 Host 测试功能不可用。";
    try {
      return await this.testRunner.run(args);
    } catch {
      return "测试执行出现异常，请查看服务器日志。";
    }
  }

  private async logs(args: string): Promise<string> {
    if (!this.logReader) return "当前运行方式没有可读取的 Host 日志。";
    if (args) return "直接发送 /logs 就可以。";
    try {
      return await this.logReader();
    } catch (error) {
      console.error("[commands] log read failed:", error instanceof Error ? error.message : error);
      return "暂时读不到 Host 日志。";
    }
  }
  private async update(_args: string): Promise<string> { return "独立 Gateway 不提供远程自动更新。请在部署目录手动更新并重新启动。"; }

  private async setChannel(channel: ActiveProactiveChannel): Promise<string> {
    try {
      await this.channels.setActive(channel);
      return channel === "off"
        ? "主动消息已暂停。"
        : "主动消息已切到 " + channelLabel(channel) + "。";
    } catch (error) {
      return error instanceof Error ? error.message : "切换失败。";
    }
  }

  private async channel(args: string): Promise<string> {
    if (args === "telegram" || args === "wechat" || args === "off") return this.setChannel(args);
    if (args) return "用法：/channel [telegram|wechat|off]";
    const active = await this.channels.getActive();
    if (active === "off") return "主动消息：关闭";
    const suffix = this.channels.isConfigured(active) ? "" : "（未配置）";
    return "主动消息：" + channelLabel(active) + suffix;
  }
}
