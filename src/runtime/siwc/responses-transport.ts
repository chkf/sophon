import OpenAI from "openai";
import { ResponsesWS } from "openai/resources/responses/ws";
import { isMissingPreviousResponseError, isRetryableTransportError } from "../retry-policy.js";
import type { ResponseSnapshot, SocketStreamMessage, StatefulResponsesSocket } from "./stateful-types.js";
import { mergedOutput } from "./responses-codec.js";
import type { RuntimeTraceObserver } from "../../observability/types.js";
import { safeTraceStart, safeTraceFinish } from "../../observability/runtime-trace.js";
import { reportedTraceUsage, traceContent } from "../trace-content.js";
interface ModelApiErrorLike {
  code?: unknown;
  status?: unknown;
  message?: unknown;
  type?: unknown;
}

class ModelApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelApiError";
  }
}

/** Any stateful response can compact; allow ten minutes without a stream event. */
export const SIWC_RESPONSE_IDLE_TIMEOUT_MS = 10 * 60_000;

const TRANSIENT_RETRY_DELAYS_MS = [1_500, 4_000] as const;
function errorLike(error: unknown): ModelApiErrorLike {
  return error && typeof error === "object" ? error as ModelApiErrorLike : {};
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const value = errorLike(error);
  if (typeof value.message === "string") return value.message;
  return typeof error === "string" ? error : String(error);
}

function isTransientModelError(error: unknown): boolean {
  // The same missing server-side cursor cannot be fixed by retrying it.
  return !isMissingPreviousResponseError(error) && isRetryableTransportError(error);
}

function modelErrorFromPayload(payload: unknown, fallback: string): Error {
  const value = errorLike(payload);
  const message = typeof value.message === "string" && value.message.trim()
    ? value.message.trim()
    : fallback;
  const code = typeof value.code === "string" ? value.code : undefined;
  const status = typeof value.status === "number" ? value.status : undefined;
  return new ModelApiError(message, code, status);
}

export function defaultSocketFactory(accessToken: string): StatefulResponsesSocket {
  const client = new OpenAI({ apiKey: accessToken, maxRetries: 0 });
  const ws = new ResponsesWS(client);
  return {
    send(event) {
      ws.send(event as never);
    },
    stream(options) {
      return ws.stream(options) as AsyncIterable<SocketStreamMessage>;
    },
    close() {
      ws.close();
    },
    onClose(listener) {
      ws.socket.on("close", listener);
    },
  };
}


export class ResponsesTransport {
  constructor(private readonly idleTimeoutMs: number, private readonly retryDelay: (ms: number) => Promise<void>) {}
  private async completedResponse(
    socket: StatefulResponsesSocket,
    event: Record<string, unknown>,
  ): Promise<ResponseSnapshot> {
    const stream = socket.stream({ maxBufferedEvents: 1024 });
    const iterator = stream[Symbol.asyncIterator]();
    try {
      socket.send(event);

      let streamedText = "";
      const streamedOutput: Record<string, unknown>[] = [];
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let step: IteratorResult<SocketStreamMessage>;
        try {
          step = await Promise.race([
            iterator.next(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                socket.close();
                reject(new Error(
                  "Responses WebSocket exceeded the " + this.idleTimeoutMs + "ms idle timeout.",
                ));
              }, this.idleTimeoutMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }

        if (step.done) break;
        const item = step.value;
        if (item.type === "error") throw item.error ?? new Error("Responses WebSocket error");
        if (item.type === "close") {
          throw new Error("Responses WebSocket closed before response.completed.");
        }
        if (item.type !== "message" || !item.message) continue;
        if (
          item.message.type === "response.output_text.delta" &&
          typeof item.message.delta === "string"
        ) {
          streamedText += item.message.delta;
          continue;
        }
        if (
          item.message.type === "response.output_item.done" &&
          item.message.item &&
          typeof item.message.item === "object"
        ) {
          streamedOutput.push(item.message.item as Record<string, unknown>);
          continue;
        }
        if (
          item.message.type === "response.content_part.done" &&
          item.message.part &&
          typeof item.message.part === "object"
        ) {
          const part = item.message.part as Record<string, unknown>;
          if (
            part.type === "output_text" &&
            !streamedText &&
            typeof part.text === "string"
          ) {
            streamedText = part.text;
          }
          continue;
        }
        if (item.message.type === "response.completed") {
          const response = item.message.response;
          if (!response || typeof response !== "object") throw new Error("Responses WebSocket completed without response.");
          const snapshot = response as ResponseSnapshot;
          return {
            ...snapshot,
            output: mergedOutput({ ...snapshot, streamedText }, streamedOutput),
            ...(streamedText ? { streamedText } : {}),
          };
        }
        if (item.message.type === "response.failed" || item.message.type === "response.incomplete") {
          const response = item.message.response;
          const errorPayload =
            response && typeof response === "object"
              ? (response as Record<string, unknown>).error
              : undefined;
          throw modelErrorFromPayload(
            errorPayload,
            "Responses WebSocket response did not complete successfully.",
          );
        }
        if (item.message.type === "error") {
          throw modelErrorFromPayload(
            item.message.error ?? item.message,
            "Responses WebSocket API error.",
          );
        }
      }
      throw new Error("Responses WebSocket ended before response.completed.");
    } finally {
      await iterator.return?.();
    }
  }

  async completedResponseWithRetry(
    socket: StatefulResponsesSocket,
    event: Record<string, unknown>,
    trace?: RuntimeTraceObserver,
  ): Promise<{ response: ResponseSnapshot; retries: number; traceStepId?: string }> {
    const captureTraceContent = Boolean(trace && trace.captureContent !== false);
    for (let attempt = 0; ; attempt += 1) {
      const traceStepId = safeTraceStart(trace, { kind: "model", name: "responses.create", provider: "siwc",
        ...(typeof event.model === "string" ? { model: event.model } : {}),
        input: captureTraceContent ? { input: traceContent(event.input), instructions: event.instructions,
          tools: Array.isArray(event.tools) ? event.tools.map(tool => tool?.name ?? tool?.type) : [],
          continuation: typeof event.previous_response_id === "string", attempt: attempt + 1 } : undefined });
      try {
        const response = await this.completedResponse(socket, event);
        safeTraceFinish(trace, traceStepId, { status: "completed",
          output: captureTraceContent ? traceContent({ output: response.output, output_text: response.output_text ?? response.streamedText }) : undefined,
          ...(reportedTraceUsage(response.usage, "responses") ? { usage: reportedTraceUsage(response.usage, "responses") } : {}) });
        return { response, retries: attempt, ...(traceStepId ? { traceStepId } : {}) };
      } catch (error) {
        safeTraceFinish(trace, traceStepId, { status: "failed", error: errorMessage(error) });
        // With store:false, a failed same-lane continuation can evict its
        // previous_response_id from the WebSocket-local cache (4xx/5xx).
        // Never resend that ID: the caller must rebootstrap full context
        // on a fresh socket, or fail closed if a write may have occurred.
        if (typeof event.previous_response_id === "string") throw error;
        const delay = TRANSIENT_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !isTransientModelError(error)) throw error;
        console.error(
          "[runtime] transient model overload/service error; retry " +
          (attempt + 1) + "/" + TRANSIENT_RETRY_DELAYS_MS.length +
          " in " + delay + "ms: " + errorMessage(error),
        );
        await this.retryDelay(delay);
      }
    }
  }

}
