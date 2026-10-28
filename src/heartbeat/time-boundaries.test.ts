import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { HeartbeatConfig } from "../config/index.js";
import { ReminderRunner } from "../reminders/runner.js";
import { ReminderStore } from "../reminders/store.js";
import type { ChatRequest, ChatResponse } from "../runtime/types.js";
import { SerialQueue } from "../util/serial-queue.js";
import type { HeartbeatState } from "./policy.js";
import { HeartbeatRunner } from "./runner.js";

const config: HeartbeatConfig = {
  enabled: true, planningEnabled: false, timezone: "UTC",
  quietStart: "23:00", quietEnd: "07:00", cooldownMinutes: 0,
  dailyCap: 4, minIntervalMinutes: 30, maxIntervalMinutes: 30,
};

async function setup(t: TestContext, options: {
  config?: Partial<HeartbeatConfig>;
  queue?: SerialQueue;
  paused?: boolean;
  reply?: (request: ChatRequest) => Promise<ChatResponse>;
  isActive?: () => Promise<boolean>;
  sendImages?: () => Promise<boolean>;
  reminders?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "sophon-time-boundaries-"));
  const calls: ChatRequest[] = [], sends: string[] = [], reminderSends: string[] = [];
  const reminders = options.reminders ? new ReminderStore(root) : undefined;
  const delivery = reminders ? new ReminderRunner(reminders, async () => true, async () => {
    reminderSends.push(new Date().toISOString());
  }) : undefined;
  const runner = new HeartbeatRunner(root, { ...config, ...options.config }, {
    reply: async request => {
      calls.push(request);
      return options.reply ? options.reply(request) : { text: "Sample report is ready." };
    },
  }, {
    latestActivityAt: async () => undefined,
    latestConversation: async () => undefined,
    append: async () => undefined,
  } as never, {
    load: async () => ({ available: true, data: {
      core: "Use verified information.", guidance: "Use concise wording.", recent: [],
    } }),
  } as never, {
    resolve: async () => ({ channel: "telegram", target: "sample-target" }),
    isActive: options.isActive ?? (async () => true),
    sendIfActive: async () => { sends.push(new Date().toISOString()); return true; },
    sendImagesIfActive: options.sendImages,
  } as never, undefined, () => options.paused ?? false, undefined, options.queue,
  undefined, undefined, undefined, undefined, undefined, undefined, reminders, delivery);
  t.after(async () => { await runner.stop(); await rm(root, { recursive: true, force: true }); });
  const state = async () => JSON.parse(await readFile(join(root, "heartbeat/state.json"), "utf8")) as HeartbeatState;
  return { runner, calls, sends, reminderSends, reminders, state };
}

test("a scheduled check uses execution time after waiting behind a conversation", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2030-01-02T22:29:00Z") });
  const queue = new SerialQueue();
  const { runner, calls, sends } = await setup(t, { queue });
  await runner.start();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const conversation = queue.run(() => gate);
  t.mock.timers.tick(30 * 60_000);
  const scheduled = (runner as unknown as { pendingTick: Promise<void> }).pendingTick;
  t.mock.timers.setTime(new Date("2030-01-02T23:10:00Z").getTime());
  release();
  await conversation;
  await scheduled;
  assert.equal(calls.length, 0);
  assert.equal(sends.length, 0);
  assert.equal(runner.scheduling().nextActionAt, "2030-01-02T23:40:00.000Z");
});

test("a reply completed during quiet hours stays unsent and expires before morning", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2030-01-02T22:59:00Z") });
  const { runner, calls, sends, state } = await setup(t, { reply: async () => {
    t.mock.timers.setTime(new Date("2030-01-02T23:05:00Z").getTime());
    return { text: "Sample report is ready." };
  } });
  await runner.tick();
  assert.equal(calls.length, 1);
  assert.equal(sends.length, 0);
  assert.equal((await state()).sentToday, 0);
  assert.ok((await state()).pending);
  t.mock.timers.setTime(new Date("2030-01-03T07:00:00Z").getTime());
  await runner.tick();
  assert.equal(sends.length, 0);
  assert.equal(calls.length, 1);
  assert.equal((await state()).pending, undefined);
});

