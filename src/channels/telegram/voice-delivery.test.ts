import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { TelegramAdapter } from "./adapter.js";
import type { TelegramAdapterConfig } from "./types.js";
import { ActiveChannelRouter } from "../active.js";
import { HeartbeatRunner } from "../../heartbeat/runner.js";
import type { HeartbeatState } from "../../heartbeat/policy.js";
import { SessionStore } from "../../sessions/store.js";

const voice = "这段是已经登记的语音原文。";
const fallbackVoice = "（语音未发出，已改用文字；原因见 /model → 语音设置。）\n" + voice;
// Fenced code bypasses prose splitting and exercises the Telegram hard limit too.
const supplement = "```text\n" + "x".repeat(4200) + "\n```";
const firstSupplement = supplement.slice(0, 4000);
const inbound = {
  channel: "telegram" as const, conversationId: "123", senderId: "123", messageId: "10",
  text: "请用语音说明，代码另发文字", attachments: [], receivedAt: "2026-10-22T02:30:00.000Z",
};

async function temporary(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "gateway-voice-delivery-"));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function fixture(root: string, spoken: boolean | "uncertain", failAt: number, malformedResponse?: { message_id?: unknown }) {
  const attemptedText: string[] = [];
  const confirmedText: string[] = [];
  const commits: Parameters<NonNullable<TelegramAdapterConfig["onReplyDelivered"]>>[0][] = [];
  let voiceCalls = 0;
  let failures = 0;
  const sendVoice = async () => {
    voiceCalls++;
    if (spoken === "uncertain") throw new Error("voice response lost");
    return spoken;
  };
  const adapter = new TelegramAdapter({
    token: "fixture", ownerId: "123", dataDir: root, mediaStore: {} as never,
    api: {
      async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
        if (method !== "sendMessage") return true as T;
        const text = String(body.text);
        attemptedText.push(text);
        if (attemptedText.length === failAt) {
          if (malformedResponse) return malformedResponse as T;
          throw new Error("text response lost");
        }
        confirmedText.push(text);
        return { message_id: attemptedText.length } as T;
      },
      async getFile() { throw new Error("no incoming media expected"); },
      async downloadFile() { throw new Error("no incoming media expected"); },
    },
    sendVoice, sendProactiveVoice: sendVoice,
    async onReplyDelivered(event) { commits.push(event); },
    async onReplyDeliveryFailed() { failures++; },
  });
  return { adapter, attemptedText, confirmedText, commits, voiceCalls: () => voiceCalls, failures: () => failures };
}

async function prepared(f: ReturnType<typeof fixture>, text = voice + "\n\n" + supplement, voiceText = voice) {
  const internal = f.adapter as any;
  await internal.prepareReply(inbound, { kind: "model_reply", text, voiceText, deliveryId: "voice-delivery:10" });
  await internal.resumePendingReply();
  await internal.resumePendingReply();
}

async function assertConsumedAfterRestart(root: string) {
  const state = JSON.parse(await readFile(join(root, "channels", "telegram.json"), "utf8"));
  assert.equal(state.pendingReply, undefined);
  const restarted = fixture(root, true, 0);
  (restarted.adapter as any).state = state;
  await (restarted.adapter as any).resumePendingReply();
  assert.equal(restarted.voiceCalls(), 0);
  assert.deepEqual(restarted.attemptedText, []);
  assert.deepEqual(restarted.commits, []);
}

for (const spoken of [true, false]) {
  test(`TG ${spoken ? "confirmed voice" : "text fallback"} preserves acknowledged supplement chunks after a later failure`, () => temporary(async root => {
    const f = fixture(root, spoken, spoken ? 2 : 3);
    await prepared(f);
    assert.equal(f.voiceCalls(), 1);
    assert.deepEqual(f.confirmedText, spoken ? [firstSupplement] : [fallbackVoice, firstSupplement]);
    assert.equal(f.commits.length, 1);
    assert.equal(f.commits[0]!.reply, (spoken ? voice : fallbackVoice) + "\n\n" + firstSupplement);
    assert.equal(f.commits[0]!.complete, false);
    assert.equal(f.commits[0]!.deliveryId, "voice-delivery:10");
    assert.equal(f.failures(), 0);
    assert.equal(f.attemptedText.length, spoken ? 2 : 3);
    await assertConsumedAfterRestart(root);
  }));
}

