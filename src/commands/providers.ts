import type { ProviderId } from "../runtime/types.js";

export const PROVIDERS: readonly ProviderId[] = ["api", "siwc", "openrouter"];
export const providerLabel = (provider: string | undefined): string => provider === "api" ? "通用 API" : provider ?? "未知";
export const isProvider = (value: unknown): value is ProviderId => typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
export const isPaidProvider = (provider: unknown): boolean => provider === "api" || provider === "openrouter";
export const API_UNSUPPORTED_IMAGES = "通用 API 暂不支持生图或内置联网搜索。";
