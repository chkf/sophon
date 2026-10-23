/** Byte framing only. Protocol consumers own completion, events and tool loops. */
export async function* readSseData(response: Response, options: { maxBytes?: number; onActivity?: () => void } = {}): AsyncGenerator<string> {
  if (!response.body) throw new Error("SSE stream empty.");
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let pending = "", total = 0; let data: string[] = [];
  const frames: string[] = [];
  const line = (value: string) => {
    if (!value) { if (data.length) frames.push(data.join("\n")); data = []; }
    else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.value?.byteLength) {
        options.onActivity?.(); total += chunk.value.byteLength;
        if (total > (options.maxBytes ?? Infinity)) throw new Error("SSE stream exceeds limit.");
      }
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let consumed = 0;
      for (let index = 0; index < pending.length; index++) {
        if (pending[index] !== "\n" && pending[index] !== "\r") continue;
        if (pending[index] === "\r" && index === pending.length - 1 && !chunk.done) break;
        line(pending.slice(consumed, index));
        if (pending[index] === "\r" && pending[index + 1] === "\n") index++;
        consumed = index + 1;
      }
      pending = pending.slice(consumed);
      if (chunk.done) { if (pending) line(pending); line(""); }
      while (frames.length) yield frames.shift()!;
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
