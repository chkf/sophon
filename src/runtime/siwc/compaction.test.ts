import assert from "node:assert/strict";
import test from "node:test";
import { checkpointFromItems, sevenDayCompactionDue, SIWC_AUTO_COMPACT_TOKENS,
  SIWC_SEVEN_DAYS_MS } from "./compaction.js";

test("seven-day deadline starts with the session and resets on real compaction", () => {
  const initial = "2026-10-01T12:00:00.000Z";
  const recent = "2026-10-06T12:00:00.000Z";
  assert.equal(sevenDayCompactionDue(initial, undefined, Date.parse(initial) + SIWC_SEVEN_DAYS_MS - 1), false);
  assert.equal(sevenDayCompactionDue(initial, undefined, Date.parse(initial) + SIWC_SEVEN_DAYS_MS), true);
  assert.equal(sevenDayCompactionDue(initial, recent, Date.parse(initial) + SIWC_SEVEN_DAYS_MS), false);
  assert.equal(sevenDayCompactionDue(initial, recent, Date.parse(recent) + SIWC_SEVEN_DAYS_MS), true);
  assert.equal(sevenDayCompactionDue(undefined, undefined, Date.now()), false);
  assert.equal(SIWC_AUTO_COMPACT_TOKENS, 120_000);
});

test("only a genuine opaque compaction item can establish a checksummed checkpoint", () => {
  const item = { type: "compaction", encrypted_content: "fixture-opaque" };
  const result = checkpointFromItems("session", "gpt-fixture", [item], 34, "capacity", "2026-10-23T00:00:00Z");
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.id, /^[a-f0-9]{64}$/);
  assert.equal(result.coveredThroughSeq, 34);
  assert.equal(result.reason, "capacity");
  assert.equal(checkpointFromItems("session", "gpt-fixture", [item], 34, "capacity", result.at).id, result.id);
  assert.notEqual(checkpointFromItems("session", "gpt-fixture", [item], 34, "capacity", "2026-10-30T00:00:00Z").id,
    result.id, "separate successful compactions must remain separate notice events");
  assert.throws(() => checkpointFromItems("session", "gpt-fixture", [{ type: "message" }], 34,
    "capacity", result.at), /No valid SIWC/);
});
