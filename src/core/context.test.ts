import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalCoreContextProvider } from "./context.js";

function core() {
  const root = mkdtempSync(join(tmpdir(), "gateway-local-context-"));
  mkdirSync(join(root, "core"));
  const file = join(root, "core", "core.md");
  const text = "测试专用 Core。请使用已验证的资料，不猜测。";
  writeFileSync(file, text, { mode: 0o600 });
  return { root, file, cleanup: () => rmSync(root, { force: true, recursive: true }) };
}

test("local Core loads without approval and Recent changes its context revision", async () => {
  const fixture = core();
  let recent = "最近的合成测试话题";
  const context = new LocalCoreContextProvider(fixture.root, () => recent);
  try {
    const first = await context.load();
    assert.equal(first.available, true);
    assert.match(first.data!.core, /测试专用/);
    assert.match(first.data!.coreRevision, /^sha256:[a-f0-9]{64}$/);
    assert.equal(first.data!.recent, recent);
    assert.match(first.data!.guidance, /可靠事实管理记忆/);
    const before = first.data!.recentRevision;
    recent = "一个新话题";
    const second = await context.load();
    assert.equal(second.available, true);
    assert.notEqual(before, second.data!.recentRevision);
    assert.equal(first.data!.coreRevision, second.data!.coreRevision);
  } finally { fixture.cleanup(); }
});

test("edited Core loads immediately; missing Core or unavailable Recent clears snapshot", async () => {
  const fixture = core();
  const provider = new LocalCoreContextProvider(fixture.root);
  try {
    assert.equal((await provider.load()).available, true);
    const original = (await provider.load()).data!.coreRevision;
    writeFileSync(fixture.file, "modified without approval");
    const updated = await provider.load();
    assert.equal(updated.available, true);
    assert.notEqual(updated.data!.coreRevision, original);
    rmSync(fixture.file);
    assert.equal((await provider.load()).available, false);
    assert.equal(provider.peek()!.available, false);
    const failed = new LocalCoreContextProvider(fixture.root, () => {
      throw new Error("database unavailable");
    });
    assert.equal((await failed.load()).available, false);
  } finally { fixture.cleanup(); }
});

test("compact guidance keeps Recent indexing without a fixed external service", async () => {
  const fixture = core();
  try {
    const guidance = (await new LocalCoreContextProvider(fixture.root).load()).data!.guidance;
    assert.match(guidance,/待接续话题、待跟进事项和待分享内容/);
    assert.match(guidance,/需要最新目录或正文时主动调用 gateway_recent_read/);
    assert.match(guidance,/只根据可靠事实管理记忆/);
    assert.doesNotMatch(guidance,/WORK_GUIDANCE|斜杠命令|没看过/);
  } finally { fixture.cleanup(); }
});
