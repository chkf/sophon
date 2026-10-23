import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./store.js";
import { recordDeliveredAssistant, DeliveryCoordinator } from "../delivery/coordinator.js";

test("proactive and partial deliveries preserve unanswered users across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-unanswered-"));
  let store = new SessionStore(directory);
  try {
    await store.append("telegram", "owner", "owner", [{ role: "user", content: "问题", at: "2026-10-11T00:00:00Z" }]);
    await recordDeliveredAssistant(store, "telegram", "owner", "owner", "主动问候", undefined, "proactive");
    store.close(); store = new SessionStore(directory);
    assert.equal((await store.view("telegram", "owner")).unansweredCount, 1);
    assert.deepEqual((await store.readUnanswered("telegram", "owner")).map(m => m.content), ["问题"]);
    const coordinator = new DeliveryCoordinator({ async reply() { return { text: "unused" }; } }, store);
    await coordinator.commitDeliveredAssistant("telegram", "owner", "owner", "只送达一部分", undefined, "partial", false);
    assert.equal((await store.view("telegram", "owner")).unansweredCount, 1);
    await coordinator.commitDeliveredAssistant("telegram", "owner", "owner", "完整答复", undefined, "complete");
    store.close(); store = new SessionStore(directory);
    assert.equal((await store.view("telegram", "owner")).unansweredCount, 0);
    await store.check("telegram", "owner");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("history search retains original timestamp and delivery identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-history-date-"));
  const store = new SessionStore(directory);
  try {
    await store.append("telegram", "owner", "owner", [{ id: "original", role: "user", content: "约定", at: "2026-10-10T12:00:00Z" }]);
    const result = await (await store.view("telegram", "owner")).history.search("约定", 0, 4);
    assert.equal((result.entries[0] as any).at, "2026-10-10T12:00:00Z");
    assert.equal((result.entries[0] as any).id, "original");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("short SQLite history searches filter correctly across bound owner channels", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-short-cross-channel-"));
  const store = new SessionStore(directory);
  try {
    await store.append("telegram", "123", "123", [
      { id: "tg-ai", role: "user", content: "AI 算法笔记", at: "2026-10-20T10:00:00Z" },
      { id: "tg-weather", role: "assistant", content: "今天阳光很好", at: "2026-10-20T10:01:00Z" },
    ]);
    await store.bindOwnerSession("123", "wx-owner");
    await store.append("wechat", "wx-owner", "wx-owner", [
      { id: "wx-film", role: "user", content: "我们继续聊电影", at: "2026-10-21T10:00:00Z" },
    ]);
    await store.append("wechat", "another-person", "another-person", [
      { id: "other-secret", role: "user", content: "电影秘密属于别人", at: "2026-10-21T11:00:00Z" },
    ]);

    const telegramHistory = (await store.view("telegram", "123")).history;
    const wechatHistory = (await store.view("wechat", "wx-owner")).history;
    assert.deepEqual((await telegramHistory.search("电", 0, 10)).entries.map(item => item.id), ["wx-film"]);
    assert.deepEqual((await telegramHistory.search("电影", 0, 10)).entries.map(item => item.id), ["wx-film"]);
    assert.deepEqual((await telegramHistory.search("ai", 0, 10)).entries.map(item => item.id), ["tg-ai"]);
    assert.deepEqual((await wechatHistory.search("算法", 0, 10)).entries.map(item => item.id), ["tg-ai"]);
    assert.equal((await telegramHistory.search("秘密", 0, 10)).total, 0);
    assert.equal((await wechatHistory.search("不存在", 0, 10)).total, 0);
    assert.equal((await (await store.view("wechat", "another-person")).history.search("秘密", 0, 10)).total, 1);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("historical heartbeat IDs preserve unanswered questions in SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-legacy-proactive-"));
  let store = new SessionStore(directory);
  try {
    const messages = [
      { role: "user", content: "还没回答", at: "2026-10-11T00:00:00Z" },
      { id: "heartbeat:2026-10-11T00:01:00Z:text:assistant", role: "assistant", content: "旧主动问候", at: "2026-10-11T00:02:00Z" },
    ] as const;
    await store.append("telegram", "legacy", "owner", [...messages]);
    store.close(); store = new SessionStore(directory);
    assert.equal((await store.view("telegram", "legacy")).unansweredCount, 1);
    assert.equal((await store.get("telegram", "legacy"))?.messages[1]?.origin, undefined);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SessionStore keeps the full transport transcript and latest channel target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sophon-session-"));
  let store = new SessionStore(directory);
  try {
    await store.append("telegram", "chat-1", "owner", [
      { role: "user", content: "one", at: "2026-10-04T10:00:00.000Z", attachments: [
        { kind: "image", path: "/fixture/photo.png", mimeType: "image/png" },
        { kind: "file", path: "/fixture/notes.txt", fileName: "notes.txt" },
      ] },
      { role: "assistant", content: "two", at: "2026-10-04T10:00:01.000Z" },
    ]);
    await store.append("telegram", "chat-1", "owner", [
      { role: "user", content: "three", at: "2026-10-04T10:00:02.000Z" },
      { role: "assistant", content: "four", at: "2026-10-04T10:00:03.000Z" },
      { role: "user", content: "five", at: "2026-10-04T10:00:04.000Z" },
    ]);
    const session = await store.get("telegram", "chat-1");
    assert.deepEqual(session?.messages.map((message) => message.content), ["one", "two", "three", "four", "five"]);
    assert.equal((await store.latestConversation("telegram"))?.conversationId, "chat-1");
    assert.equal(await store.latestActivityAt(), "2026-10-04T10:00:04.000Z");
    store.close(); store = new SessionStore(directory);
    const restored = await store.get("telegram", "chat-1");
    assert.deepEqual(restored?.messages[0]?.attachments, [
      { kind: "image", path: "/fixture/photo.png", mimeType: "image/png" },
      { kind: "file", path: "/fixture/notes.txt", fileName: "notes.txt" },
    ]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("generatedImages are normalized as attachments; existing attachments win", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legacy-image-history-"));
  const store = new SessionStore(directory);
  try {
    const image = { kind: "image", path: "legacy.png", prompt: "fixture", sha256: "fixture" };
    const messages = [
      { role: "assistant", content: "old", at: "2026-10-11T00:00:00Z", generatedImages: [image] },
      { role: "assistant", content: "both", at: "2026-10-11T00:00:00Z", attachments: [], generatedImages: [image] },
    ] as const;
    await store.append("telegram", "legacy", "owner", [...messages]);
    const history = (await store.get("telegram", "legacy"))!;
    assert.equal(history.messages[0]?.attachments?.[0]?.path, "legacy.png");
    assert.deepEqual(history.messages[1]?.attachments, []);
    assert.equal(history.messages[0]?.generatedImages, undefined);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
