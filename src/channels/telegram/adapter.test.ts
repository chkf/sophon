import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TelegramAdapter, splitTelegramText, telegramMessageAllowed, type TelegramApiClient } from "./adapter.js";
import { TelegramBotApiError } from "./api.js";
import { immediateCommand } from "./input-buffer.js";

test("Telegram serializes commands behind an in-flight reply and its delivery acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-telegram-serial-"));
  try {
    let release!: () => void;
    let acknowledge!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const reachedCommit = new Promise<void>(resolve => { acknowledge = resolve; });
    const events: string[] = [];
    const adapter = new TelegramAdapter({
      token: "fixture", ownerId: "123", dataDir: root, mediaStore: {} as never,
      api: {
        async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
          if (method === "sendMessage") events.push("sent:" + body.text);
          return true as T;
        },
        async getFile() { return {}; }, async downloadFile() { return new Uint8Array(); },
      },
      async onReplyDelivered() { events.push("commit"); acknowledge(); await blocked; events.push("committed"); },
    });
    const internal = adapter as any;
    internal.handler = async (message: any) => {
      events.push("handle:" + message.text);
      return { text: message.text, commitAssistant: message.text === "chat" };
    };
    const inbound = { channel: "telegram", conversationId: "123", senderId: "123", attachments: [], receivedAt: "now" };
    const chat = internal.processImmediate({ ...inbound, text: "chat" });
    const command = internal.processImmediate({ ...inbound, text: "/model" });
    await reachedCommit;
    const beforeCommit = [...events];
    release();
    await Promise.all([chat, command]);
    assert.deepEqual(beforeCommit, ["handle:chat", "sent:chat", "commit"]);
    assert.deepEqual(events, ["handle:chat", "sent:chat", "commit", "committed", "handle:/model", "sent:/model"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Telegram only accepts the configured owner in private chat", () => {
  const base = {
    message_id: 1,
    date: 1,
    from: { id: 123 },
    chat: { id: 123, type: "private" },
  };
  assert.equal(telegramMessageAllowed(base, "123"), true);
  assert.equal(telegramMessageAllowed({ ...base, from: { id: 456 } }, "123"), false);
  assert.equal(telegramMessageAllowed({ ...base, chat: { id: -1, type: "group" } }, "123"), false);
});

test("Telegram preserves distinct reply batches across retry and restart without bypassing the retry deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-telegram-quoted-queue-"));
  let restarted: TelegramAdapter | undefined;
  try {
    const seen: any[] = [];
    let sends = 0;
    const api: TelegramApiClient = {
      async call<T>(method: string, _body: any, _timeout?: number, signal?: AbortSignal): Promise<T> {
        if (method === "getUpdates") return new Promise<T>((resolve) => {
          if (signal?.aborted) resolve([] as T);
          else signal?.addEventListener("abort", () => resolve([] as T), { once: true });
        });
        if (method === "sendMessage") sends++;
        return true as T;
      },
      async getFile() { return {}; }, async downloadFile() { return new Uint8Array(); },
    };
    const config = { token: "fixture", ownerId: "123", dataDir: root, mediaStore: {} as never, inputDebounceMs: 60_000, api };
    const handler = async (message: any) => {
      seen.push(message);
      return seen.length === 1 ? { text: "", retryAfterMs: 60_000 } : { text: "ok" };
    };
    const adapter = new TelegramAdapter(config);
    const internal = adapter as any;
    internal.handler = handler;
    const update = (id: number, quote: number) => ({ update_id: id, message: {
      message_id: id, date: id, text: "reply-" + id, from: { id: 123 }, chat: { id: 123, type: "private" },
      reply_to_message: { message_id: quote, date: 1, text: "quote-" + quote,
        from: { id: 42, is_bot: true }, chat: { id: 123, type: "private" } },
    } });
    await internal.processUpdate(update(1, 10));
    await internal.flushBuffered();
    const deadline = internal.state.inFlight.retryAtMs;
    await internal.processUpdate(update(2, 20));
    await internal.processUpdate(update(3, 30));
    await internal.processUpdate(update(4, 10));
    await internal.flushBuffered();
    assert.equal(seen.length, 1);
    const saved = JSON.parse(await readFile(join(root, "channels", "telegram.json"), "utf8"));
    assert.equal(saved.inFlight.retryAtMs, deadline);
    assert.deepEqual(saved.queuedBuffers.map((batch: any) => batch.parts[0].replyTo.messageId), ["20", "30"]);
    assert.equal(saved.buffer.parts[0].replyTo.messageId, "10");
    assert.equal(saved.offset, 5);
    assert.equal(sends, 0);

    restarted = new TelegramAdapter(config);
    await restarted.start(handler);
    const recovered = restarted as any;
    recovered.clearFlushTimer();
    await recovered.flushBuffered();
    recovered.clearFlushTimer();
    assert.equal(seen.length, 1, "restart must honor the persisted deadline too");
    recovered.state.inFlight.retryAtMs = 0;
    for (let i = 0; i < 4; i++) {
      await recovered.flushBuffered();
      recovered.clearFlushTimer();
    }
    assert.deepEqual(seen.map(message => [message.text, message.replyTo.messageId]), [
      ["reply-1", "10"], ["reply-1", "10"], ["reply-2", "20"], ["reply-3", "30"], ["reply-4", "10"],
    ]);
    assert.equal(sends, 4);
    const completed = JSON.parse(await readFile(join(root, "channels", "telegram.json"), "utf8"));
    assert.equal(completed.inFlight, undefined);
    assert.equal(completed.buffer, undefined);
    assert.equal(completed.queuedBuffers.length, 0);
  } finally {
    await restarted?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram text splitting stays within Bot API-safe chunks", () => {
  const text = Array.from({ length: 1200 }, (_, index) => "word" + index).join(" ");
  const chunks = splitTelegramText(text, 400);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 400));
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), text);
});


