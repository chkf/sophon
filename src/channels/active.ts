import type { RuntimeImage } from "../runtime/types.js";
import { join } from "node:path";
import type { ChannelName, ProactiveSender, ProactiveDelivery, PlatformMessageFragment } from "./types.js";
import { readJsonFile, writeJsonAtomic } from "../util/atomic-json.js";

export type ActiveProactiveChannel = ChannelName | "off";

interface ActiveChannelState {
  active: ActiveProactiveChannel;
}

export interface ProactiveRoute {
  channel: ChannelName;
  target: string;
}

export class ActiveChannelRouter {
  private readonly statePath: string;

  constructor(
    dataDir: string,
    private readonly senders: Partial<Record<ChannelName, ProactiveSender>>,
    private readonly defaultChannel: ActiveProactiveChannel,
    private readonly enabled: () => Promise<boolean> = async () => true,
  ) {
    this.statePath = join(dataDir, "channels", "active.json");
  }

  async getActive(): Promise<ActiveProactiveChannel> {
    const state = await readJsonFile<ActiveChannelState>(this.statePath, { active: this.defaultChannel });
    return state.active === "telegram" || state.active === "wechat" || state.active === "off"
      ? state.active
      : this.defaultChannel;
  }

  isConfigured(channel: ChannelName): boolean {
    return Boolean(this.senders[channel]);
  }

  async setActive(channel: ActiveProactiveChannel): Promise<void> {
    if (channel !== "off" && !this.isConfigured(channel)) {
      throw new Error(channel === "telegram" ? "Telegram 还没有配置。" : "微信还没有配置。");
    }
    await writeJsonAtomic(this.statePath, { active: channel } satisfies ActiveChannelState);
  }

  async isActive(channel: ChannelName): Promise<boolean> {
    return await this.enabled() && (await this.getActive()) === channel;
  }

  async resolve(): Promise<ProactiveRoute | undefined> {
    if (!await this.enabled()) return undefined;
    const channel = await this.getActive();
    if (channel === "off") return undefined;
    const sender = this.senders[channel];
    if (!sender) return undefined;
    const target = await sender.availableTarget();
    return target ? { channel, target } : undefined;
  }

  availableStickers(channel: ChannelName): number {
    return this.senders[channel]?.availableStickers?.() ?? 0;
  }

  async sendStickerIfActive(channel: ChannelName, target: string, index: number): Promise<boolean> {
    if (!(await this.isActive(channel))) return false;
    const sender = this.senders[channel];
    if (!sender?.sendSticker || !Number.isInteger(index) || index < 1 ||
      index > (sender.availableStickers?.() ?? 0)) return false;
    await sender.sendSticker(target, index);
    return true;
  }

  async sendImagesIfActive(channel: ChannelName, target: string, images: RuntimeImage[], deliveryId: string): Promise<boolean> {
    if (!(await this.isActive(channel))) return false;
    const sender = this.senders[channel];
    if (!sender?.sendImages) return false;
    await sender.sendImages(target, images, deliveryId);
    return true;
  }

  async sendIfActive(channel: ChannelName, target: string, text: string, voiceText?: string, onPlatformMessages?: (fragments: PlatformMessageFragment[]) => void, delivery?: ProactiveDelivery): Promise<boolean> {
    if (!(await this.isActive(channel))) return false;
    const sender = this.senders[channel];
    if (!sender) return false;
    const fragments = sender.sendProactiveText ? await sender.sendProactiveText(target, text, voiceText, delivery) : await sender.sendText(target, text);
    if (fragments?.length) onPlatformMessages?.(fragments);
    return true;
  }
}
