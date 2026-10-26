import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import type { ChannelName } from "../channels/types.js";


export interface TelegramConfig {
  token: string;
  ownerId: string;
  stickerIds?: string[];
}

export interface HeartbeatConfig {
  enabled: boolean;
  planningEnabled?: boolean;
  channel?: ChannelName;
  timezone: string;
  quietStart: string;
  quietEnd: string;
  cooldownMinutes: number;
  dailyCap: number;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
}

export interface GatewayConfig {
  memoryGraphEnabled?: boolean;
  memoryGraphState?: 'missing_owner' | 'preparation_failed';
  dataDir: string;
  files?: { enabled: boolean; generatedDir: string };
  recentReview?: { enabled: boolean };
  control?: { publicUrl: string; tunnel?: "cloudflare" };
  logDir?: string;
  siwcDevkitDir: string;
  model?: string;
  provider?: "api" | "siwc" | "openrouter";
  api?: { baseUrl?: string; apiKey?: string; defaultModel?: string; contextWindow: number; vision: boolean; heartbeat: boolean; stream: boolean };
  openrouter?: { apiKey?: string; defaultModel?: string; imageModel?: string; webSearch: boolean; heartbeat: boolean };
  credentialKeyFile?: string;
  maxToolRounds: number;
  telegram?: TelegramConfig;
  ilink?: { enabled: true };
  voice?: import("../voice/bailian.js").VoiceConfig;
  server: {
    host: string;
    port: number;
  };
  heartbeat: HeartbeatConfig;
}

function loadLocalEnv(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) loadEnvFile(envPath);
}

function integer(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(name + " must be an integer >= " + min + ".");
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(name + " must be true or false.");
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function channel(value?: string): ChannelName | undefined {
  if (!value) return undefined;
  if (value === "telegram" || value === "wechat") return value;
  throw new Error("GATEWAY_HEARTBEAT_CHANNEL must be telegram or wechat.");
}

function apiBaseUrl(): string | undefined {
  const value = optional("GATEWAY_API_BASE_URL");
  if (!value) return undefined;
  const message = "GATEWAY_API_BASE_URL must be an HTTP(S) API base URL without credentials, query, fragment or /chat/completions suffix.";
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(message); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      /\/chat\/completions\/?$/.test(url.pathname)) throw new Error(message);
  return url.href.replace(/\/+$/, "");
}

export function controlPublicUrl(value: string): string {
  const message = "GATEWAY_CONTROL_PUBLIC_URL must be an HTTPS /control/ URL, or HTTP on localhost/127.0.0.1/[::1], without credentials, query or fragment.";
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(message); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/control/") throw new Error(message);
  return url.href;
}

