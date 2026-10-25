import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostMonitor, cpuPercent, networkRates, parseLinuxMemory, parseLinuxNetwork } from "./host.js";

test("CPU rates require a baseline and reject reset or changed-core samples", () => {
  const previous = { total: 1000, idle: 400, cores: 2 };
  const current = { total: 1200, idle: 450, cores: 2 };
  assert.equal(cpuPercent(undefined, current), null);
  assert.equal(cpuPercent(previous, current), 75);
  assert.equal(cpuPercent(current, previous), null);
  assert.equal(cpuPercent(previous, { ...current, cores: 3 }), null);
  assert.equal(cpuPercent(previous, previous), null);
  assert.equal(cpuPercent(previous, { ...current, idle: 700 }), null);
  assert.equal(cpuPercent(previous, { ...current, idle: 600 }), 0);
});

test("Linux memory distinguishes available memory from free memory and preserves missing readings", () => {
  assert.deepEqual(parseLinuxMemory("MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 400 kB\nSwapTotal: 200 kB\nSwapFree: 50 kB\n"),
    { memoryTotalBytes: 1024000, memoryUsedBytes: 614400, swapTotalBytes: 204800, swapUsedBytes: 153600 });
  const noAvailable = parseLinuxMemory("MemTotal: 1000 kB\nMemFree: 100 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n");
  assert.equal(noAvailable.memoryUsedBytes, null);
  assert.equal(noAvailable.swapUsedBytes, 0);
  assert.equal(parseLinuxMemory("MemTotal: 100 kB\nMemAvailable: 200 kB\n").memoryUsedBytes, null);
  assert.equal(parseLinuxMemory("").memoryTotalBytes, null);
});

test("network parser omits loopback and rates use per-interface monotonic deltas", () => {
  const row = (name: string, rx: string, tx: string) => `${name}: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`;
  const previous = parseLinuxNetwork([row("lo", "9999", "9999"), row("eth0", "90071992547409930", "100"), row("eth1", "200", "300")].join("\n"))!;
  assert.deepEqual(previous.map(value => value.name), ["eth0", "eth1"]);
  const current = parseLinuxNetwork([row("eth1", "700", "800"), row("eth0", "90071992547412430", "1100")].join("\n"))!;
  assert.deepEqual(networkRates(previous, current, 5000), { rxBytesPerSecond: 600, txBytesPerSecond: 300 });
  assert.deepEqual(networkRates(undefined, current, 5000), { rxBytesPerSecond: null, txBytesPerSecond: null });
  assert.equal(networkRates(previous, current, 0).rxBytesPerSecond, null);
  assert.equal(networkRates(previous, [current[0]], 5000).rxBytesPerSecond, null);
  assert.equal(networkRates(previous, [{ ...current[0], name: "eth2" }, current[1]], 5000).rxBytesPerSecond, null);
  // One counter reset must remain unknown, even if another interface grew enough to mask it.
  assert.equal(networkRates(previous, [{ ...current[0], rx: 1n }, { ...current[1], rx: 90071992547420000n }], 5000).rxBytesPerSecond, null);
  assert.equal(parseLinuxNetwork(row("eth0", "bad", "100")), undefined);
});

test("host snapshot does not create the data directory and exposes unavailable disk data as null", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-host-test-"));
  const monitor = new HostMonitor(join(root, "missing"));
  try {
    const snapshot = await monitor.snapshot();
    assert.equal(snapshot.samples.length, 1);
    assert.equal(snapshot.samples[0].cpuPercent, null);
    assert.equal(snapshot.samples[0].rxBytesPerSecond, null);
    assert.equal(snapshot.samples[0].diskTotalBytes, null);
    assert.ok(snapshot.scopeNotes.some(note => note.includes("容量暂不可用")));
    assert.ok(snapshot.rssBytes > 0);
    snapshot.samples[0].diskTotalBytes = 123;
    snapshot.networkInterfaces.push("synthetic");
    const again = await monitor.snapshot();
    assert.equal(again.samples[0].diskTotalBytes, null);
    assert.ok(!again.networkInterfaces.includes("synthetic"));
    monitor.start();
    monitor.start();
    await monitor.snapshot();
  } finally { monitor.stop(); await rm(root, { recursive: true, force: true }); }
});
