interface RuntimeErrorLike {
  code?: unknown;
  status?: unknown;
  message?: unknown;
  inboundRetryable?: unknown;
  inboundManualRetryable?: unknown;
}

const REAUTH_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

const TRANSIENT_CODES = new Set([
  "server_error",
  "internal_server_error",
  "overloaded",
  "service_unavailable",
  "rate_limit_exceeded",
]);

function errorLike(error: unknown): RuntimeErrorLike {
  return error && typeof error === "object" ? error as RuntimeErrorLike : {};
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  const value = errorLike(error);
  if (typeof value.message === "string") return value.message;
  return typeof error === "string" ? error : String(error);
}

export function inboundRetryHint(error: unknown): boolean | undefined {
  const value = errorLike(error).inboundRetryable;
  return typeof value === "boolean" ? value : undefined;
}

export function inboundManualRetryHint(error: unknown): boolean | undefined {
  const value = errorLike(error).inboundManualRetryable;
  return typeof value === "boolean" ? value : undefined;
}

export function tagInboundRetryability(error: unknown, retryable: boolean, manualRetryable = retryable): Error {
  const target = error instanceof Error ? error : new Error(errorText(error));
  Object.defineProperty(target, "inboundRetryable", {
    value: retryable,
    configurable: true,
    enumerable: false,
    writable: true,
  });
  Object.defineProperty(target, "inboundManualRetryable", {
    value: manualRetryable, configurable: true, enumerable: false, writable: true,
  });
  return target;
}

export function isMissingPreviousResponseError(error: unknown): boolean {
  const value = errorLike(error);
  const code = typeof value.code === "string" ? value.code.toLowerCase() : "";
  const message = errorText(error).toLowerCase();
  return code === "previous_response_not_found" ||
    /previous response with id .* not found/.test(message) ||
    /previous_response_id.*(?:not found|unknown|invalid)/.test(message);
}

export function isSubscriptionUsageLimitError(error: unknown): boolean {
  const value = errorLike(error);
  const code = typeof value.code === "string" ? value.code.toLowerCase() : "";
  const message = errorText(error).toLowerCase();
  return code === "subscription_sharing_usage_limit_exceeded" ||
    message.includes("subscription_sharing_usage_limit_exceeded") ||
    message.includes("a chatgpt sharing limit has been reached");
}

export function isRetryableTransportError(error: unknown): boolean {
  const value = errorLike(error);
  const code = typeof value.code === "string" ? value.code.toLowerCase() : "";
  const status = typeof value.status === "number" ? value.status : undefined;
  const message = errorText(error).toLowerCase();

  if (
    isSubscriptionUsageLimitError(error) ||
    code === "subscription_sharing_usage_unavailable" ||
    REAUTH_CODES.has(code) ||
    message.includes("subscription_sharing_usage_unavailable")
  ) {
    return false;
  }

  // A missing Responses cursor is recoverable only by rebuilding local context.
  if (isMissingPreviousResponseError(error)) return true;
  if (TRANSIENT_CODES.has(code)) return true;
  if (status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }

  return (
    message.includes("responses websocket closed before response.completed") ||
    message.includes("responses websocket error") ||
    // SIWC sometimes reports a transient server failure with only a request ID,
    // without a structured status/code. Keep the inbound turn pending.
    message.includes("an error occurred while processing your request") ||
    message.includes("websocket exceeded") ||
    message.includes("network error") ||
    message.includes("network timeout") ||
    message.includes("fetch failed") ||
    message.includes("socket hang up") ||
    message.includes("connection reset") ||
    message.includes("connection closed") ||
    message.includes("connection lost") ||
    message.includes("connection failed") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("enetunreach") ||
    message.includes("ehostunreach") ||
    message.includes("etimedout") ||
    message.includes("timed out")
  );
}

export function inboundRetryAfterMs(error: unknown, defaultDelayMs = 5_000): number | undefined {
  // A safe manual replay hint must never turn a subscription limit into an automatic retry.
  if (isSubscriptionUsageLimitError(error)) return undefined;
  const hint = inboundRetryHint(error);
  if (hint === false) return undefined;
  if (hint === true) return defaultDelayMs;
  return isRetryableTransportError(error) ? defaultDelayMs : undefined;
}
