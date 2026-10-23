import { ChatCompletionsRuntime, type OpenRouterConfig } from "./chat-completions.js";
export type { OpenRouterConfig } from "./chat-completions.js";
export { OpenRouterError } from "./openrouter-error.js";

/** OpenRouter-specific discovery, account usage, search and optional image generation. */
export class OpenRouterRuntime extends ChatCompletionsRuntime {
  constructor(config: OpenRouterConfig) { super(config, "openrouter"); }
}
