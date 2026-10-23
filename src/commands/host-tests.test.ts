import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostTestRunner, isHostTestScript } from "./host-tests.js";

test("host test runner captures successful, failed and sanitized npm output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-host-test-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      private: true,
      scripts: {
        "runtime:test": "node -e \"console.log('TELEGRAM_BOT_TOKEN=123456:secret-token'); console.log('healthy')\"",
        "gateway:check": "node -e \"console.error('check failed'); process.exit(7)\"",
        "runtime:diagnose": "node -e \"console.log('A PASS B PASS C PASS')\"",
      },
    }));
    const runner = new HostTestRunner(dir, 15_000, 15_000);
    assert.equal(isHostTestScript("runtime:diagnose"), true);
    assert.equal(isHostTestScript("runtime:diagnose --allow-paid"), false);
    const success = await runner.run("runtime:test");
    assert.match(success, /结果：通过/);
    assert.match(success, /healthy/);
    assert.match(success, /TELEGRAM_BOT_TOKEN=\[REDACTED\]/);
    const diag = await runner.run("runtime:diagnose");
    assert.match(diag, /结果：通过/);
    assert.match(diag, /A PASS B PASS C PASS/);
    assert.doesNotMatch(success, /123456:secret-token/);
    const failed = await runner.run("gateway:check");
    assert.match(failed, /结果：失败/);
    assert.match(failed, /exit=7/);
    assert.match(failed, /check failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("host test runner prevents overlapping execution and terminates timeouts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-host-test-timeout-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({
      private: true,
      scripts: { "typecheck": "node -e \"setTimeout(()=>{}, 5000)\"" },
    }));
    const runner = new HostTestRunner(dir, 300);
    const running = runner.run("typecheck");
    assert.match(await runner.run("typecheck"), /正在运行/);
    const output = await running;
    assert.match(output, /结果：超时/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