export function controlTunnelUrl(value: unknown): string | undefined {
  if(typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if(url.protocol === "https:" && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com$/.test(url.hostname) &&
       !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/control/") return url.href;
  } catch {}
  return undefined;
}

export function loadConfig(): GatewayConfig {
  loadLocalEnv();

  const tunnel = optional("GATEWAY_CONTROL_TUNNEL") ?? "off";
  if(!["off", "cloudflare"].includes(tunnel)) throw new Error("GATEWAY_CONTROL_TUNNEL must be off or cloudflare.");
  const temporaryUrl = process.env.SOPHON_MANAGED_HOST === "1" ? controlTunnelUrl(optional("SOPHON_CONTROL_TUNNEL_URL")) : undefined;
  const telegramToken = optional("TELEGRAM_BOT_TOKEN");
  const telegramOwner = optional("TELEGRAM_OWNER_ID");
  if (["WECHAT_TOKEN", "WECHAT_APP_ID", "WECHAT_APP_SECRET", "WECHAT_OWNER_OPENID"].some(name => optional(name))) {
    throw new Error("旧微信公众号接入已移除。请从运行配置移除 WECHAT_TOKEN/WECHAT_APP_ID/WECHAT_APP_SECRET/WECHAT_OWNER_OPENID，改用 GATEWAY_ILINK_ENABLED=true 并在 Telegram /proactive 扫码绑定；历史与备份无需删除。");
  }
  const model = optional("GATEWAY_MODEL");

  const minIntervalMinutes = integer("GATEWAY_HEARTBEAT_MIN_MINUTES", 60, 1);
  const maxIntervalMinutes = integer("GATEWAY_HEARTBEAT_MAX_MINUTES", 120, 1);
  if (maxIntervalMinutes < minIntervalMinutes) {
    throw new Error("Heartbeat max interval must be >= min interval.");
  }

  const provider = optional("GATEWAY_PROVIDER") ?? "api";
  if (provider !== "api" && provider !== "siwc" && provider !== "openrouter") throw new Error("GATEWAY_PROVIDER must be api, siwc or openrouter.");

  return {
    provider,
    api: {
      baseUrl: apiBaseUrl(),
      apiKey: optional("GATEWAY_API_KEY"),
      defaultModel: optional("GATEWAY_API_MODEL"),
      contextWindow: integer("GATEWAY_API_CONTEXT_WINDOW", 32768, 8192),
      vision: bool("GATEWAY_API_VISION", false),
      heartbeat: bool("GATEWAY_API_HEARTBEAT_ENABLED", false),
      stream: bool("GATEWAY_API_STREAM", true),
    },
    openrouter: {
      apiKey: optional("OPENROUTER_API_KEY"),
      defaultModel: optional("OPENROUTER_DEFAULT_MODEL"),
      imageModel: optional("OPENROUTER_IMAGE_MODEL"),
      webSearch: bool("OPENROUTER_WEB_SEARCH", false),
      heartbeat: bool("OPENROUTER_HEARTBEAT_ENABLED", false),
    },
    memoryGraphEnabled: bool("GATEWAY_MEMORY_GRAPH_ENABLED", true),
    dataDir: resolve(process.env.GATEWAY_DATA_DIR ?? "./data"),
    files: {
      enabled: bool("GATEWAY_FILES_ENABLED", false),
      generatedDir: resolve(optional("GATEWAY_GENERATED_FILES_DIR") ?? resolve(process.env.GATEWAY_DATA_DIR ?? "./data", "files/generated")),
    },
    recentReview: { enabled: bool("GATEWAY_RECENT_REVIEW_ENABLED", false) },
    ...(tunnel === "cloudflare" ? {control: {tunnel: "cloudflare" as const, publicUrl: temporaryUrl ?? "https://pending.trycloudflare.com/control/"}} : optional("GATEWAY_CONTROL_PUBLIC_URL") ? { control: { publicUrl: controlPublicUrl(optional("GATEWAY_CONTROL_PUBLIC_URL")!) } } : {}),
    ...(optional("GATEWAY_LOG_DIR") ? { logDir: resolve(optional("GATEWAY_LOG_DIR")!) } : {}),
    siwcDevkitDir: resolve(process.env.GATEWAY_SIWC_DEVKIT_DIR ?? "./vendor/siwc"),
    ...(model ? { model } : {}),
    ...(optional("GATEWAY_CREDENTIAL_KEY_FILE") ? { credentialKeyFile: resolve(optional("GATEWAY_CREDENTIAL_KEY_FILE")!) } : {}),
    maxToolRounds: integer("GATEWAY_MAX_TOOL_ROUNDS", 0, 0),
    ...(telegramToken && telegramOwner ? { telegram: {
      token: telegramToken, ownerId: telegramOwner,
      stickerIds: (optional("GATEWAY_TELEGRAM_STICKER_IDS") ?? "").split(",").map(value => value.trim()).filter(Boolean).slice(0, 12),
    } } : {}),
    ...(bool("GATEWAY_ILINK_ENABLED", false) ? { ilink: { enabled: true as const } } : {}),
    voice: { apiKey: optional("DASHSCOPE_API_KEY"), baseUrl: optional("GATEWAY_VOICE_BASE_URL") },
    server: {
      host: process.env.GATEWAY_HOST?.trim() || "127.0.0.1",
      port: integer("GATEWAY_PORT", 8790, 1),
    },
    heartbeat: {
      enabled: bool("GATEWAY_HEARTBEAT_ENABLED", false),
      planningEnabled: bool("GATEWAY_HEARTBEAT_DAILY_PLANNING", false),
      channel: channel(optional("GATEWAY_HEARTBEAT_CHANNEL")),
      timezone: process.env.GATEWAY_TIMEZONE?.trim() || "UTC",
      quietStart: process.env.GATEWAY_QUIET_START?.trim() || "01:00",
      quietEnd: process.env.GATEWAY_QUIET_END?.trim() || "07:00",
      cooldownMinutes: integer("GATEWAY_HEARTBEAT_COOLDOWN_MINUTES", 60, 0),
      dailyCap: integer("GATEWAY_HEARTBEAT_DAILY_CAP", 8, 0),
      minIntervalMinutes,
      maxIntervalMinutes,
    },
  };
}

export function validateServeConfig(config: GatewayConfig): void {
  if (config.control) {
    controlPublicUrl(config.control.publicUrl);
    if (!["127.0.0.1", "::1", "localhost"].includes(config.server.host)) {
      throw new Error("启用控制中心时 GATEWAY_HOST 必须为回环地址；公网访问请仅反向代理 /control/。");
    }
    if (!config.telegram || !/^\d+$/.test(config.telegram.ownerId)) throw new Error("控制中心需要数字 Telegram 管理员 ID。");
  }
  if (config.ilink && !config.telegram) throw new Error("iLink 需要 Telegram 管理员配置与扫码绑定。");
  const partialTelegram = Boolean(optional("TELEGRAM_BOT_TOKEN")) !== Boolean(optional("TELEGRAM_OWNER_ID"));
  if (partialTelegram) throw new Error("Set both TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID, or neither.");

  if (!config.telegram) {
    throw new Error("请先配置 Telegram 管理员；微信可通过 iLink 扫码启用。");
  }
  if (config.heartbeat.enabled && config.heartbeat.channel === "telegram" && !config.telegram) {
    throw new Error("Heartbeat channel is telegram, but Telegram is not configured.");
  }
  if (config.heartbeat.enabled && config.heartbeat.channel === "wechat" && !config.ilink) {
    throw new Error("主动消息渠道是微信，但 iLink 尚未启用。");
  }
}
