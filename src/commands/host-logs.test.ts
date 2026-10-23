import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatHostDiagnosis, redactLogText } from "./host-logs.js";

test("standalone Gateway credential names are redacted from diagnostics",()=>{
  const raw="CUSTOM_BEARER_TOKEN=fixture-token GATEWAY_OPENROUTER_MANAGEMENT_KEY=fixture-key TOKEN=fixture-bare SECRET=fixture-secret";
  const redacted=redactLogText(raw);
  assert.doesNotMatch(redacted,/fixture-token|fixture-key|fixture-bare|fixture-secret/);
  assert.match(redacted,/CUSTOM_BEARER_TOKEN=\[REDACTED\]/);
  assert.match(redacted,/GATEWAY_OPENROUTER_MANAGEMENT_KEY=\[REDACTED\]/);
});

test("Host diagnosis reports local Core availability independently of provider connectivity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-diagnose-"));
  try {
    const common = { runtime: { status: "connected" as const, sharing: true },
      chatgptProbeOk: true, localCoreAvailable: false };
    const local = await formatHostDiagnosis(dir, common);
    assert.match(local, /本地 Core \/ SQLite 不可用/);
    assert.match(local, /Local Core\/SQLite=FAIL/);
    const healthy = await formatHostDiagnosis(dir, { ...common, localCoreAvailable:true });
    assert.match(healthy, /当前检测正常/);
    assert.match(healthy, /Local Core\/SQLite=OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
