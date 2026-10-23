import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { cleanTestEnvironment, createTestSandbox } from "./environment.mjs";

test("test workers discard inherited application, API and preload configuration", () => {
  const source = { PATH: "/fixture/bin", SystemRoot: "C:\\Windows", LANG: "C.UTF-8", LC_ALL: "C", TMPDIR: "/fixture/tmp",
    GATEWAY_API_BASE_URL: "https://external.example/v1", GATEWAY_DATA_DIR: "/unrelated/state", GATEWAY_API_KEY: "synthetic-key",
    GATEWAY_API_MODEL: "external-model", TELEGRAM_BOT_TOKEN: "synthetic-token",
    OPENROUTER_API_KEY: "synthetic-key", DASHSCOPE_API_KEY: "synthetic-key", NODE_OPTIONS: "--import=/unrelated/preload.mjs" };
  const env = cleanTestEnvironment(source);
  assert.deepEqual(env, { PATH: source.PATH, SystemRoot: source.SystemRoot, LANG: source.LANG, LC_ALL: source.LC_ALL,
    TMPDIR: source.TMPDIR });
  assert.equal(source.GATEWAY_API_KEY, "synthetic-key", "caller environment remains unchanged");
});

test("real config and storage use an empty cwd and cannot open inherited synthetic external state", async () => {
  const base = await mkdtemp(join(tmpdir(), "gateway-env-canary-"));
  let sandbox;
  try {
    const external = join(base, "external-service"), data = join(external, "data"), database = join(data, "sessions/gateway.sqlite");
    await mkdir(join(data, "sessions"), { recursive: true });
    const invalidDb = "SYNTHETIC STATE THAT MUST NEVER BE OPENED AS SQLITE";
    await writeFile(database, invalidDb);
    const config = "WECHAT_TOKEN=synthetic-env-canary\nGATEWAY_DATA_DIR=" + data + "\n";
    await writeFile(join(external, ".env"), config);
    const preload = join(base, "external-preload.mjs"), loaded = join(base, "preload-was-executed");
    await writeFile(preload, "import {writeFileSync} from 'node:fs'; writeFileSync(" + JSON.stringify(loaded) + ",'canary'); throw Error('external preload executed');");
    sandbox = await createTestSandbox({ ...process.env, GATEWAY_DATA_DIR: data, GATEWAY_API_KEY: "synthetic-key",
      GATEWAY_API_BASE_URL: "https://external.example/v1", TELEGRAM_BOT_TOKEN: "synthetic-token",
      TELEGRAM_OWNER_ID: "123", DASHSCOPE_API_KEY: "synthetic-key", NODE_OPTIONS: "--import=" + pathToFileURL(preload).href });
    const script = `
      import assert from 'node:assert/strict';
      import { loadConfig } from ${JSON.stringify(new URL("../../src/config/index.ts", import.meta.url).href)};
      import { SessionStore } from ${JSON.stringify(new URL("../../src/sessions/store.ts", import.meta.url).href)};
      const config = loadConfig();
      assert.equal(config.dataDir, process.env.GATEWAY_DATA_DIR);
      assert.equal(config.telegram, undefined);
      assert.equal(config.voice.apiKey, undefined);
      assert.equal(config.api.apiKey, undefined);
      assert.equal(config.api.baseUrl, undefined);
      assert.equal(process.env.NODE_OPTIONS, undefined);
      const store = new SessionStore(config.dataDir);
      try { await store.prepare(); } finally { store.close(); }
      console.log('isolated-config-and-storage');
    `;
    const result = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script],
      { cwd: sandbox.root, env: sandbox.env, timeout: 20_000 });
    assert.equal(result.stdout.trim(), "isolated-config-and-storage");
    assert.equal(await readFile(database, "utf8"), invalidDb);
    assert.equal(existsSync(loaded), false);
    assert.equal(existsSync(join(sandbox.root, "data/sessions/gateway.sqlite")), true);
  } finally {
    if (sandbox) await rm(sandbox.root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
});
