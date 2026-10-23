import { boundedBytes } from "../../util/bounded-http.js";
interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
  };
}

export class TelegramBotApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly errorCode: number | undefined,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TelegramBotApiError";
  }
}

export class TelegramBotApi {
  constructor(private readonly token: string) {}

  private endpoint(method: string): string {
    return "https://api.telegram.org/bot" + this.token + "/" + method;
  }

  async call<T>(
    method: string,
    body: Record<string, unknown>,
    timeoutMs = 35_000,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
    let payloadBody: string | FormData = JSON.stringify(body);
    const multipart = Object.values(body).some(value => value instanceof Blob);
    if (multipart) {
      const form = new FormData();
      for (const [key, value] of Object.entries(body)) {
        if (value instanceof Blob) form.append(key, value, value.type === "audio/ogg" ? "voice.ogg" : value.type === "image/jpeg" ? "generated.jpg" : value.type === "image/webp" ? "generated.webp" : "generated.png");
        else form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
      payloadBody = form;
    }
    const response = await fetch(this.endpoint(method), {
      method: "POST",
      ...(multipart ? {} : { headers: { "content-type": "application/json" } }),
      body: payloadBody,
      signal,
    });
    const payload = (await response.json()) as TelegramEnvelope<T>;
    if (!response.ok || !payload.ok || payload.result === undefined) {
      throw new TelegramBotApiError(
        method,
        payload.error_code,
        payload.description ?? "Telegram Bot API " + method + " failed.",
        typeof payload.parameters?.retry_after === "number"
          ? payload.parameters.retry_after
          : undefined,
      );
    }
    return payload.result;
  }

  async getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }> {
    return this.call("getFile", { file_id: fileId });
  }

  async downloadFile(filePath: string, maxBytes: number): Promise<Uint8Array> {
    const url = "https://api.telegram.org/file/bot" + this.token + "/" + filePath;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error("Telegram file download failed with HTTP " + response.status + ".");
    const length = Number(response.headers.get("content-length") || 0);
    if (length > maxBytes) throw new Error("Telegram attachment exceeds the configured media limit.");
    const bytes = new Uint8Array(await boundedBytes(response, maxBytes));
    if (bytes.byteLength > maxBytes) throw new Error("Telegram attachment exceeds the configured media limit.");
    return bytes;
  }
}
