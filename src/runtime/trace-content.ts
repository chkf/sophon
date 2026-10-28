import type { ChatUsage } from "./types.js";

const VISIBLE_FIELDS = ["type", "id", "role", "content", "text", "name", "arguments", "call_id", "tool_call_id", "tool_calls", "function", "output", "output_text", "annotations", "url_citation", "url", "title", "file_name", "filename", "action", "query", "queries", "sources", "status", "description", "parameters", "properties", "required", "enum", "items", "additionalProperties", "minimum", "maximum", "maxLength", "minLength", "anyOf", "uniqueItems", "maxItems"] as const;
const TRUNCATED = "[trace projection truncated]";

/**
 * Only visible protocol fields enter owner-facing traces. Projection itself is
 * bounded and best effort: it runs before the recorder and must not change the
 * outcome of a provider request, even for malformed plugin/test transport data.
 */
export function traceContent(value: unknown): unknown {
  let nodes = 1200, characters = 64_000;
  const seen = new WeakSet<object>();
  const walk = (item: unknown, depth: number, schema = false): unknown => {
    if (nodes-- <= 0 || depth > (schema ? 12 : 6)) return TRUNCATED;
    try {
      if (typeof item === "string") {
        if (item.startsWith("data:")) return "[media bytes omitted]";
        if (characters <= 0) return TRUNCATED;
        const length = Math.min(item.length, characters, 24_000);
        characters -= length;
        return item.slice(0,length) + (length < item.length ? TRUNCATED : "");
      }
      if (item === null || typeof item === "boolean") return item;
      if (typeof item === "number") return Number.isFinite(item) ? item : null;
      if (typeof item !== "object") return undefined;
      if (seen.has(item)) return TRUNCATED;
      seen.add(item);
      if (Array.isArray(item)) {
        const result: unknown[] = [];
        const length = Math.min(item.length,40);
        for (let i=0;i<length;i++) {
          if (nodes <= 0 || characters <= 0) { result.push(TRUNCATED); break; }
          const visible = walk(item[i],depth+1,schema);
          if (visible !== undefined) result.push(visible);
        }
        if (item.length > length) result.push(TRUNCATED);
        return result;
      }
      const object = item as Record<string,unknown>;
      const type = object.type;
      if (type === "reasoning" || type === "compaction") return undefined;
      const result: Record<string,unknown> = {};
      for (const key of schema ? Object.keys(object).slice(0,60) : VISIBLE_FIELDS) {
        if (nodes <= 0 || characters <= 0) { result.trace_projection = TRUNCATED; break; }
        const field = object[key];
        if (field !== undefined) {
          const visible = walk(field,depth+1,schema || key === "parameters");
          if (visible !== undefined) result[key] = visible;
        }
      }
      if (type === "input_image" || type === "image_url" || type === "input_file") result.media = "[media bytes omitted]";
      return result;
    } catch { return "[trace projection unavailable]"; }
  };
  return walk(value,0);
}

/** Missing upstream fields stay absent instead of being converted to zero. */
export function reportedTraceUsage(raw: unknown, format: "chat" | "responses"): Partial<ChatUsage> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const result: Partial<ChatUsage> = {};
  const take = (key: keyof ChatUsage, input: unknown) => {
    if (typeof input === "number" && Number.isFinite(input) && input >= 0) result[key] = input;
  };
  const inputDetails = value[format === "chat" ? "prompt_tokens_details" : "input_tokens_details"] as Record<string, unknown> | undefined;
  const outputDetails = value[format === "chat" ? "completion_tokens_details" : "output_tokens_details"] as Record<string, unknown> | undefined;
  take("inputTokens", value[format === "chat" ? "prompt_tokens" : "input_tokens"]);
  take("outputTokens", value[format === "chat" ? "completion_tokens" : "output_tokens"]);
  take("cachedInputTokens", inputDetails?.cached_tokens);
  take("reasoningTokens", outputDetails?.reasoning_tokens);
  take("totalTokens", value.total_tokens);
  take("costUsd", value.cost);
  return Object.keys(result).length ? result : undefined;
}

export function tracedToolStatus(output: unknown): "completed" | "failed" {
  if (!output || typeof output !== "object") return "completed";
  const result = output as Record<string, unknown>;
  return result.success === false || result.ok === false || typeof result.error === "string" ? "failed" : "completed";
}
