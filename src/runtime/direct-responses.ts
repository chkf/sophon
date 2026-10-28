import { textFrom } from "./siwc/responses-codec.js";
import type { ReplySegment } from "./reply-segments.js";
import { readSseData } from "../util/sse.js";
import { attachmentPart } from "./responses/attachments.js";
import { toolNamespace } from "./responses/tools.js";
import { safeToolOutput } from "./tool-output.js";
import type { ChatMessage, RuntimeAttachment, RuntimeTool } from "./types.js";

interface FunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  namespace?: string;
  arguments: string;
}

interface StreamResult {
  text: string;
  outputItems: Record<string, unknown>[];
  calls: FunctionCallItem[];
}

export interface DirectResponseOptions {
  accessToken: string;
  model: string;
  messages: ChatMessage[];
  instructions?: string;
  attachments?: RuntimeAttachment[];
  tools?: RuntimeTool[];
  getTools?: () => RuntimeTool[];
  requiredTool?: () => string | undefined;
  authorizeTool?: (name: string) => void;
  executeTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  recordReplyText?: (text: string, id: string) => void;
  getPreparedReplySegments?: () => ReplySegment[];
  finalizeReplyText?: (text: string) => string;
  maxToolRounds?: number;
  endpoint?: string;
}

async function initialInput(messages: ChatMessage[], attachments: RuntimeAttachment[]): Promise<Record<string, unknown>[]> {
  const input: Record<string, unknown>[] = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  if (!attachments.length) return input;
  let userIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (input[index]?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return input;

  const original = messages[userIndex]?.content ?? "";
  const content: Record<string, unknown>[] = [{ type: "input_text", text: original }];
  for (const attachment of attachments) {
    const part = await attachmentPart(attachment);
    if (part) content.push(part);
  }
  input[userIndex] = { role: "user", content };
  return input;
}

async function parseSse(response: Response, onActivity?: () => void): Promise<StreamResult> {
  let completed = false;
  let text = "";
  const outputItems: Record<string, unknown>[] = [];

  const dispatch = (data: string) => {
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as Record<string, unknown>;
    const type = event.type;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
    } else if (type === "response.output_item.done" && event.item && typeof event.item === "object") {
      outputItems.push(event.item as Record<string, unknown>);
    } else if (type === "response.completed") {
      completed = true;
    } else if (type === "response.failed" || type === "response.incomplete" || type === "error") {
      throw new Error("Responses API stream failed: " + JSON.stringify(event));
    }
  };

  for await (const data of readSseData(response, { onActivity })) {
    dispatch(data);
    if (completed) break;
  }

  if (!completed) throw new Error("Responses API stream ended before response.completed.");
  const calls: FunctionCallItem[] = [];
  for (const item of outputItems) {
    if (
      item.type === "function_call" &&
      typeof item.call_id === "string" &&
      typeof item.name === "string" &&
      typeof item.arguments === "string"
    ) {
      calls.push({
        type: "function_call",
        call_id: item.call_id,
        name: item.name,
        ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}),
        arguments: item.arguments,
      });
    }
  }
  return { text, outputItems, calls };
}

export async function runDirectResponse(options: DirectResponseOptions): Promise<string> {
  const endpoint = options.endpoint ?? "https://api.openai.com/v1/responses";
  const input = await initialInput(options.messages, options.attachments ?? []);

  const maxToolRounds = options.maxToolRounds && options.maxToolRounds > 0
    ? options.maxToolRounds
    : undefined;
  let toolRounds = 0;

  for (;;) {
    const requiredTool = options.requiredTool?.();
    const offered = (options.getTools?.() ?? options.tools ?? []).filter(tool => !requiredTool || tool.name === requiredTool);
    const names = new Set(offered.map(tool => tool.name));
    const tools = toolNamespace(offered);
    const controller = new AbortController();
    const idleTimeoutMs = 300_000;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimeout = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        controller.abort(new Error("Responses API stream was idle for 5 minutes."));
      }, idleTimeoutMs);
    };
    armIdleTimeout();

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer " + options.accessToken,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: options.model,
          input,
          ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
          ...(tools.length ? { tools, parallel_tool_calls: false } : {}),
          ...(requiredTool ? {tool_choice:"required"} : {}),
          store: false,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 4000);
        throw new Error("Responses API HTTP " + response.status + ": " + detail);
      }

      const result = await parseSse(response, armIdleTimeout);
      if (idleTimer) clearTimeout(idleTimer);
      if (!result.calls.length) {
        if (options.requiredTool?.()) throw Error("模型未完成本轮必需的能力决策。");
        const text = options.finalizeReplyText?.(result.text) ?? result.text;
        if (!text.trim() && !options.getPreparedReplySegments?.().length) throw new Error("Responses API completed without a final text response.");
        return text;
      }
      if (!options.executeTool) throw new Error("Model requested a tool but no tool executor is configured.");
      if (maxToolRounds !== undefined && toolRounds >= maxToolRounds) {
        throw new Error("Gateway tool loop exceeded the configured maximum number of rounds.");
      }

      input.push(...result.outputItems);
      let cursor = 0;
      const record = (end: number) => {
        for (; cursor < end; cursor++) {
          const text = textFrom([result.outputItems[cursor]!]);
          if (text) options.recordReplyText?.(text,"direct:"+toolRounds+":"+cursor);
        }
      };
      // Older SSE streams may carry only text deltas before their calls.
      if (!textFrom(result.outputItems) && result.text) options.recordReplyText?.(result.text,"direct:"+toolRounds);
      for (const call of result.calls) {
      record(result.outputItems.findIndex(item=>item.type==="function_call" && item.call_id===call.call_id));
      if (call.namespace && call.namespace !== "gateway") {
        throw new Error("Unexpected tool namespace: " + call.namespace);
      }
      let args: Record<string, unknown>;
      try {
        const parsed = JSON.parse(call.arguments) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        args = parsed as Record<string, unknown>;
      } catch {
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({ error: "工具参数不是有效的 JSON 对象。" }),
        });
        continue;
      }

      try {
        if (!names.has(call.name)) throw Error("本次请求未提供该工具。");
        options.authorizeTool?.(call.name);
        const output = await options.executeTool(call.name, args);
        input.push({ type: "function_call_output", call_id: call.call_id, output: safeToolOutput(output) });
      } catch (error) {
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        });
      }
      }
      record(result.outputItems.length);
      toolRounds += 1;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }
}
