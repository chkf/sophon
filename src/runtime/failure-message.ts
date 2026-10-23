import { inboundRetryAfterMs, isSubscriptionUsageLimitError } from "./retry-policy.js";

interface RuntimeErrorLike {
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

function errorLike(error: unknown): RuntimeErrorLike {
  return error && typeof error === "object" ? error as RuntimeErrorLike : {};
}

function text(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

const REAUTH_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export function runtimeFailureReply(error: unknown): string {
  if (errorLike(error).code === "attachment_unreadable") return text(error);
  if (["openrouter_no_retry", "api_no_retry"].includes(String(errorLike(error).code))) return text(error);
  const value = errorLike(error);
  const code = typeof value.code === "string" ? value.code : "";
  const status = typeof value.status === "number" ? value.status : undefined;
  const detail = text(error);

  if (/unsupported.{0,40}(?:image|file|media|mime)|(?:image|file|media).{0,40}(?:not supported|cannot (?:read|process))|invalid.{0,20}(?:image|file)_?(?:format|type)/i.test(detail)) {
    return "当前 Provider 或模型无法读取该附件格式，请改发受支持的图片、PDF 或文字，或在 TG /model 选择支持该附件的模型。";
  }

  if (isSubscriptionUsageLimitError(error)) {
    return "ChatGPT 额度暂时用完，请在额度恢复后重试。";
  }

  if (
    code === "subscription_sharing_usage_unavailable" ||
    detail.includes("subscription_sharing_usage_unavailable")
  ) {
    return "暂时无法查询 ChatGPT 用量状态，请稍后重试。";
  }

  if (REAUTH_CODES.has(code)) {
    return "ChatGPT 登录已失效，请重新登录后继续。";
  }

  if (status === 429) {
    return "ChatGPT 请求受到限流，请稍后重试。";
  }

  return "本次模型连接未成功，消息未标记为已回复。请稍后重试。";
}

export function runtimeFailureRetryAfterMs(error: unknown): number | undefined {
  if (errorLike(error).code === "attachment_unreadable") return undefined;
  if (["openrouter_no_retry", "api_no_retry"].includes(String(errorLike(error).code))) return undefined;
  return inboundRetryAfterMs(error);
}
