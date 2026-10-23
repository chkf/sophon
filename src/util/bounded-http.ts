/** Bound decompressed response size even when Content-Length is absent or dishonest. */
export async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel(); throw new Error("Response exceeds size limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response body.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("Response exceeds size limit."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export function trustedHttps(value: string, suffixes: string[]): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !suffixes.some(s => url.hostname === s || url.hostname.endsWith("." + s))) {
    throw new Error("Untrusted service URL.");
  }
  return url;
}
