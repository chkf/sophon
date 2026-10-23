import assert from "node:assert/strict";
import test from "node:test";
import { heartbeatEligible, heartbeatFingerprint, isQuietTime, type HeartbeatState } from "./policy.js";

const config = {
  timezone: "Asia/Shanghai",
  quietStart: "23:00",
  quietEnd: "08:00",
  cooldownMinutes: 180,
  dailyCap: 2,
};

function state(sentToday = 0): HeartbeatState {
  return { dateKey: "2026-10-04", sentToday, recent: [] };
}

test("quiet hours work across midnight", () => {
  assert.equal(isQuietTime(new Date("2026-10-04T16:00:00Z"), "Asia/Shanghai", "23:00", "08:00"), true);
  assert.equal(isQuietTime(new Date("2026-10-04T04:00:00Z"), "Asia/Shanghai", "23:00", "08:00"), false);
});

test("heartbeat enforces cooldown and daily cap", () => {
  const now = new Date("2026-10-04T06:00:00Z");
  assert.equal(heartbeatEligible(now, config, state(), "2026-10-04T05:00:00Z").reason, "cooldown");
  assert.equal(heartbeatEligible(now, config, state(2)).reason, "daily-cap");
  assert.equal(heartbeatEligible(now, config, state(), "2026-10-04T01:00:00Z").eligible, true);
});

test("heartbeat cooldown also applies after a proactive send", () => {
  const now = new Date("2026-10-04T06:00:00Z");
  const current = state();
  current.lastSentAt = "2026-10-04T04:00:00Z";
  assert.equal(heartbeatEligible(now, config, current, "2026-10-03T01:00:00Z").reason, "cooldown");
});

test("heartbeat dedup fingerprint ignores spacing and case", () => {
  assert.equal(heartbeatFingerprint(" Hello  Gateway "), heartbeatFingerprint("hello gateway"));
});


test("preferred 01:00–07:00 quiet hours exclude exactly the overnight window", () => {
  assert.equal(isQuietTime(new Date("2026-10-04T16:59:00Z"), "Asia/Shanghai", "01:00", "07:00"), false); // 00:59
  assert.equal(isQuietTime(new Date("2026-10-04T17:00:00Z"), "Asia/Shanghai", "01:00", "07:00"), true);  // 01:00
  assert.equal(isQuietTime(new Date("2026-10-04T22:59:00Z"), "Asia/Shanghai", "01:00", "07:00"), true);  // 06:59
  assert.equal(isQuietTime(new Date("2026-10-04T23:00:00Z"), "Asia/Shanghai", "01:00", "07:00"), false); // 07:00
});

test("preferred 60-minute cooldown and 8-attempt cap still block repeated proactive decisions", () => {
  const preferred = {
    timezone: "Asia/Shanghai", quietStart: "01:00", quietEnd: "07:00",
    cooldownMinutes: 60, dailyCap: 8,
  };
  const now = new Date("2026-10-04T08:00:00Z"); // 16:00 local
  const current = { dateKey: "2026-10-04", sentToday: 7, recent: [] };
  assert.equal(heartbeatEligible(now, preferred, current, "2026-10-04T07:01:00Z").reason, "cooldown");
  assert.equal(heartbeatEligible(now, preferred, current, "2026-10-04T06:59:00Z").eligible, true);
  assert.equal(heartbeatEligible(now, preferred, { ...current, sentToday: 8 }, "2026-10-04T06:59:00Z").reason, "daily-cap");
});