test("Telegram retries an explicit 429 using retry_after and then succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-telegram-429-"));
  try {
    let sends = 0;
    const api: TelegramApiClient = {
      async call<T>(method: string): Promise<T> {
        if (method !== "sendMessage") throw new Error("unexpected Telegram API call: " + method);
        sends += 1;
        if (sends === 1) {
          throw new TelegramBotApiError(
            "sendMessage",
            429,
            "Too Many Requests: retry after 0",
            0,
          );
        }
        return true as T;
      },
      async getFile() { return {}; },
      async downloadFile() { return new Uint8Array(); },
    };
    const adapter = new TelegramAdapter({
      token: "test-token",
      ownerId: "123",
      dataDir: root,
      mediaStore: { save: async () => { throw new Error("media not expected"); } } as never,
      api,
    });

    await adapter.sendText("123", "hello");
    assert.equal(sends, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram does not retry ambiguous send failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-telegram-ambiguous-"));
  try {
    let sends = 0;
    const api: TelegramApiClient = {
      async call<T>(method: string): Promise<T> {
        if (method !== "sendMessage") throw new Error("unexpected Telegram API call: " + method);
        sends += 1;
        throw new Error("network timeout after request write");
      },
      async getFile() { return {}; },
      async downloadFile() { return new Uint8Array(); },
    };
    const adapter = new TelegramAdapter({
      token: "test-token",
      ownerId: "123",
      dataDir: root,
      mediaStore: { save: async () => { throw new Error("media not expected"); } } as never,
      api,
    });

    await assert.rejects(adapter.sendText("123", "hello"), /network timeout/);
    assert.equal(sends, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram consumes an update before delivery and never retries an uncertain send", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-telegram-"));
  try {
    const statePath = join(root, "channels", "telegram.json");
    let sends = 0;
    const api: TelegramApiClient = {
      async call<T>(method: string): Promise<T> {
        if (method === "sendChatAction") return true as T;
        if (method === "sendMessage") {
          sends += 1;
          const stateAtSend = JSON.parse(await readFile(statePath, "utf8"));
          assert.equal(stateAtSend.offset, 101);
          assert.equal(stateAtSend.pendingReply, undefined);
          throw new Error("simulated ambiguous send failure");
        }
        throw new Error("unexpected Telegram API call: " + method);
      },
      async getFile() {
        return {};
      },
      async downloadFile() {
        return new Uint8Array();
      },
    };

    let handlerCalls = 0;
    let delivered = 0;
    let deliveryFailed = 0;
    const config = {
      token: "test-token",
      ownerId: "123",
      dataDir: root,
      mediaStore: { save: async () => { throw new Error("media not expected"); } } as never,
      inputDebounceMs: 10,
      api,
      onReplyDelivered: async () => { delivered += 1; },
      onReplyDeliveryFailed: async () => { deliveryFailed += 1; },
    };

    const update = {
      update_id: 100,
      message: {
        message_id: 7,
        date: 1,
        text: "hello",
        from: { id: 123 },
        chat: { id: 123, type: "private" },
      },
    };

    const adapter = new TelegramAdapter(config);
    (adapter as any).handler = async () => {
      handlerCalls += 1;
      return { text: "reply", commitAssistant: true };
    };
    (adapter as any).running = true;

    await (adapter as any).processUpdate(update);
    (adapter as any).clearFlushTimer();
    await (adapter as any).flushBuffered();
    assert.equal(handlerCalls, 1);
    assert.equal(sends, 1);
    assert.equal(delivered, 0);
    assert.equal(deliveryFailed, 1);

    const completed = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(completed.offset, 101);
    assert.equal(completed.pendingReply, undefined);
    assert.equal(completed.lastChatId, "123");

    await (adapter as any).processUpdate(update);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(handlerCalls, 1);
    assert.equal(sends, 1);
    await adapter.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Telegram aborts an active long poll on stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-telegram-stop-"));
  try {
    let aborted = false;
    const api: TelegramApiClient = {
      async call<T>(method: string, _body: Record<string, unknown>, _timeout?: number, signal?: AbortSignal): Promise<T> {
        if (method === "deleteWebhook" || method === "deleteMyCommands" || method === "setMyCommands") return true as T;
        if (method === "getUpdates") {
          return await new Promise<T>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            }, { once: true });
          });
        }
        throw new Error("unexpected Telegram API call: " + method);
      },
      async getFile() { return {}; },
      async downloadFile() { return new Uint8Array(); },
    };
    const adapter = new TelegramAdapter({
      token: "test-token", ownerId: "123", dataDir: root,
      mediaStore: { save: async () => { throw new Error("media not expected"); } } as never,
      commands: [], api,
    });
    await adapter.start(async () => "reply");
    await adapter.stop();
    assert.equal(aborted, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Telegram yields when Telegram reports a getUpdates conflict", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-telegram-conflict-"));
  try {
    let getUpdatesCalls = 0;
    const api: TelegramApiClient = {
      async call<T>(method: string): Promise<T> {
        if (method === "deleteWebhook" || method === "deleteMyCommands" || method === "setMyCommands") return true as T;
        if (method === "getUpdates") {
          getUpdatesCalls += 1;
          throw new TelegramBotApiError(
            "getUpdates",
            409,
            "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
          );
        }
        throw new Error("unexpected Telegram API call: " + method);
      },
      async getFile() { return {}; },
      async downloadFile() { return new Uint8Array(); },
    };
    const adapter = new TelegramAdapter({
      token: "test-token", ownerId: "123", dataDir: root,
      mediaStore: { save: async () => { throw new Error("media not expected"); } } as never,
      commands: [], api,
    });
    await adapter.start(async () => "reply");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await adapter.stop();
    assert.equal(getUpdatesCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Telegram buffers and merges consecutive bubbles before quiet flush", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-telegram-debounce-"));
  try {
    const seen: any[] = [];
    const api: TelegramApiClient = {
      async call<T>(method: string): Promise<T> {
        if (method === "sendChatAction") return true as T;
        if (method === "sendMessage") return true as T;
        throw new Error("unexpected Telegram API call: " + method);
      },
      async getFile() { return {}; },
      async downloadFile() { return new Uint8Array(); },
    };
    const adapter = new TelegramAdapter({
      token: "test-token",
      ownerId: "123",
      dataDir: root,
      mediaStore: { save: async () => { throw new Error("media not expected"); } } as never,
      inputDebounceMs: 60_000,
      api,
    });
    (adapter as any).handler = async (message: any) => {
      seen.push(message);
      return "";
    };
    (adapter as any).running = true;

    await (adapter as any).processUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1,
        text: "我想补充一条消息",
        from: { id: 123 },
        chat: { id: 123, type: "private" },
      },
    });

    await (adapter as any).processUpdate({
      update_id: 2,
      message: {
        message_id: 11,
        date: 2,
        text: "关于合并缓冲的处理",
        from: { id: 123 },
        chat: { id: 123, type: "private" },
      },
    });

    assert.equal(seen.length, 0);
    (adapter as any).clearFlushTimer();
    await (adapter as any).flushBuffered();

    assert.equal(seen.length, 1);
    assert.equal(seen[0].text, "我想补充一条消息\n\n关于合并缓冲的处理");
    assert.equal(seen[0].messageId, "10-11");

    await adapter.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram preserves reply_to_message as normalized reply context", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-telegram-reply-"));
  try {
    const seen: any[] = [];
    const api: TelegramApiClient = {
      async call<T>(method: string): Promise<T> {
        if (method === "sendChatAction" || method === "sendMessage") return true as T;
        throw new Error("unexpected Telegram API call: " + method);
      },
      async getFile() { return {}; },
      async downloadFile() { return new Uint8Array(); },
    };
    const adapter = new TelegramAdapter({
      token: "test-token",
      ownerId: "123",
      dataDir: root,
      mediaStore: { save: async () => { throw new Error("media not expected"); } } as never,
      inputDebounceMs: 60_000,
      api,
    });
    (adapter as any).handler = async (message: any) => {
      seen.push(message);
      return "";
    };
    (adapter as any).running = true;

    await (adapter as any).processUpdate({
      update_id: 1,
      message: {
        message_id: 41,
        date: 2,
        text: "这个具体讲了啥？",
        from: { id: 123, is_bot: false },
        chat: { id: 123, type: "private" },
        reply_to_message: {
          message_id: 40,
          date: 1,
          text: "我刚看完一段示例视频",
          from: { id: 999, is_bot: true },
          chat: { id: 123, type: "private" },
        },
      },
    });

    (adapter as any).clearFlushTimer();
    await (adapter as any).flushBuffered();

    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].replyTo, {
      messageId: "40",
      sender: "assistant",
      text: "我刚看完一段示例视频",
    });

    await adapter.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram downloads image attachments from a replied message", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-telegram-reply-image-"));
  try {
    const seen: any[] = [];
    const saved: any[] = [];
    const api: TelegramApiClient = {
      async call<T>(method: string): Promise<T> {
        if (method === "sendChatAction" || method === "sendMessage") return true as T;
        throw new Error("unexpected Telegram API call: " + method);
      },
      async getFile(fileId: string) {
        assert.equal(fileId, "photo-large");
        return { file_path: "photos/replied.jpg", file_size: 4 };
      },
      async downloadFile(filePath: string) {
        assert.equal(filePath, "photos/replied.jpg");
        return new Uint8Array([1, 2, 3, 4]);
      },
    };
    const adapter = new TelegramAdapter({
      token: "test-token",
      ownerId: "123",
      dataDir: root,
      mediaStore: {
        save: async (input: any) => {
          saved.push(input);
          return {
            kind: input.kind,
            fileName: input.fileName,
            mimeType: "image/jpeg",
            size: input.bytes.length,
            localPath: "/tmp/replied.jpg",
            remoteId: input.remoteId,
          };
        },
      } as never,
      inputDebounceMs: 60_000,
      api,
    });
    (adapter as any).handler = async (message: any) => {
      seen.push(message);
      return "";
    };
    (adapter as any).running = true;

    await (adapter as any).processUpdate({
      update_id: 1,
      message: {
        message_id: 51,
        date: 2,
        text: "这张图里是什么？",
        from: { id: 123, is_bot: false },
        chat: { id: 123, type: "private" },
        reply_to_message: {
          message_id: 50,
          date: 1,
          from: { id: 999, is_bot: true },
          chat: { id: 123, type: "private" },
          photo: [
            { file_id: "photo-small", file_size: 2, width: 100, height: 100 },
            { file_id: "photo-large", file_size: 4, width: 1000, height: 1000 },
          ],
        },
      },
    });

    (adapter as any).clearFlushTimer();
    await (adapter as any).flushBuffered();

    assert.equal(saved.length, 1);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].replyTo, {
      messageId: "50",
      sender: "assistant",
      attachments: [{
        kind: "image",
        fileName: "replied.jpg",
        mimeType: "image/jpeg",
        size: 4,
        localPath: "/tmp/replied.jpg",
        remoteId: "photo-large",
      }],
    });

    await adapter.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram defaults to an 8s input debounce", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-telegram-debounce-default-"));
  try {
    const adapter = new TelegramAdapter({
      token: "test-token",
      ownerId: "123",
      dataDir: root,
      mediaStore: { save: async () => { throw new Error("media not expected"); } } as never,
      api: {
        async call<T>() { return true as T; },
        async getFile() { return {}; },
        async downloadFile() { return new Uint8Array(); },
      },
    });
    assert.equal((adapter as any).debounceMs(), 8_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram refreshes typing while a reply is still being generated", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-telegram-typing-refresh-"));
  try {
    let typingCalls = 0;
    let sends = 0;
    const api: TelegramApiClient = {
      async call<T>(method: string): Promise<T> {
        if (method === "sendChatAction") {
          typingCalls += 1;
          return true as T;
        }
        if (method === "sendMessage") {
          sends += 1;
          return true as T;
        }
        throw new Error("unexpected Telegram API call: " + method);
      },
      async getFile() { return {}; },
      async downloadFile() { return new Uint8Array(); },
    };
    const adapter = new TelegramAdapter({
      token: "test-token",
      ownerId: "123",
      dataDir: root,
      mediaStore: { save: async () => { throw new Error("media not expected"); } } as never,
      typingRefreshMs: 10,
      api,
    });
    (adapter as any).handler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 35));
      return "reply";
    };

    await (adapter as any).processReply({
      channel: "telegram",
      conversationId: "123",
      senderId: "123",
      messageId: "1",
      text: "hello",
      receivedAt: new Date().toISOString(),
      attachments: [],
    });

    assert.ok(typingCalls >= 3, "typing should be refreshed while generation is in progress");
    assert.equal(sends, 1);
    const afterReply = typingCalls;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(typingCalls, afterReply, "typing refresh must stop once reply delivery completes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Persona hashtags are buffered as chat; only slash commands bypass Telegram debounce", async () => {
  assert.equal(immediateCommand("#formal"), false);
  assert.equal(immediateCommand("#default"), false);
  assert.equal(immediateCommand("#brief"), false);
  assert.equal(immediateCommand(" #formal "), false);
  assert.equal(immediateCommand("/persona formal"), true);

  const root = await mkdtemp(join(tmpdir(), "gateway-telegram-hashtag-chat-"));
  try {
    const seen: string[] = [];
    const deleted: number[] = [];
    const adapter = new TelegramAdapter({
      token: "fixture", ownerId: "123", dataDir: root,
      mediaStore: { save: async () => { throw new Error("media not expected"); } } as never,
      inputDebounceMs: 60_000,
      api: {
        async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
          if (method === "deleteMessage") deleted.push(Number(body.message_id));
          return true as T;
        },
        async getFile() { return {}; },
        async downloadFile() { return new Uint8Array(); },
      },
    });
    const internal = adapter as any;
    internal.handler = async (message: any) => { seen.push(message.text); return ""; };
    internal.running = true;

    const update = (updateId: number, text: string) => ({
      update_id: updateId,
      message: {
        message_id: 100 + updateId, date: updateId, text,
        from: { id: 123 }, chat: { id: 123, type: "private" },
      },
    });
    await internal.processUpdate(update(1, "#formal"));
    assert.deepEqual(seen, [], "hashtag must not bypass chat buffering");
    assert.equal(internal.state.buffer.parts[0].text, "#formal");
    assert.ok(!deleted.includes(101), "hashtag message must not be auto-deleted as a command");

    await internal.processUpdate(update(2, "/persona formal"));
    assert.deepEqual(seen, ["/persona formal"], "slash command should execute immediately");
    assert.equal(internal.state.buffer.parts[0].text, "#formal", "queued ordinary chat remains intact");
    await adapter.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram slash commands bypass the input debounce", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-telegram-command-"));
  try {
    const seen: string[] = [];
    let acknowledgeBuffered!: () => void;
    const bufferedHandled = new Promise<void>(resolve => { acknowledgeBuffered = resolve; });
    const api: TelegramApiClient = {
      async call<T>(method: string): Promise<T> {
        if (method === "sendChatAction" || method === "sendMessage") return true as T;
        throw new Error("unexpected Telegram API call: " + method);
      },
      async getFile() { return {}; },
      async downloadFile() { return new Uint8Array(); },
    };
    const adapter = new TelegramAdapter({
      token: "test-token",
      ownerId: "123",
      dataDir: root,
      mediaStore: { save: async () => { throw new Error("media not expected"); } } as never,
      inputDebounceMs: 80,
      api,
    });
    (adapter as any).handler = async (message: any) => {
      seen.push(message.text);
      if (!message.text.startsWith("/")) acknowledgeBuffered();
      return "";
    };
    (adapter as any).running = true;

    await (adapter as any).processUpdate({
      update_id: 1,
      message: {
        message_id: 20,
        date: 1,
        text: "普通聊天第一条",
        from: { id: 123 },
        chat: { id: 123, type: "private" },
      },
    });

    await (adapter as any).processUpdate({
      update_id: 2,
      message: {
        message_id: 21,
        date: 2,
        text: "/model",
        from: { id: 123 },
        chat: { id: 123, type: "private" },
      },
    });

    assert.deepEqual(seen, ["/model"]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([bufferedHandled, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Buffered chat did not flush after the debounce window")), 2_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    assert.deepEqual(seen, ["/model", "普通聊天第一条"]);

    await adapter.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Telegram auto-deletes slash command input immediately and tool reply after a short TTL", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-telegram-command-autodelete-"));
  try {
    const deleted: number[] = [];
    const sent: Array<{ text: string; messageId: number }> = [];
    const api: TelegramApiClient = {
      async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
        if (method === "sendChatAction") return true as T;
        if (method === "sendMessage") {
          const messageId = 900 + sent.length;
          sent.push({ text: String(body.text ?? ""), messageId });
          return { message_id: messageId } as T;
        }
        if (method === "deleteMessage") {
          deleted.push(Number(body.message_id));
          return true as T;
        }
        throw new Error("unexpected Telegram API call: " + method);
      },
      async getFile() { return {}; },
      async downloadFile() { return new Uint8Array(); },
    };
    const adapter = new TelegramAdapter({
      token: "test-token",
      ownerId: "123",
      dataDir: root,
      mediaStore: { save: async () => { throw new Error("media not expected"); } } as never,
      inputDebounceMs: 80,
      commandReplyAutoDeleteMs: 20,
      api,
    });
    (adapter as any).handler = async () => "临时工具结果";
    (adapter as any).running = true;

    await (adapter as any).processUpdate({
      update_id: 50,
      message: {
        message_id: 21,
        date: 2,
        text: "/logs",
        from: { id: 123 },
        chat: { id: 123, type: "private" },
      },
    });

    assert.deepEqual(sent.map((item) => item.text), ["临时工具结果"]);
    assert.ok(deleted.includes(21), "incoming slash command should be deleted after execution");
    assert.ok(!deleted.includes(900), "tool reply should remain visible during its TTL");

    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.ok(deleted.includes(900), "tool reply should be deleted after its TTL");

    await adapter.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram retries failed command deletion and resumes failed reply deletion after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-telegram-delete-retry-"));
  try {
    const attempts = new Map<number, number>();
    const deleted: number[] = [];
    const api: TelegramApiClient = {
      async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
        if (method === "sendChatAction") return true as T;
        if (method === "sendMessage") return { message_id: 900 } as T;
        if (method === "deleteMessage") {
          const id = Number(body.message_id);
          const count = (attempts.get(id) ?? 0) + 1;
          attempts.set(id, count);
          if (count === 1) throw new Error("synthetic network failure");
          deleted.push(id);
          return true as T;
        }
        throw new Error("unexpected Telegram API call: " + method);
      },
      async getFile() { return {}; },
      async downloadFile() { return new Uint8Array(); },
    };
    const config = {
      token: "test-token", ownerId: "123", dataDir: root,
      mediaStore: { save: async () => { throw new Error("media not expected"); } } as never,
      commandReplyAutoDeleteMs: 20, api,
    };
    const adapter = new TelegramAdapter(config);
    const internal = adapter as any;
    internal.handler = async () => "更新状态";
    internal.running = true;
    await internal.processUpdate({ update_id: 1, message: {
      message_id: 21, date: 1, text: "/update status",
      from: { id: 123 }, chat: { id: 123, type: "private" },
    } });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.ok(deleted.includes(21), "incoming command should be retried");
    assert.equal(attempts.get(900), 1, "reply deletion should fail once before restart");
    const statePath = join(root, "channels", "telegram.json");
    assert.ok(JSON.parse(await readFile(statePath, "utf8")).commandReplyDeletions.some((entry: any) => entry.messageIds.includes(900)));
    await adapter.stop();
    const restarted = new TelegramAdapter(config);
    const resumed = restarted as any;
    resumed.state = await resumed.store.load();
    resumed.running = true;
    resumed.resumeCommandReplyDeletions();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.ok(deleted.includes(900), "reply deletion should resume from durable state");
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).commandReplyDeletions, undefined);
    await restarted.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram keeps a model-failed inbound batch durable and retries it without losing the update", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-telegram-inbound-retry-"));
  try {
    const statePath = join(root, "channels", "telegram.json");
    let sends = 0;
    let handlerCalls = 0;
    const api: TelegramApiClient = {
      async call<T>(method: string): Promise<T> {
        if (method === "sendChatAction") return true as T;
        if (method === "sendMessage") {
          sends += 1;
          return true as T;
        }
        throw new Error("unexpected Telegram API call: " + method);
      },
      async getFile() { return {}; },
      async downloadFile() { return new Uint8Array(); },
    };

    const adapter = new TelegramAdapter({
      token: "test-token",
      ownerId: "123",
      dataDir: root,
      mediaStore: { save: async () => { throw new Error("media not expected"); } } as never,
      inputDebounceMs: 60_000,
      api,
    });
    (adapter as any).handler = async () => {
      handlerCalls += 1;
      if (handlerCalls === 1) return { text: "", retryAfterMs: 5_000 };
      return { text: "恢复后回复", commitAssistant: true };
    };
    (adapter as any).running = true;

    await (adapter as any).processUpdate({
      update_id: 77,
      message: {
        message_id: 9,
        date: 1,
        text: "这条消息不能丢",
        from: { id: 123 },
        chat: { id: 123, type: "private" },
      },
    });

    (adapter as any).clearFlushTimer();
    await (adapter as any).flushBuffered();

    const retained = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(retained.offset, 78);
    assert.equal(retained.buffer, undefined);
    assert.equal(retained.inFlight.parts[0].text, "这条消息不能丢");
    assert.ok(retained.inFlight.retryAtMs > Date.now());
    assert.equal(sends, 0);

    (adapter as any).clearFlushTimer();
    await (adapter as any).flushBuffered();

    assert.equal(handlerCalls, 1, "a retry must wait until its persisted deadline");
    (adapter as any).state.inFlight.retryAtMs = 0; // Simulate the retry deadline elapsing.
    await (adapter as any).flushBuffered();

    const completed = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(handlerCalls, 2);
    assert.equal(sends, 1);
    assert.equal(completed.inFlight, undefined);
    assert.equal(completed.offset, 78);

    await adapter.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Telegram merges a follow-up into retryable in-flight input and reuses the 8s quiet window", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-telegram-inflight-merge-"));
  try {
    const statePath = join(root, "channels", "telegram.json");
    const seen: string[] = [];
    let sends = 0;
    const api: TelegramApiClient = {
      async call<T>(method: string): Promise<T> {
        if (method === "sendChatAction") return true as T;
        if (method === "sendMessage") {
          sends += 1;
          return true as T;
        }
        throw new Error("unexpected Telegram API call: " + method);
      },
      async getFile() { return {}; },
      async downloadFile() { return new Uint8Array(); },
    };

    const adapter = new TelegramAdapter({
      token: "test-token",
      ownerId: "123",
      dataDir: root,
      mediaStore: { save: async () => { throw new Error("media not expected"); } } as never,
      inputDebounceMs: 8_000,
      api,
    });
    (adapter as any).handler = async (message: any) => {
      seen.push(message.text);
      if (seen.length === 1) return { text: "", retryAfterMs: 5_000 };
      return { text: "一起回复", commitAssistant: true };
    };
    (adapter as any).running = true;

    await (adapter as any).processUpdate({
      update_id: 100,
      message: {
        message_id: 1,
        date: 1,
        text: "第一句",
        from: { id: 123 },
        chat: { id: 123, type: "private" },
      },
    });
    (adapter as any).clearFlushTimer();
    await (adapter as any).flushBuffered();
    assert.deepEqual(seen, ["第一句"]);

    const beforeFollowup = Date.now();
    await (adapter as any).processUpdate({
      update_id: 101,
      message: {
        message_id: 2,
        date: 2,
        text: "第二句",
        from: { id: 123 },
        chat: { id: 123, type: "private" },
      },
    });

    const merged = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(merged.buffer, undefined);
    assert.deepEqual(merged.inFlight.parts.map((part: any) => part.text), ["第一句", "第二句"]);
    assert.ok(
      merged.inFlight.retryAtMs >= beforeFollowup + 7_500,
      "follow-up should reset the retry to roughly the normal 8s debounce",
    );

    (adapter as any).clearFlushTimer();
    (adapter as any).state.inFlight.retryAtMs = 0; // Simulate the new quiet window elapsing.
    await (adapter as any).flushBuffered();

    assert.deepEqual(seen, ["第一句", "第一句\n\n第二句"]);
    assert.equal(sends, 1);
    const completed = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(completed.inFlight, undefined);

    await adapter.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Telegram pauses automatic retries after three failures, persists pending, and /retry resumes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-telegram-circuit-"));
  let restarted: TelegramAdapter | undefined;
  try {
    const statePath = join(root, "channels", "telegram.json");
    const sent: string[] = [];
    const api: TelegramApiClient = {
      async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
        if (method === "sendChatAction") return true as T;
        if (method === "sendMessage") {
          sent.push(String(body.text));
          return { message_id: 50 + sent.length } as T;
        }
        if (method === "getUpdates" || method === "deleteWebhook" ||
            method === "deleteMyCommands" || method === "setMyCommands" ||
            method === "deleteMessage") return true as T;
        throw new Error("unexpected Telegram API call: " + method);
      },
      async getFile() { return {}; },
      async downloadFile() { return new Uint8Array(); },
    };
    let attempts = 0;
    const handler = async () => {
      attempts++;
      return attempts <= 3 ? { text: "", retryAfterMs: 5_000 } : { text: "恢复后成功", commitAssistant: true };
    };
    const config = {
      token: "test-token", ownerId: "123", dataDir: root,
      mediaStore: { save: async () => { throw new Error("media not expected"); } } as never,
      inputDebounceMs: 0, api,
    };
    const adapter = new TelegramAdapter(config);
    const internal = adapter as any;
    internal.handler = handler;
    internal.running = true;
    const incoming = (id: number, text: string) => ({
      update_id: id, message: {
        message_id: id, date: id, text, from: { id: 123 }, chat: { id: 123, type: "private" },
      },
    });
    await internal.processUpdate(incoming(1, "问题不要丢"));
    internal.clearFlushTimer();
    for (let n = 0; n < 3; n++) {
      if (internal.state.inFlight) internal.state.inFlight.retryAtMs = 0;
      await internal.flushBuffered();
      internal.clearFlushTimer();
      const state = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(state.inFlight.retryAttempts, n + 1);
      assert.equal(Boolean(state.inFlight.retryPaused), n === 2);
      if (n !== 2) assert.ok(state.inFlight.retryAtMs > Date.now());
    }
    assert.equal(attempts, 3);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /暂停自动重试/);
    await internal.flushBuffered();
    assert.equal(attempts, 3, "paused requests must not retry");
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(saved.inFlight.parts.map((p: any) => p.text), ["问题不要丢"]);

    restarted = new TelegramAdapter(config);
    const recovered = restarted as any;
    recovered.state = JSON.parse(await readFile(statePath, "utf8"));
    recovered.running = true;
    recovered.handler = handler;
    await recovered.flushBuffered();
    recovered.clearFlushTimer();
    assert.equal(attempts, 3, "restart must not auto-resume a paused batch");
    await recovered.processUpdate(incoming(2, "/retry"));
    recovered.clearFlushTimer();
    assert.equal(recovered.state.inFlight.retryPaused, false);
    await recovered.flushBuffered();
    recovered.clearFlushTimer();
    assert.equal(attempts, 4);
    assert.ok(sent.some(x => x.includes("恢复后成功")));
    assert.equal(recovered.state.inFlight, undefined);
    await restarted.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const reason of ["subscription_usage_limit", "model_failure"] as const) test("Telegram durably pauses " + reason + " until /retry, keeping later messages in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-telegram-usage-pause-"));
  const pauseNotice = reason === "subscription_usage_limit" ? "额度暂时用完" : "模型调用没有完成";
  try {
    const statePath = join(root, "channels", "telegram.json");
    const sent: string[] = [];
    const seen: string[] = [];
    let exhausted = true;
    const api: TelegramApiClient = {
      async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
        if (method === "sendMessage") {
          sent.push(String(body.text));
          if (String(body.text).includes(pauseNotice)) throw new Error("timeout after accepted notice");
          return { message_id: 100 + sent.length } as T;
        }
        return true as T;
      },
      async getFile() { return {}; },
      async downloadFile() { return new Uint8Array(); },
    };
    const config = { token: "fixture", ownerId: "123", dataDir: root, inputDebounceMs: 60_000,
      mediaStore: {} as never, api };
    const handler = async (message: { text: string }) => {
      seen.push(message.text);
      return exhausted ? { kind: "pause" as const, reason }
        : { kind: "model_reply" as const, text: "答复：" + message.text, deliveryId: "delivery-" + seen.length };
    };
    const incoming = (id: number, text: string) => ({ update_id: id, message: {
      message_id: id, date: id, text, from: { id: 123 }, chat: { id: 123, type: "private" },
    } });
    const adapter = new TelegramAdapter(config);
    const internal = adapter as any;
    internal.handler = handler;
    internal.running = true;
    await internal.processUpdate(incoming(1, "原问题"));
    internal.clearFlushTimer();
    await internal.flushBuffered();
    internal.clearFlushTimer();
    const paused = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(paused.inFlight.parts.map((part: any) => part.text), ["原问题"]);
    assert.equal(paused.inFlight.retryPaused, true);
    assert.equal(paused.inFlight.pauseReason, reason);
    assert.equal(paused.inFlight.retryAtMs, undefined);
    assert.equal(paused.pendingReply, undefined);
    assert.deepEqual(seen, ["原问题"]);
    assert.equal(sent.filter(text => text.includes(pauseNotice)).length, 1);

    await internal.processUpdate(incoming(2, "后续问题"));
    internal.clearFlushTimer();
    await internal.flushBuffered();
    internal.clearFlushTimer();
    assert.deepEqual(seen, ["原问题"], "new input must not silently replay a manually paused turn");
    const queued = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(queued.inFlight.parts.map((part: any) => part.text), ["原问题"]);
    assert.deepEqual(queued.buffer.parts.map((part: any) => part.text), ["后续问题"]);

    const restarted = new TelegramAdapter(config);
    const recovered = restarted as any;
    recovered.state = JSON.parse(await readFile(statePath, "utf8"));
    recovered.running = true;
    recovered.handler = handler;
    await recovered.flushBuffered();
    recovered.clearFlushTimer();
    assert.deepEqual(seen, ["原问题"], "restart must preserve the pause");

    exhausted = false;
    await recovered.processUpdate(incoming(3, "/retry"));
    recovered.clearFlushTimer();
    await recovered.flushBuffered();
    recovered.clearFlushTimer();
    assert.deepEqual(seen, ["原问题", "原问题"]);
    assert.equal(recovered.state.inFlight, undefined);
    assert.ok(sent.includes("答复：原问题"));
    assert.equal(sent.filter(text => text.includes(pauseNotice)).length, 1);
    await recovered.flushBuffered();
    recovered.clearFlushTimer();
    assert.deepEqual(seen, ["原问题", "原问题", "后续问题"]);
    assert.ok(sent.includes("答复：后续问题"));
    await adapter.stop();
    await restarted.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new owner message wakes a paused batch without losing quote-ordered buffers", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-telegram-wake-"));
  try {
    const adapter = new TelegramAdapter({
      token: "test", ownerId: "123", dataDir: root, inputDebounceMs: 0,
      mediaStore: {} as never,
      api: {
        async call<T>(method: string) { return true as T; },
        async getFile() { return {}; },
        async downloadFile() { return new Uint8Array(); },
      },
    });
    const internal = adapter as any;
    internal.handler = async () => ({ text: "ok" });
    internal.running = true;
    const inbound = (id: number, text: string, quoted?: number) => ({
      update_id: id,
      message: {
        message_id: id, date: id, text,
        from: { id: 123 }, chat: { id: 123, type: "private" },
        ...(quoted ? { reply_to_message: {
          message_id: quoted, date: 1, text: "quoted",
          from: { id: 11, is_bot: true }, chat: { id: 123, type: "private" },
        } } : {}),
      },
    });
    await internal.processUpdate(inbound(1, "第一条", 10));
    internal.state.inFlight = internal.state.buffer;
    delete internal.state.buffer;
    internal.state.inFlight.retryPaused = true;
    internal.state.inFlight.retryAttempts = 3;
    await internal.processUpdate(inbound(2, "第二条", 20));
    internal.clearFlushTimer();
    assert.equal(internal.state.inFlight.retryPaused, false);
    assert.equal(internal.state.inFlight.retryAttempts, 0);
    assert.equal(internal.state.buffer.parts[0].text, "第二条");
    await internal.flushBuffered();
    internal.clearFlushTimer();
    assert.equal(internal.state.inFlight, undefined);
    await adapter.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("literal npm test commands bypass debounce and auto-delete both command and reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-telegram-npm-test-"));
  try {
    const handled: string[] = [];
    const deleted: number[] = [];
    const sent: string[] = [];
    const adapter = new TelegramAdapter({
      token: "test-token", ownerId: "123", dataDir: root,
      mediaStore: { save: async () => { throw new Error("unexpected attachment"); } } as never,
      inputDebounceMs: 60_000,
      commandReplyAutoDeleteMs: 20,
      api: {
        async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
          if (method === "sendChatAction") return true as T;
          if (method === "sendMessage") {
            sent.push(String(body.text));
            return { message_id: 900 + sent.length } as T;
          }
          if (method === "deleteMessage") {
            deleted.push(Number(body.message_id));
            return true as T;
          }
          throw new Error("unexpected Telegram API call: " + method);
        },
        async getFile() { return {}; },
        async downloadFile() { return new Uint8Array(); },
      },
    });
    (adapter as any).handler = async (inbound: any) => {
      handled.push(inbound.text);
      return "测试通过";
    };
    (adapter as any).running = true;
    await (adapter as any).processUpdate({
      update_id: 17,
      message: {
        message_id: 50, date: 1, text: "npm run runtime:test",
        from: { id: 123 }, chat: { id: 123, type: "private" },
      },
    });
    assert.deepEqual(handled, ["npm run runtime:test"]);
    assert.deepEqual(sent, ["测试通过"]);
    assert.ok(deleted.includes(50));
    assert.equal((adapter as any).state.buffer, undefined);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.ok(deleted.includes(901), "test results should expire as slash command replies do");
    await adapter.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("/retry resumes a failed turn during backoff but never duplicates an active model call",async()=>{
  const root=await mkdtemp(join(tmpdir(),"gateway-manual-retry-"));let adapter:TelegramAdapter|undefined;
  try{
    const sent:string[]=[];let attempts=0,finish!:(value:any)=>void;
    adapter=new TelegramAdapter({token:"fixture",ownerId:"123",dataDir:root,inputDebounceMs:0,mediaStore:{} as any,
      api:{call:async(method:string,body:any)=>{if(method==="sendMessage")sent.push(body.text);return {message_id:100+sent.length};}} as any});
    const internal=adapter as any;internal.running=true;
    internal.handler=async()=>{attempts++;return attempts===1?{kind:"retry",retryAfterMs:60_000}:await new Promise(resolve=>{finish=resolve;});};
    const incoming=(id:number,text:string)=>({update_id:id,message:{message_id:id,date:id,text,from:{id:123},chat:{id:123,type:"private"}}});
    await internal.processUpdate(incoming(1,"保留这个问题"));internal.clearFlushTimer();
    await internal.flushBuffered();internal.clearFlushTimer();
    assert.equal(attempts,1);assert.equal(internal.state.inFlight.retryPaused,undefined);
    assert.ok(internal.state.inFlight.retryAtMs>Date.now());
    await internal.processUpdate(incoming(2,"/retry"));internal.clearFlushTimer();
    assert.match(sent.at(-1)!,/已恢复/);assert.ok(internal.state.inFlight.retryAtMs<=Date.now());
    const task=internal.flushBuffered();
    const deadline=Date.now()+2_000;
    while(!finish&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,1));
    assert.ok(finish,"the retried model call should start");
    await internal.processUpdate(incoming(3,"/retry"));internal.clearFlushTimer();
    assert.match(sent.at(-1)!,/仍在处理/);assert.equal(attempts,2);
    finish({kind:"model_reply",text:"成功回答",deliveryId:"retry-success"});await task;internal.clearFlushTimer();
    assert.equal(internal.state.inFlight,undefined);
    await internal.processUpdate(incoming(4,"/retry"));internal.clearFlushTimer();
    assert.match(sent.at(-1)!,/没有可重试/);assert.equal(attempts,2);
  }finally{await adapter?.stop();await rm(root,{recursive:true,force:true});}
});

