import assert from "node:assert/strict";
import test from "node:test";
import { historyFromMessages } from "./history.js";
import { HISTORY_TOOL, readHistoryTool, withHistoryTool } from "./history-tool.js";
import { isProactiveMessage } from "./message-provenance.js";

test("legacy delivery classification requires a valid heartbeat identity and respects explicit origin", () => {
  assert.equal(isProactiveMessage({ role: "assistant", id: "heartbeat:2026-10-11T00:00:00Z:image:assistant" }), true);
  for (const id of ["ordinary:assistant", "heartbeat:invalid:text:assistant", "heartbeat:2026-10-11T00:00:00Z:user"]) assert.equal(isProactiveMessage({ role: "assistant", id }), false);
  assert.equal(isProactiveMessage({ role: "assistant", origin: "chat", id: "heartbeat:2026-10-11T00:00:00Z:text:assistant" }), false);
});

test("shared history dates, match pagination and immutable boundary retain source metadata", async () => {
  const messages = Array.from({ length: 6 }, (_, i) => ({ role: "user" as const, id: "original:" + i,
    at: `2026-10-${String(5 + i).padStart(2, "0")}T12:00:00Z`, content: "约定 " + i }));
  const history = historyFromMessages(messages);
  messages.push({ role: "user", id: "later", at: "2026-10-11T12:00:00Z", content: "约定 后来" });
  const first = await readHistoryTool(history, { query: "约定" }) as any;
  const next = await readHistoryTool(history, { query: "约定", offset: first.nextOffset }) as any;
  assert.equal(first.total, 6); assert.equal(first.entries.length, 4); assert.equal(next.entries.length, 2);
  assert.equal(next.nextOffset, null); assert.equal(next.entries[0].id, "original:4");
  const dates = await readHistoryTool(history, { from: "2026-10-07T20:00:00+08:00", to: "2026-10-09T12:00:00Z" }) as any;
  assert.deepEqual(dates.entries.map((m: any) => m.index), [2, 3, 4]);
  assert.equal((await readHistoryTool(history, { index: 2 }) as any).entries[0].at, "2026-10-07T12:00:00Z");
  await assert.rejects(readHistoryTool(history, { index: 6 }), /范围/);
});

test("history rejects invalid or mixed cursors and does not invent missing timestamps", async () => {
  const history = historyFromMessages([{ role: "assistant", content: "旧消息" }]);
  for (const args of [{ offset: -1 }, { offset: "0" }, { index: 0, char_offset: 20 }, { char_offset: 0 }, { index: 0, query: "旧" },
    { from: "昨天" }, { from: "2026-10-11T00:00:00" }, { from: "2026-10-12T00:00:00Z", to: "2026-10-11T00:00:00Z" }, { path: "another-conversation" }]) {
    await assert.rejects(readHistoryTool(history, args));
  }
  assert.equal((await readHistoryTool(history, {}) as any).entries[0].at, undefined);
  assert.equal((await readHistoryTool(history, { from: "2026-10-01T00:00:00Z" }) as any).total, 0);
});

test("shared history tool is read-only, registered once and forwards semantic tools", async () => {
  const calls: string[] = [];
  const source = { history: historyFromMessages([{ role: "user", content: "只读原文" }]),
    tools: [{ name: "gateway_memory", parameters: {} }], async executeTool(name: string, _args: Record<string, unknown>) { calls.push(name); return { ok: true }; } };
  const request = withHistoryTool(withHistoryTool(source));
  assert.equal(request.tools.filter(t => t.name === HISTORY_TOOL).length, 1);
  assert.equal((request.tools.find(t => t.name === HISTORY_TOOL) as any).readOnly, true);
  assert.equal((await request.executeTool(HISTORY_TOOL, {}) as any).entries[0].content, "只读原文");
  await request.executeTool("gateway_memory", {});
  assert.deepEqual(calls, ["gateway_memory"]);
});
