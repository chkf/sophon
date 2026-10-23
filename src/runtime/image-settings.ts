import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../util/atomic-json.js";
import type { ImageSettings } from "./types.js";

export const IMAGE_PRESETS = [
  { id: "economy", label: "省钱 · FLUX.2 Klein 4B", model: "black-forest-labs/flux.2-klein-4b" },
  { id: "balanced", label: "均衡 · Nano Banana 2.1", model: "google/gemini-nano-banana-2.1" },
  { id: "premium", label: "精品 · GPT Image 2.5 Sunburst", model: "openai/gpt-image-2.5-sunburst" },
] as const;
interface State { route?: "provider" | "openrouter"; proactive: boolean; model?: string; date?: string; attempts?: number; lastAttempt?: string }

/** Transport-only authorization and attempt budget; separate from persistent context. */
export class ImageSettingsStore {
  private readonly path: string;
  constructor(dataDir: string, private readonly defaultModel?: string, private readonly timezone = "UTC") {
    this.path = join(dataDir, "runtime", "openrouter-images.json");
  }
  private async read(): Promise<State> {
    const state = await readJsonFile<State>(this.path, { proactive: false });
    if ((state.route !== undefined && state.route !== "provider" && state.route !== "openrouter") || typeof state.proactive !== "boolean" || (state.model !== undefined && typeof state.model !== "string") ||
      (state.attempts !== undefined && (!Number.isSafeInteger(state.attempts) || state.attempts < 0)) ||
      (state.lastAttempt !== undefined && !Number.isFinite(Date.parse(state.lastAttempt)))) {
      throw new Error("生图授权状态无效，已停止主动生图。");
    }
    return state;
  }
  async get(): Promise<ImageSettings> {
    const state = await this.read();
    const model = state.model ?? this.defaultModel;
    return { route: state.route ?? "provider", proactive: state.proactive, model, preset: IMAGE_PRESETS.find(p => p.model === model)?.id,
      dailyLimit: 10 };
  }
  async setRoute(route: "provider" | "openrouter"): Promise<ImageSettings> {
    if (route !== "provider" && route !== "openrouter") throw new Error("生图路线无效。");
    await writeJsonAtomic(this.path, { ...await this.read(), route });
    return this.get();
  }
  async select(model: string): Promise<ImageSettings> {
    await writeJsonAtomic(this.path, { ...await this.read(), model });
    return this.get();
  }
  async enable(proactive: boolean): Promise<ImageSettings> {
    await writeJsonAtomic(this.path, { ...await this.read(), proactive });
    return this.get();
  }
  private eligible(state: State, now: Date): boolean {
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: this.timezone }).format(now);
    return state.proactive && (state.date !== date || (state.attempts ?? 0) < 10);
  }
  async available(now = new Date()): Promise<boolean> { return this.eligible(await this.read(), now); }
  /** Caller serializes operations. Reserve before network; failed/ambiguous attempts count. */
  async reserve(now = new Date()): Promise<void> {
    const state = await this.read();
    if (!this.eligible(state, now)) throw new Error("主动生图关闭或每日次数用完。");
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: this.timezone }).format(now);
    await writeJsonAtomic(this.path, { ...state, date, attempts: (state.date === date ? state.attempts ?? 0 : 0) + 1,
      lastAttempt: now.toISOString() });
  }
}