test('temporary Telegram input and replies bypass durable buffers and restart in formal mode',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sophon-temp-channel-'));let adapter:TelegramAdapter|undefined;
 try{
  const seen:any[]=[];let commits=0;
  const config={token:'fixture',ownerId:'80001',dataDir:root,mediaStore:{} as never,
   api:{call:async()=>({message_id:42}),getFile:async()=>({}),downloadFile:async()=>new Uint8Array()} as TelegramApiClient,
   onReplyDelivered:async()=>{commits++;},temporaryReply:async(message:any,session:any)=>{seen.push({message,session});return {kind:'model_reply' as const,text:'temporary-response-marker'};}};
  adapter=new TelegramAdapter(config);const internal=adapter as any;internal.handler=async()=>{throw Error('formal handler must not run');};
  const update=(id:number,text:string)=>({update_id:id,message:{message_id:id,date:1,from:{id:80001},chat:{id:80001,type:'private'},text}});
  await internal.processUpdate(update(1,'/temp on'));await internal.processUpdate(update(2,'temporary-input-marker'));
  assert.equal(seen.length,1);assert.equal(commits,0);assert.equal(internal.temporary.messages.length,2);
  assert.equal(internal.state.buffer,undefined);assert.equal(internal.state.pendingReply,undefined);
  const {readdir}=await import('node:fs/promises');
  for(const file of await readdir(root,{recursive:true})){try{const content=await readFile(join(root,file),'utf8');assert.doesNotMatch(content,/temporary-input-marker|temporary-response-marker/);}catch(error){if((error as any).code!=='EISDIR')throw error;}}
  await internal.processUpdate(update(3,'/temp off'));assert.equal(internal.temporary,undefined);
  assert.equal((new TelegramAdapter(config) as any).temporary,undefined);
 }finally{await adapter?.stop();await rm(root,{recursive:true,force:true});}
});
