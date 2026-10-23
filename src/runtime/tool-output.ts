export function safeToolOutput(value: unknown): string {
  const text = JSON.stringify(value) ?? "null";
  if (text.length <= 128_000) return text;
  return JSON.stringify({ truncated: true, preview: text.slice(0, 128_000) });
}
