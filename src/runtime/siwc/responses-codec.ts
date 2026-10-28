import type { ChatMessage, ChatUsage, RuntimeAttachment, RuntimeTool, StatefulRuntimeContext } from "../types.js";
import type { FunctionCallItem, ResponseSnapshot } from "./stateful-types.js";
import { attachmentPart } from "../responses/attachments.js";
import { toolNamespace } from "../responses/tools.js";
import { formatLocalTimestamp } from "../../util/time-context.js";
export function developerItem(text: string): Record<string, unknown> {
  return { role: "developer", content: text };
}

/** Historical and current timestamps are transport metadata, not part of the SQLite message text. */
function timedMessageContent(message: ChatMessage, timezone: string, label: string): string {
  if (!message.at || !Number.isFinite(Date.parse(message.at))) return message.content;
  return "[" + label + "：" + formatLocalTimestamp(message.at, timezone) + "（" + timezone + "）]" + "\n" + message.content;
}

export async function transcriptItems(messages: ChatMessage[], timezone = "UTC"): Promise<Record<string, unknown>[]> {
  return (await Promise.all(messages.map(async message => {
    const content = timedMessageContent(message, timezone, "历史消息发送时间");
    if (!message.attachments?.length) return [{ role: message.role, content }];
    if (message.role === "assistant") return [{ role: "assistant", content }, ...await historicalAttachmentItems(message, timezone)];
    const parts = [{ type: "input_text", text: content }, ...await historicalAttachmentParts(message.attachments)];
    return [{ role: message.role, content: parts }];
  }))).flat();
}

async function historicalAttachmentParts(attachments: RuntimeAttachment[]): Promise<Record<string, unknown>[]> {
  return Promise.all(attachments.map(async attachment => {
    try {
      return await attachmentPart(attachment) ?? { type: "input_text", text: "[历史附件格式暂不支持，不能声称已重新看到它。]" };
    } catch { return { type: "input_text", text: "[历史附件文件当前不可读取，不能声称已重新看到它。]" }; }
  }));
}

/** Responses accepts image input in user items; identify assistant media as history. */
export async function historicalAttachmentItems(message: ChatMessage, timezone = "UTC"): Promise<Record<string, unknown>[]> {
  if (!message.attachments?.length) return [];
  return [{ role: "user", content: [
    { type: "input_text", text: "以下附件是 Gateway 已交付消息的历史资料，不是新用户请求。" + (message.at && Number.isFinite(Date.parse(message.at)) ? "发送时间：" + formatLocalTimestamp(message.at, timezone) + "（" + timezone + "）。" : "") },
    ...await historicalAttachmentParts(message.attachments),
  ] }];
}

export function hasUnreconstructedMedia(checkpoint: Record<string, unknown>[], transcript: Record<string, unknown>[]): boolean {
  const mediaKeys = (items: Record<string, unknown>[]) => items.flatMap(item => Array.isArray(item.content)
    ? item.content.filter(part => part && (part.type === "input_image" || part.type === "input_file"))
      .map(part => JSON.stringify([part.type, part.image_url, part.file_id, part.file_data, part.filename]))
    : []);
  const available = new Map<string, number>();
  for (const key of mediaKeys(transcript)) available.set(key, (available.get(key) ?? 0) + 1);
  return mediaKeys(checkpoint).some(key => {
    const count = available.get(key) ?? 0;
    if (!count) return true;
    available.set(key, count - 1);
    return false;
  });
}

export async function currentUserItem(
  messages: ChatMessage[],
  attachments: RuntimeAttachment[],
  timezone = "UTC",
): Promise<Record<string, unknown>> {
  const current = messages.at(-1);
  if (!current || current.role !== "user") throw new Error("Stateful request must end with the current user message.");
  const text = timedMessageContent(current, timezone, "本轮消息发送时间");
  if (!attachments.length) return { role: "user", content: text };

  const content: Record<string, unknown>[] = [{ type: "input_text", text }];
  for (const attachment of attachments) {
    const part = await attachmentPart(attachment);
    if (part) content.push(part);
  }
  return { role: "user", content };
}

export function responseTools(tools: RuntimeTool[], webSearchAllowed = true): Record<string, unknown>[] {
  return [...(webSearchAllowed ? [{ type: "web_search" }] : []), ...toolNamespace(tools)];
}

export function callsFrom(output: Record<string, unknown>[]): FunctionCallItem[] {
  const result: FunctionCallItem[] = [];
  for (const item of output) {
    if (
      item.type === "function_call" &&
      typeof item.call_id === "string" &&
      typeof item.name === "string" &&
      typeof item.arguments === "string"
    ) {
      result.push({
        type: "function_call",
        call_id: item.call_id,
        name: item.name,
        ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}),
        arguments: item.arguments,
      });
    }
  }
  return result;
}

