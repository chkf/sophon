import type { ChatMessage, RuntimeHistory, RuntimeHistoryEntry } from "./types.js";

function cursor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("历史游标必须是非负整数。");
}

/** A fixed transcript boundary, with lazy reads and source timestamps preserved. */
export function createHistory(count: number, read: (offset: number, limit: number) => Promise<ChatMessage[]>): RuntimeHistory {
  cursor(count);
  const readRange = async (offset: number, limit: number) => {
    cursor(offset); cursor(limit);
    return read(offset, Math.min(limit, Math.max(0, count - offset)));
  };
  return { count, readRange,
    readTail: limit => { cursor(limit); return readRange(Math.max(0, count - limit), limit); },
    async search(query, offset, limit, before = count, dates = {}) {
      cursor(offset); cursor(limit); cursor(before);
      const from = dates.from === undefined ? -Infinity : Date.parse(dates.from);
      const to = dates.to === undefined ? Infinity : Date.parse(dates.to);
      if (Number.isNaN(from) || Number.isNaN(to) || from > to) throw new Error("历史日期范围无效。");
      let total = 0; const entries: RuntimeHistoryEntry[] = [];
      const end = Math.min(before, count), keyword = query.toLowerCase();
      for (let start = 0; start < end; start += 128) {
        const messages = await readRange(start, Math.min(128, end - start));
        for (const [i, message] of messages.entries()) {
          if (message.role === "developer" || (keyword && !message.content.toLowerCase().includes(keyword))) continue;
          const at = message.at === undefined ? NaN : Date.parse(message.at);
          if ((dates.from !== undefined || dates.to !== undefined) && (!Number.isFinite(at) || at < from || at > to)) continue;
          if (total >= offset && entries.length < limit) entries.push({ index: start + i, role: message.role, content: message.content,
            ...(message.id !== undefined ? { id: message.id } : {}), ...(message.at !== undefined ? { at: message.at } : {}) });
          total++;
        }
      }
      return { total, entries, nextOffset: offset + limit < total ? offset + limit : null };
    },
  };
}

export function historyFromMessages(messages: ChatMessage[]): RuntimeHistory {
  return createHistory(messages.length, async (offset, limit) => messages.slice(offset, offset + limit));
}

/** Read a fixed snapshot in batches without dropping messages to fit a local budget. */
export async function readHistoryMessages(history: RuntimeHistory, start = 0): Promise<ChatMessage[]> {
  cursor(start);
  const end = history.count;
  if (start > end) throw new Error("历史游标超出本轮会话范围。");
  const messages: ChatMessage[] = [];
  for (let offset = start; offset < end; offset += 256) {
    const length = Math.min(256, end - offset);
    const batch = await history.readRange(offset, length);
    if (batch.length !== length) throw new Error("历史快照发生变化，未发送不完整的对话。");
    messages.push(...batch);
  }
  return messages;
}