test("TG voice fallback records only the original-text bubbles acknowledged before failure", () => temporary(async root => {
  const f = fixture(root, false, 2);
  const original = "第一段原文。\n\n第二段原文。";
  await prepared(f, original + "\n\n补充不应发送", original);
  assert.deepEqual(f.attemptedText, ["（语音未发出，已改用文字；原因见 /model → 语音设置。）\n第一段原文。", "第二段原文。"]);
  assert.equal(f.commits[0]!.reply, "（语音未发出，已改用文字；原因见 /model → 语音设置。）\n第一段原文。");
  assert.equal(f.commits[0]!.complete, false);
  assert.equal(f.failures(), 0);
  await assertConsumedAfterRestart(root);
}));

test("TG uncertain voice stops before any text or history and is not replayed on restart", () => temporary(async root => {
  const f = fixture(root, "uncertain", 0);
  await prepared(f);
  assert.equal(f.voiceCalls(), 1);
  assert.deepEqual(f.attemptedText, []);
  assert.deepEqual(f.commits, []);
  assert.equal(f.failures(), 1);
  await assertConsumedAfterRestart(root);
}));

test("TG voice text delivery stops on missing or invalid acknowledgements without inventing a delivered chunk", async () => {
  for (const malformedResponse of [{}, { message_id: 0 }, { message_id: Number.NaN }, { message_id: Number.MAX_SAFE_INTEGER + 1 }]) {
  for (const spoken of [true, false]) await temporary(async root => {
    const f = fixture(root, spoken, 1, malformedResponse);
    await prepared(f);
    assert.equal(f.attemptedText.length, 1, "do not send beyond the uncertain chunk");
    assert.deepEqual(f.confirmedText, []);
    assert.equal(f.commits.length, spoken ? 1 : 0);
    if (spoken) {
      assert.equal(f.commits[0]!.reply, voice);
      assert.equal(f.commits[0]!.complete, false);
    }
    assert.equal(f.failures(), spoken ? 0 : 1);
    await assertConsumedAfterRestart(root);
  });
  }
});

test("heartbeat commits TG voice and confirmed text chunks as one partial reply and consumes the pending attempt", async () => {
  for (const spoken of [true, false]) await temporary(async root => {
    const sessions = new SessionStore(root);
    try {
      const f = fixture(root, spoken, spoken ? 2 : 3);
      const router = new ActiveChannelRouter(root, { telegram: f.adapter }, "telegram");
      const config = {
        enabled: true, channel: "telegram" as const, timezone: "Asia/Shanghai",
        quietStart: "23:00", quietEnd: "08:00", cooldownMinutes: 180, dailyCap: 4,
        minIntervalMinutes: 60, maxIntervalMinutes: 120,
      };
      const runner = new HeartbeatRunner(root, config, {} as never, sessions, {} as never, router);
      const now = new Date("2026-10-22T02:30:00.000Z");
      const state: HeartbeatState = {
        dateKey: "2026-10-22", sentToday: 0, recent: [],
        pending: { channel: "telegram", target: "123", at: now.toISOString(),
          fingerprint: "fixture-voice", text: voice + "\n\n" + supplement, voiceText: voice },
      };
      await (runner as any).flushPending(state, now);
      const messages = (await sessions.get("telegram", "123", "123")).messages;
      assert.equal(messages.length, 1);
      assert.equal(messages[0]!.content, voice + "\n\n" + firstSupplement);
      assert.equal(messages[0]!.origin, "proactive");
      assert.equal(messages[0]!.partial, true);
      assert.equal(f.voiceCalls(), 1);
      const recovered = JSON.parse(await readFile(join(root, "heartbeat", "state.json"), "utf8"));
      assert.equal(recovered.pending, undefined);
      assert.equal(recovered.sentToday, 1);
      const restarted = new HeartbeatRunner(root, config, {} as never, sessions, {} as never, router);
      await (restarted as any).flushPending(recovered, now);
      assert.equal(f.voiceCalls(), 1);
      assert.equal(f.attemptedText.length, spoken ? 2 : 3);
      assert.equal((await sessions.get("telegram", "123", "123")).messages.length, 1);
    } finally { sessions.close(); }
  });
});