test("delivery preparation rechecks quiet hours after asynchronous channel validation", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2030-01-02T22:59:00Z") });
  const { runner, sends, state } = await setup(t, { isActive: async () => {
    t.mock.timers.setTime(new Date("2030-01-02T23:01:00Z").getTime());
    return true;
  } });
  await runner.tick();
  assert.equal(sends.length, 0);
  assert.equal((await state()).sentToday, 0);
});

test("a delayed daytime reply records delivery time and is not sent twice", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2030-01-02T12:00:00Z") });
  const { runner, calls, sends, state } = await setup(t, { reply: async () => {
    t.mock.timers.setTime(new Date("2030-01-02T12:03:00Z").getTime());
    return { text: "Sample report is ready." };
  } });
  await runner.tick();
  assert.deepEqual(sends, ["2030-01-02T12:03:00.000Z"]);
  assert.equal((await state()).lastSentAt, sends[0]);
  await runner.tick();
  assert.equal(calls.length, 1);
  assert.equal(sends.length, 1);
});

test("a generation older than the pending lifetime is discarded even outside quiet hours", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2030-01-02T12:00:00Z") });
  const { runner, sends, state } = await setup(t, { reply: async () => {
    t.mock.timers.setTime(new Date("2030-01-02T12:46:00Z").getTime());
    return { text: "Sample report is ready." };
  } });
  await runner.tick();
  assert.equal(sends.length, 0);
  assert.equal((await state()).pending, undefined);
});

test("a multipart proactive delivery stops when quiet hours start between parts", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2030-01-02T22:59:00Z") });
  let images = 0;
  const { runner, sends, state } = await setup(t, {
    reply: async () => ({ text: "Sample chart is ready.", images: [{ sha256: "sample-image" } as never] }),
    sendImages: async () => {
      images++;
      t.mock.timers.setTime(new Date("2030-01-02T23:01:00Z").getTime());
      return true;
    },
  });
  await runner.tick();
  assert.equal(images, 1);
  assert.equal(sends.length, 0);
  assert.equal((await state()).pending, undefined);
});

test("random checks support an awake window entirely before 07:00", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2030-01-02T06:30:00Z") });
  const { runner, calls, sends } = await setup(t, {
    config: { quietStart: "07:00", quietEnd: "06:00" },
  });
  await runner.tick();
  assert.equal(calls.length, 1);
  assert.equal(sends.length, 1);
  assert.equal(runner.scheduling().nextActionAt, "2030-01-02T07:00:00.000Z");
  t.mock.timers.setTime(new Date("2030-01-02T07:00:00Z").getTime());
  await runner.tick();
  assert.equal(calls.length, 1);
  assert.equal(runner.scheduling().nextActionAt, "2030-01-02T07:30:00.000Z");
});

test("paused planning does not attempt to find an unavailable morning window", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2030-01-02T06:30:00Z") });
  const { runner, calls } = await setup(t, {
    config: { planningEnabled: true, quietStart: "07:00", quietEnd: "06:00" }, paused: true,
  });
  await runner.tick();
  assert.equal(calls.length, 0);
  assert.equal(runner.scheduling().nextActionAt, null);
});

test("a reminder that becomes due while queued is delivered even while proactive is paused", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2030-01-02T22:59:00Z") });
  const queue = new SerialQueue();
  const { runner, calls, reminders, reminderSends } = await setup(t, { queue, paused: true, reminders: true });
  const task = await reminders!.create({
    text: "Review the sample report.", dueAt: "2030-01-02T23:00:00Z", timezone: "UTC",
    channel: "telegram", target: "70002", source: "sample-task",
  }, new Date());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const conversation = queue.run(() => gate);
  const check = runner.tick();
  t.mock.timers.setTime(new Date("2030-01-02T23:01:00Z").getTime());
  release();
  await conversation;
  await check;
  assert.equal(calls.length, 0);
  assert.deepEqual(reminderSends, ["2030-01-02T23:01:00.000Z"]);
  assert.equal((await reminders!.list()).find(item => item.id === task.id)?.status, "delivered");
});
