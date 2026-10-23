import assert from "node:assert/strict";
import test from "node:test";
import { basePlanningWindowOpen, isCurrentMorningPlan, nextDueWake, parseWakePlan } from "./planner.js";

const now = new Date("2026-10-11T00:00:00Z"); // 08:00 Asia/Shanghai

test("daily plan validates time, spacing, quiet hours, and future-only wakes", () => {
  const plan = parseWakePlan(JSON.stringify({ wakes: [
    { time: "08:10", intent: "too soon" },
    { time: "10:30", intent: "聊聊考试" },
    { time: "10:50", intent: "duplicate window" },
    { time: "16:00", intent: "自然闲聊" },
    { time: "23:15", intent: "quiet" },
    { time: "25:00", intent: "invalid" },
  ] }), now, "Asia/Shanghai", "23:00", "08:00", 4, "telegram", "2026-10-10T22:00:00Z");
  assert.deepEqual(plan.wakes.map(wake => wake.time), ["10:30", "16:00"]);
  assert.equal(plan.date, "2026-10-11");
  assert.equal(plan.channel, "telegram");
  assert.equal(plan.lastUserAt, "2026-10-10T22:00:00Z");
  assert.equal(nextDueWake(plan, new Date("2026-10-11T02:29:00Z"), "Asia/Shanghai"), undefined);
  assert.equal(nextDueWake(plan, new Date("2026-10-11T02:30:00Z"), "Asia/Shanghai"), 0);
  assert.equal(nextDueWake(plan, new Date("2026-10-11T03:16:00Z"), "Asia/Shanghai"), undefined);
  assert.equal(nextDueWake(plan, new Date("2026-10-11T08:00:00Z"), "Asia/Shanghai"), 1);
  plan.wakes[0]!.consumed = true;
  assert.equal(nextDueWake(plan, new Date("2026-10-11T02:30:00Z"), "Asia/Shanghai"), undefined);
});

test("daily plan rejects invalid JSON without sending anything", () => {
  assert.throws(() => parseWakePlan("这里是我的计划", now, "Asia/Shanghai", "23:00", "08:00", 4, "telegram"));
  assert.throws(() => parseWakePlan('{"wrong":[]}', now, "Asia/Shanghai", "23:00", "08:00", 4, "telegram"));
});

test("empty valid plan is respected and capped plans cannot bypass daily limits", () => {
  const empty = parseWakePlan('{"wakes":[]}', now, "Asia/Shanghai", "23:00", "08:00", 4, "telegram");
  assert.deepEqual(empty.wakes, []);
  const large = parseWakePlan(JSON.stringify({wakes: Array.from({length: 12}, (_, i) => ({
    time: String(9 + i).padStart(2,"0") + ":00", intent: "check " + i,
  }))}), now, "Asia/Shanghai", "23:00", "08:00", 2, "telegram");
  assert.equal(large.wakes.length, 4);
});


test("a new day is not planned between midnight and 07:00 Asia/Shanghai", () => {
  const timezone = "Asia/Shanghai";
  const times = [
    ["2026-10-10T16:00:00Z", false], // 00:00 local
    ["2026-10-10T16:59:00Z", false], // 00:59 local (not in quiet hours)
    ["2026-10-10T22:59:00Z", false], // 06:59 local
    ["2026-10-10T23:00:00Z", true],  // 07:00 local
    ["2026-10-11T15:59:00Z", true],  // 23:59 local
  ] as const;
  for (const [instant, expected] of times) {
    assert.equal(basePlanningWindowOpen(new Date(instant), timezone), expected, instant);
  }
});

test("plans made before 07:00 are stale, even if prepared by the previous version", () => {
  const timezone = "Asia/Shanghai";
  const morning = new Date("2026-10-10T23:00:00Z");
  const plan = parseWakePlan('{"wakes":[{"time":"09:00","intent":"早上问候"}]}',
    new Date("2026-10-10T16:30:00Z"), timezone, "01:00", "07:00", 8, "telegram");
  assert.equal(plan.date, "2026-10-11");
  assert.equal(isCurrentMorningPlan(plan, morning, timezone), false);
  plan.generatedAt = morning.toISOString();
  assert.equal(isCurrentMorningPlan(plan, morning, timezone), true);
  assert.equal(isCurrentMorningPlan(plan, new Date("2026-10-11T23:00:00Z"), timezone), false);
  plan.generatedAt = "bad-date";
  assert.equal(isCurrentMorningPlan(plan, morning, timezone), false);
});
