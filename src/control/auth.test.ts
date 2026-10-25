import assert from "node:assert/strict";
import test from "node:test";
import { ControlAuth, ControlRateLimiter } from "./auth.js";

test("login codes are one-use, expire and are replaced by a new owner request", () => {
  let now = 1_000;
  const auth = new ControlAuth(true, () => now);
  const old = auth.issueCode(), current = auth.issueCode();
  assert.equal(auth.consumeCode(old), false);
  assert.equal(auth.consumeCode(current), true);
  assert.equal(auth.consumeCode(current), false);
  const expired = auth.issueCode(); now += 5 * 60_000;
  assert.equal(auth.consumeCode(expired), false);
  for (const bad of [undefined, [], {}, "x", "A".repeat(100_000)]) assert.equal(auth.consumeCode(bad), false);
});

test("sessions expire and require the exact CSRF token without accepting duplicate cookies", () => {
  let now = 1_000;
  const auth = new ControlAuth(true, () => now), { id, session } = auth.create();
  assert.equal(auth.get(id), session);
  assert.equal(auth.validCsrf(session, session.csrfToken), true);
  assert.equal(auth.validCsrf(session, "中".repeat(43)), false);
  assert.equal(auth.validCsrf(session, [session.csrfToken]), false);
  assert.equal(auth.readCookie(auth.cookieName + "=" + id), id);
  assert.equal(auth.readCookie(auth.cookieName + "=" + id + "; " + auth.cookieName + "=" + id), "");
  assert.match(auth.cookie(id), /^__Host-sophon-control=.*HttpOnly; SameSite=Strict;.*Secure$/);
  now += 8 * 60 * 60_000;
  assert.equal(auth.get(id), undefined);
});

test("logout and shutdown revoke authorization; local HTTP cookies have a separate name", () => {
  const auth = new ControlAuth(false), first = auth.create(), second = auth.create(), code = auth.issueCode();
  auth.revoke(first.id);
  assert.equal(auth.get(first.id), undefined);
  assert.ok(auth.get(second.id));
  auth.revokeAll();
  assert.equal(auth.get(second.id), undefined);
  assert.equal(auth.consumeCode(code), false);
  assert.match(auth.cookie(""), /^sophon-control-local=;.*Max-Age=0$/);
});

test("rate limits expire and keep independent budgets", () => {
  let now = 0;
  const rate = new ControlRateLimiter(() => now);
  assert.equal(rate.allow("login", 2), true);
  assert.equal(rate.allow("login", 2), true);
  assert.equal(rate.allow("login", 2), false);
  assert.equal(rate.allow("data", 2), true);
  now = 60_000;
  assert.equal(rate.allow("login", 2), true);
});
