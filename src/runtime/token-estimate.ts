/** UTF-8 estimate for diagnostics and explicitly configured provider tests, not a model capacity check. */
export function estimatedTextTokens(text: string): number { return Math.ceil(Buffer.byteLength(text, "utf8") / 2); }
