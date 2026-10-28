import assert from "node:assert/strict";
import test from "node:test";
import { createHistory } from "../history.js";
import { readRecoveryHistoryWindow } from "./history-window.js";
import type { ChatMessage } from "../types.js";

test("normal SIWC recovery replays complete SQLite history, independent of age", async () => {
  const messages: ChatMessage[] = Array.from({length: 100}, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: "x".repeat(1000) + String(i),
    at: new Date(Date.parse("2026-09-01T08:00:00Z") + i * 24 * 60 * 60_000).toISOString(),
  }));
  let scanned = 0;
  const history = createHistory(messages.length, async (offset, limit) => {
    scanned += 1;
    return messages.slice(offset, offset + limit);
  });
  const window = await readRecoveryHistoryWindow(history);
  assert.equal(window.expanded, false);
  assert.equal(window.truncated, false);
  assert.deepEqual(window.messages, messages);
  assert.equal(window.startSeq, 0);
  assert.equal(messages.length, 100, "SQLite source remains unchanged");
  assert.ok(scanned <= 1, "small test history is read lazily in one batch");
});

test("verified checkpoint cursor replays only new messages", async () => {
  const messages: ChatMessage[] = Array.from({ length: 70 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: "turn " + i,
    at: "2026-10-10T08:00:00Z",
  }));
  const offsets: number[] = [];
  const history = createHistory(messages.length, async (offset, limit) => {
    offsets.push(offset);
    return messages.slice(offset, offset + limit);
  });
  const window = await readRecoveryHistoryWindow(history, 60);
  assert.deepEqual(window.messages, messages.slice(60));
  assert.deepEqual(offsets, [60]);
  assert.equal(window.expanded, true);
  assert.equal(window.truncated, false);
  await assert.rejects(readRecoveryHistoryWindow(history, 71), /cursor/);
});

test("SIWC recovery can retain sparse chats without any time-based expiration", async () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "last week", at: "2026-10-11T08:00:00Z" },
    { role: "assistant", content: "see you", at: "2026-10-11T08:01:00Z" },
    { role: "user", content: "yesterday", at: "2026-10-17T08:00:00Z" },
    { role: "assistant", content: "hello", at: "2026-10-17T08:01:00Z" },
  ];
  const history = createHistory(messages.length, async (offset, limit) => messages.slice(offset, offset + limit));
  const window = await readRecoveryHistoryWindow(history);
  assert.deepEqual(window.messages, messages);
  assert.equal(window.expanded, false);
});

test("large cold recovery and checkpoint deltas retain every original message", async () => {
  const messages: ChatMessage[] = Array.from({ length: 600 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user", content: "Sample record " + i + " ".repeat(2_500), at: "2030-01-02T08:00:00Z",
  }));
  const history = createHistory(messages.length, async (offset, limit) => messages.slice(offset, offset + limit));
  const cold = await readRecoveryHistoryWindow(history);
  assert.equal(cold.truncated, false);
  assert.ok(cold.estimatedTokens > 100_000);
  assert.deepEqual(cold.messages, messages);
  assert.deepEqual((await readRecoveryHistoryWindow(history, 2)).messages, messages.slice(2));
  assert.equal(messages.length, 600);
});

test("a single large recovery message is preserved without a token cutoff", async () => {
  const messages: ChatMessage[] = [{ role: "user", content: "Sample document. ".repeat(15_000) }];
  const history = createHistory(messages.length, async (offset, limit) => messages.slice(offset, offset + limit));
  const window = await readRecoveryHistoryWindow(history);
  assert.ok(window.estimatedTokens > 100_000);
  assert.deepEqual(window.messages, messages);
});

test("recovery rejects incomplete snapshots instead of sending a partial transcript", async () => {
  const history = createHistory(3, async () => [{ role: "user", content: "Sample document." }]);
  await assert.rejects(readRecoveryHistoryWindow(history), /历史快照发生变化/);
});
