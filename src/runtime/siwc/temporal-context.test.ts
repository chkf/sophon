import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptItems, currentUserItem, historicalAttachmentItems } from "./responses-codec.js";
import { planRecovery } from "./recovery.js";
import { StatefulResponsesBridge, type StatefulResponsesSocket } from "./stateful-responses.js";
import { SessionStore } from "../../sessions/store.js";

const zone = "Asia/Shanghai";

test("cross-night transcript replay labels each historical turn with its own local date and time", async () => {
  const past = [
    { role: "user" as const, content: "明天继续处理这个任务", at: "2025-01-10T17:29:00Z" },
    { role: "assistant" as const, content: "收到，明天继续", at: "2025-01-10T17:30:00Z" },
    { role: "assistant" as const, content: "早上好，继续讨论吧", origin: "proactive" as const, at: "2025-01-11T02:15:00Z" },
  ];
  const replay = await transcriptItems(past, zone);
  assert.deepEqual(replay.map(item => item.role), ["user", "assistant", "assistant"]);
  assert.equal(replay[0]?.content, "[历史消息发送时间：2025-01-11 01:29（Asia/Shanghai）]\n明天继续处理这个任务");
  assert.equal(replay[1]?.content, "[历史消息发送时间：2025-01-11 01:30（Asia/Shanghai）]\n收到，明天继续");
  assert.equal(replay[2]?.content, "[历史消息发送时间：2025-01-11 10:15（Asia/Shanghai）]\n早上好，继续讨论吧");

  const fresh = await currentUserItem([{ role: "user", content: "上午整理好了资料", at: "2025-01-11T02:50:00Z" }], [], zone);
  assert.equal(fresh.content, "[本轮消息发送时间：2025-01-11 10:50（Asia/Shanghai）]\n上午整理好了资料");
  assert.equal(past[0]!.content, "明天继续处理这个任务", "transport annotations must not mutate canonical history");
});

test("missing or malformed timestamps never acquire invented dates", async () => {
  const legacy = await transcriptItems([
    { role: "user", content: "未带时间的历史消息" },
    { role: "assistant", content: "损坏的时间", at: "bad-timestamp" },
  ], zone);
  assert.deepEqual(legacy.map(item => item.content), ["未带时间的历史消息", "损坏的时间"]);
  const current = await currentUserItem([{ role: "user", content: "没有元数据" }], [], zone);
  assert.equal(current.content, "没有元数据");
});

test("historical media preserves time metadata separately from image availability", async () => {
  const entry = { role: "assistant" as const, content: "旧图片", at: "2025-01-10T17:29:00Z",
    attachments: [{ kind: "image" as const, path: join(tmpdir(), "gateway-missing-temporal-context-image.png") }] };
  const replay = await transcriptItems([entry], zone);
  assert.match(String(replay[0]?.content), /历史消息发送时间：2025-01-11 01:29/);
  assert.match(JSON.stringify(replay[1]), /发送时间：2025-01-11 01:29/);
  assert.match(JSON.stringify(replay[1]), /不可读取/);
  const media = await historicalAttachmentItems(entry, zone);
  assert.equal(replay[1]?.role, "user");
  assert.deepEqual(replay[1], media[0]);
});

test("recovery timestamps canonical history but does not discard opaque compaction evidence", async () => {
  const messages = [{ role: "assistant" as const, content: "昨晚的回复", at: "2025-01-10T17:30:00Z" }];
  const fromTranscript = await planRecovery([], messages, zone);
  assert.equal(fromTranscript.recoverySource, "transcript");
  assert.match(JSON.stringify(fromTranscript.recoveryItems), /2025-01-11 01:30/);
  const opaque = [{ type: "compaction", encrypted_content: "opaque-history" }];
  const fromCheckpoint = await planRecovery(opaque, messages, zone);
  assert.equal(fromCheckpoint.recoverySource, "checkpoint");
  assert.deepEqual(fromCheckpoint.recoveryItems, opaque);
});

test("stateful continuation retains new user timestamps without replaying old chat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-siwc-timestamp-"));
  const sent: Record<string, unknown>[] = [];
  let responseIndex = 0;
  const socket: StatefulResponsesSocket = {
    send(event) { sent.push(event); },
    stream() {
      return (async function* () {
        responseIndex++;
        yield { type: "message", message: { type: "response.completed",
          response: { id: "reply-" + responseIndex, output: [{ type: "message", role: "assistant",
            content: [{ type: "output_text", text: "回复" + responseIndex }] }] } } };
      })();
    },
    close() {},
    onClose() {},
  };
  const bridge = new StatefulResponsesBridge(directory, () => socket);
  try {
    const base = { accessToken: "fixture", model: "fixture-model", sessionId: "telegram:timestamp", timezone: zone };
    await bridge.reply({ ...base, messages: [{ role: "user", content: "昨晚的提问", at: "2025-01-10T17:29:00Z" }] });
    await bridge.reply({ ...base, messages: [{ role: "user", content: "现在是上午", at: "2025-01-11T02:50:00Z" }] });
    assert.equal(sent.length, 2);
    assert.equal(sent[1]?.previous_response_id, "reply-1");
    assert.match(JSON.stringify(sent[0]?.input), /本轮消息发送时间：2025-01-11 01:29/);
    assert.match(JSON.stringify(sent[1]?.input), /本轮消息发送时间：2025-01-11 10:50/);
    assert.doesNotMatch(JSON.stringify(sent[1]?.input), /昨晚的提问/);
  } finally {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart from SQLite restores historical local times before today's current message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-siwc-timestamp-recovery-"));
  const sent: Record<string, unknown>[] = [];
  const socket: StatefulResponsesSocket = {
    send(event) { sent.push(event); },
    stream() { return (async function* () {
      yield { type: "message", message: { type: "response.completed", response: {
        id: "replayed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "好的" }] }],
      } } };
    })(); },
    close() {},
    onClose() {},
  };
  const bridge = new StatefulResponsesBridge(directory, () => socket);
  const store = new SessionStore(directory);
  try {
    await store.append("telegram", "timestamp-recovery", "owner", [
      { role: "user", content: "明天继续处理这个任务", at: "2025-01-10T17:29:00Z" },
      { role: "assistant", content: "测试回复", at: "2025-01-10T17:30:00Z" },
    ]);
    await bridge.reply({ accessToken: "fixture", model: "fixture-model", sessionId: "telegram:timestamp-recovery",
      timezone: zone, messages: [{ role: "user", content: "当前测试消息", at: "2025-01-11T02:50:00Z" }],
      history: (await store.view("telegram", "timestamp-recovery")).history });
    assert.equal(sent[0]?.previous_response_id, undefined);
    const input = JSON.stringify(sent[0]?.input);
    assert.match(input, /历史消息发送时间：2025-01-11 01:29/);
    assert.match(input, /历史消息发送时间：2025-01-11 01:30/);
    assert.match(input, /本轮消息发送时间：2025-01-11 10:50/);
  } finally {
    await bridge.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
