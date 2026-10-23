import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreUnavailableError, loadCore } from "./loader.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gateway-core-"));
  mkdirSync(join(root, "core"));
  const file = join(root, "core", "core.md");
  const text = "# Gateway Core\n\n用于测试的本地规则，不含私人资料。\n";
  writeFileSync(file, text, { mode: 0o600 });
  return { root, file, text, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("Core works with only core.md and allows edits without an approval record", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await loadCore(f.root), { text: f.text });
    // A stale or explicitly disapproving legacy record must never block Core.
    writeFileSync(join(f.root, "core", "approval.json"),
      JSON.stringify({ version: 1, approved: false, sha256: "invalid" }));
    assert.deepEqual(await loadCore(f.root), { text: f.text });
    writeFileSync(f.file, "# Updated Core\n");
    assert.deepEqual(await loadCore(f.root), { text: "# Updated Core\n" });
  } finally { f.cleanup(); }
});

test("missing, empty or invalid local Core is rejected without a fallback", async () => {
  const f = fixture();
  try {
    writeFileSync(f.file, "");
    await assert.rejects(loadCore(f.root), CoreUnavailableError);
    writeFileSync(f.file, "\u0000");
    await assert.rejects(loadCore(f.root), CoreUnavailableError);
    rmSync(f.file);
    await assert.rejects(loadCore(f.root), CoreUnavailableError);
  } finally { f.cleanup(); }
});

test("symlinked Core is rejected", async t => {
  const f = fixture();
  try {
    const content = readFileSync(f.file);
    const outside = join(f.root, "elsewhere");
    writeFileSync(outside, content);
    rmSync(f.file);
    try { symlinkSync(outside, f.file); }
    catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Windows account cannot create symbolic links."); return;
      }
      throw error;
    }
    await assert.rejects(loadCore(f.root), /普通文件/);
  } finally { f.cleanup(); }
});

test("oversized Core is rejected", async () => {
  const f = fixture();
  try {
    writeFileSync(f.file, "a".repeat(256 * 1024 + 1));
    await assert.rejects(loadCore(f.root), /异常过大/);
  } finally { f.cleanup(); }
});
