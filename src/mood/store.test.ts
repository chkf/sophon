import test from "node:test";
import assert from "node:assert/strict";
import { effectiveMood, MOOD_LABELS } from "./store.js";

const at = new Date("2026-10-25T12:00:00.000Z");
const earlier = (hours:number)=>new Date(at.getTime()-hours*3_600_000).toISOString();

test("Mood labels cover exactly ten levels",()=>{
  assert.equal(MOOD_LABELS.length,10);
  assert.equal(new Set(MOOD_LABELS).size,10);
});
test("Mood remains stable for six hours and changes after complete twelve-hour steps",()=>{
  assert.equal(effectiveMood(8,earlier(6),at),8);
  assert.equal(effectiveMood(8,earlier(17),at),8);
  assert.equal(effectiveMood(8,earlier(18),at),7);
  assert.equal(effectiveMood(8,earlier(30),at),6);
  assert.equal(effectiveMood(8,earlier(90),at),3);
});
test("Mood naturally recovers toward three when below equilibrium",()=>{
  assert.equal(effectiveMood(1,earlier(18),at),2);
  assert.equal(effectiveMood(1,earlier(30),at),3);
  assert.equal(effectiveMood(3,earlier(100),at),3);
});
test("Invalid or missing interaction timestamps do not alter Mood",()=>{
  assert.equal(effectiveMood(9,undefined,at),9);
  assert.equal(effectiveMood(9,"invalid",at),9);
});
