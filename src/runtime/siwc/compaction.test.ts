import assert from "node:assert/strict";
import test from "node:test";
import { checkpointFromItems } from "./compaction.js";

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