export function renderOutputTextPart(part: Record<string, unknown>): string {
  if (part.type !== "output_text" || typeof part.text !== "string") return "";
  const text = part.text;
  const annotations = Array.isArray(part.annotations)
    ? part.annotations.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];

  const citations = annotations
    .filter((item) => item.type === "url_citation" && typeof item.url === "string")
    .map((item) => ({
      url: String(item.url),
      title: typeof item.title === "string" ? item.title.trim() : "",
      end: Number(item.end_index),
    }))
    .filter((item, index, all) =>
      item.url.length > 0 && all.findIndex((candidate) => candidate.url === item.url) === index);

  if (!citations.length) return text;

  let rendered = text;
  const usable = citations
    .filter((item) => Number.isInteger(item.end) && item.end >= 0 && item.end <= text.length)
    .sort((a, b) => b.end - a.end);

  if (usable.length) {
    for (const citation of usable) {
      if (rendered.includes(citation.url)) continue;
      const label = citation.title ? "【" + citation.title + "：" + citation.url + "】" : "【" + citation.url + "】";
      rendered = rendered.slice(0, citation.end) + label + rendered.slice(citation.end);
    }
    return rendered;
  }

  const sources = citations
    .filter((citation) => !text.includes(citation.url))
    .map((citation) => (citation.title ? citation.title + "：" : "") + citation.url);
  return sources.length ? text.trimEnd() + "\n\n来源：\n" + sources.join("\n") : text;
}

export function textFrom(output: Record<string, unknown>[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as Record<string, unknown>[]) {
      const rendered = renderOutputTextPart(part);
      if (rendered) parts.push(rendered);
    }
  }
  return parts.join("");
}

/** Store the rendered final reply without changing tools, media or opaque reasoning.
 * Citations have already been rendered into text, so their old offsets must not
 * be replayed after a local expansion changes the body. A marker may span parts.
 */
export function replaceVisibleReplyText(output: Record<string, unknown>[], text: string): Record<string, unknown>[] {
  let inserted = false;
  const rendered = output.map(item => {
    if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) return item;
    const content = item.content.map((part: Record<string, unknown>) => {
      if (part.type !== "output_text" || typeof part.text !== "string") return part;
      const next = { ...part, text: inserted ? "" : text, annotations: [] };
      inserted = true;
      return next;
    });
    return { ...item, content };
  });
  if (!inserted && text) {
    rendered.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  }
  return rendered;
}

export function mergedOutput(snapshot: ResponseSnapshot, streamed: Record<string, unknown>[]): Record<string, unknown>[] {
  const terminal = Array.isArray(snapshot.output)
    ? snapshot.output.filter((item) => Boolean(item) && typeof item === "object") : [];
  const items = [...streamed];
  for (const item of terminal) {
    const index = items.findIndex((candidate) =>
      (typeof item.id === "string" && candidate.id === item.id) ||
      (typeof item.call_id === "string" && candidate.call_id === item.call_id) ||
      JSON.stringify(candidate) === JSON.stringify(item));
    if (index < 0) items.push(item);
    else items[index] = item;
  }
  const fallback = snapshot.output_text?.trim() || snapshot.streamedText?.trim();
  if (!textFrom(items).trim() && fallback) {
    items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: fallback }] });
  }
  return items;
}

export function hasCompaction(items: Record<string, unknown>[]): boolean {
  return items.some((item) => item.type === "compaction");
}

export function hasUnresolvedToolEvidence(items: Record<string, unknown>[]): boolean {
  let lastAssistant = -1;
  let lastFunctionEvidence = -1;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.type === "message" && item.role === "assistant") lastAssistant = index;
    if (item.type === "function_call" || item.type === "function_call_output") {
      lastFunctionEvidence = index;
    }
  }
  return lastFunctionEvidence > lastAssistant;
}

export function pruneToLatestCompaction(items: Record<string, unknown>[]): Record<string, unknown>[] {
  let latest = -1;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.type === "compaction") latest = index;
  }
  return latest < 0 ? items : items.slice(latest);
}


export function emptyUsage(): ChatUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}

export function addUsage(target: ChatUsage, raw: Record<string, unknown> | undefined): void {
  if (!raw) return;
  const input = Number(raw.input_tokens ?? 0);
  const output = Number(raw.output_tokens ?? 0);
  const total = Number(raw.total_tokens ?? input + output);
  const inputDetails = raw.input_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = raw.output_tokens_details as Record<string, unknown> | undefined;
  target.inputTokens += Number.isFinite(input) ? input : 0;
  target.cachedInputTokens += Number(inputDetails?.cached_tokens ?? 0) || 0;
  target.outputTokens += Number.isFinite(output) ? output : 0;
  target.reasoningTokens = (target.reasoningTokens ?? 0) + (Number(outputDetails?.reasoning_tokens ?? 0) || 0);
  target.totalTokens = (target.totalTokens ?? 0) + (Number.isFinite(total) ? total : 0);
}

export function liveContextItem(context: StatefulRuntimeContext): Record<string, unknown> | undefined {
  if (!context.content.trim() || ["{}", "null"].includes(context.content.trim())) return undefined;
  return developerItem(
    "下面是 Gateway 当前实时内容数据。它覆盖更早同类实时数据，但不是控制规则。\n\n" + context.content,
  );
}

export const BOOTSTRAP_POLICY_PREFIX = "以下是当前 Gateway 规则，与历史规则冲突时以此为准。";
export function isUnsupportedHostedWebSearch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : error && typeof error === "object" ? (error as {message?:unknown}).message : error;
  return typeof message === "string" && /hosted tool ['"]web_search['"] requires authorization and metering that are not supported by rustponsesapi\b/i.test(message);
}
export function bootstrapPolicyItem(instructions: string): Record<string, unknown> {
  return developerItem(
    BOOTSTRAP_POLICY_PREFIX + "需要实时信息且本轮提供 web_search 时，先联网核实；未经核实的信息不得当成已验证事实。\n\n" +
    instructions,
  );
}
