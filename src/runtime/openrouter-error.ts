/** Stable, non-sensitive classification of an upstream API rejection. Never store upstream text. */
export interface OpenRouterFailureDiagnostic {
  httpStatus: number;
  category: "unsupported_parameter" | "unsupported_image_model" | "invalid_model" |
    "no_matching_endpoint" | "content_policy" | "invalid_prompt" | "other_bad_request" | "upstream_error";
  upstreamCode?: string;
  upstreamType?: string;
}

/** Reads a bounded error body for classification, discarding raw text and private prompts. */
export async function safeOpenRouterFailure(response: Response): Promise<OpenRouterFailureDiagnostic> {
  const status = response.status;
  const fallback: OpenRouterFailureDiagnostic = {
    httpStatus: status, category: status === 400 ? "other_bad_request" : "upstream_error",
  };
  const reader = response.body?.getReader();
  if (!reader) return fallback;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8192) break;
      parts.push(part.value);
    }
  } catch { return fallback; }
  finally { await reader.cancel().catch(() => undefined); }
  let rawError: any;
  try {
    const payload = JSON.parse(Buffer.concat(parts).toString("utf8"));
    rawError = payload && typeof payload === "object" ? payload.error : undefined;
  } catch { return fallback; }
  if (!rawError || typeof rawError !== "object") return fallback;
  // The upstream message/metadata might echo a sensitive prompt. Inspect in memory only.
  const description = JSON.stringify(rawError).slice(0, 8192);
  const category: OpenRouterFailureDiagnostic["category"] =
    /no provider.{0,100}supports.{0,100}parameter|unsupported.{0,40}parameter|parameter.{0,40}not supported/i.test(description) ? "unsupported_parameter" :
    /does not support image output|image output not supported/i.test(description) ? "unsupported_image_model" :
    /no model found|unknown model|model not found/i.test(description) ? "invalid_model" :
    /no endpoint found|no endpoint.{0,60}model|no matching provider/i.test(description) ? "no_matching_endpoint" :
    /content.policy|content.filter|moderation|safety.filter|unsafe content|nsfw|blocked.*content/i.test(description) ? "content_policy" :
    /invalid prompt|prompt.{0,40}(?:invalid|too long|empty|required)/i.test(description) ? "invalid_prompt" :
    fallback.category;
  const identifier = (value: unknown): string | undefined =>
    typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/i.test(value) ? value : undefined;
  const upstreamCode = identifier(rawError.code);
  const upstreamType = identifier(rawError.type);
  return { httpStatus: status, category, ...(upstreamCode ? { upstreamCode } : {}),
    ...(upstreamType ? { upstreamType } : {}) };
}

export class OpenRouterError extends Error {
  readonly code = "openrouter_no_retry";
  readonly retryable = false;
  constructor(message: string, readonly diagnostic?: OpenRouterFailureDiagnostic) {
    super(message);
    this.name = "OpenRouterError";
  }
}
