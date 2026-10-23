import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireInstanceLock } from "./instance-lock.js";

test("Gateway instance lock allows one live owner and releases cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-lock-"));
  try {
    const first = await acquireInstanceLock(root);
    await assert.rejects(
      () => acquireInstanceLock(root),
      /Another Gateway instance is still active/,
    );
    await first.release();
    const second = await acquireInstanceLock(root);
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway instance lock recovers a stale owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-lock-"));
  try {
    const lockDir = join(root, "runtime", "gateway-instance.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, startedAt: new Date(0).toISOString() }),
      "utf8",
    );
    const lock = await acquireInstanceLock(root);
    assert.equal(lock.pid, process.pid);
    await lock.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("instance lock exposes an owner-specific takeover token", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-lock-"));
  try {
    const lock = await acquireInstanceLock(root);
    assert.ok(lock.takeoverToken.length >= 32);
    await lock.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
