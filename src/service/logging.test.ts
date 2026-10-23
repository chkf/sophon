import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { environmentLogSecrets, installFileLogging } from "./logging.js";
import { readLogEvents } from "../commands/host-logs.js";

function consoleFixture() {
  const output: string[] = [];
  const write = (...values: unknown[]) => { output.push(values.map(String).join(" ")); };
  const target = { log: write, info: write, warn: write, error: write, debug: write };
  return { target, output, write };
}

test("service logs redact credentials, carry readable timestamps and flush before restoring console", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-file-log-"));
  const { target, output, write } = consoleFixture();
  const secret = "fixture-private-token:/with characters";
  const logger = await installFileLogging({ directory: root, secrets: [secret], console: target });
  try {
    target.error("Request failed: %s", secret);
    target.warn({ apiKey: "unlisted secret with spaces", password: "another private value" });
    target.log("Transport failed at https://example.test/?token=" + encodeURIComponent(secret));
    target.debug("Authorization: Bearer unknown-bearer-value");
    target.info("https://user:private-password@example.test/");
    await logger.close();
    const saved = await readFile(join(root, "gateway.log"), "utf8");
    assert.doesNotMatch(saved, /fixture-private-token|unlisted secret|another private|unknown-bearer-value|private-password/);
    assert.doesNotMatch(output.join("\n"), /fixture-private-token|unlisted secret|another private|unknown-bearer-value|private-password/);
    assert.match(saved, /\[REDACTED\]/);
    assert.ok(saved.trim().split("\n").every(line => /^\d{4}-\d{2}-\d{2}T\S+ \[(?:log|info|warn|error|debug)\] /.test(line)));
    const events = await readLogEvents(root);
    assert.equal(events.length, 2);
    assert.ok(events.every(event => event.source === "gateway"));
    assert.equal(target.error, write);
    target.error("outside service lifetime");
    await logger.close();
    assert.equal(await readFile(join(root, "gateway.log"), "utf8"), saved);
  } finally { await logger.close(); await rm(root, { recursive: true, force: true }); }
});

test("log rotation bounds the active file and keeps only one previous file", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-file-log-rotate-"));
  const { target } = consoleFixture();
  const logger = await installFileLogging({ directory: root, maxBytes: 1024, console: target });
  try {
    for (let index = 0; index < 20; index++) target.error("failure " + index + ": " + "x".repeat(180));
    target.error("oversized failure: " + "y".repeat(4000));
    await logger.close();
    assert.deepEqual((await readdir(root)).sort(), ["gateway.log", "gateway.log.1"]);
    for (const file of ["gateway.log", "gateway.log.1"]) assert.ok((await stat(join(root, file))).size <= 1024);
    assert.match(await readFile(join(root, "gateway.log"), "utf8"), /entry truncated/);
  } finally { await logger.close(); await rm(root, { recursive: true, force: true }); }
});

test("disabled logging leaves console and filesystem untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-file-log-disabled-"));
  const { target, write } = consoleFixture();
  try {
    const path = join(root, "not-created");
    const logger = await installFileLogging({ directory: path, enabled: false, console: target });
    target.error("normal console output");
    await logger.close();
    assert.equal(target.error, write);
    await assert.rejects(stat(path), { code: "ENOENT" });
    assert.deepEqual(environmentLogSecrets({
      GATEWAY_API_KEY: "fixture-api", OPENROUTER_API_KEY: "fixture-router",
      TELEGRAM_BOT_TOKEN: "fixture-bot", GATEWAY_TIMEZONE: "UTC",
    }), ["fixture-api", "fixture-router", "fixture-bot"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
