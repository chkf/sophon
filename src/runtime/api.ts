import { ChatCompletionsRuntime, type ApiConfig } from "./chat-completions.js";
export type { ApiConfig } from "./chat-completions.js";
export { ApiError } from "./api-error.js";

/** Configured Chat Completions endpoint. No discovery, account or provider extensions. */
export class ApiRuntime extends ChatCompletionsRuntime {
  constructor(config: ApiConfig & { dataDir: string; fetch?: typeof fetch }) {
    super({ dataDir: config.dataDir, fetch: config.fetch, baseUrl: config.baseUrl,
      apiKey: config.apiKey, defaultModel: config.defaultModel,
      vision: config.vision, heartbeat: config.heartbeat, stream: config.stream }, "api");
  }
}
