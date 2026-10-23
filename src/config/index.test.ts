import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, validateServeConfig } from "./index.js";
import { rm } from "node:fs/promises";
import { createTestSandbox } from "../../scripts/testing/environment.mjs";

async function isolatedConfig(run: () => void) {
  const sandbox = await createTestSandbox(), savedEnv = process.env, savedCwd = process.cwd();
  try { process.env = sandbox.env; process.chdir(sandbox.root); run(); }
  finally { process.chdir(savedCwd); process.env = savedEnv; await rm(sandbox.root, { recursive: true, force: true }); }
}

test("generic API is the default and has no vendor endpoint or credentials", () => isolatedConfig(() => {
  const config = loadConfig();
  assert.equal(config.provider, "api");
  assert.deepEqual(config.api, {
    baseUrl: undefined, apiKey: undefined, defaultModel: undefined,
    contextWindow: 32768, vision: false, heartbeat: false, stream: true,
  });
  process.env.GATEWAY_API_BASE_URL = "http://127.0.0.1:8080/v1/";
  process.env.GATEWAY_API_MODEL = "local-tool-model";
  process.env.GATEWAY_API_STREAM = "false";
  process.env.GATEWAY_API_CONTEXT_WINDOW = "16384";
  const local = loadConfig().api!;
  assert.equal(local.baseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(local.defaultModel, "local-tool-model");
  assert.equal(local.apiKey, undefined);
  assert.equal(local.stream, false);
  assert.equal(local.contextWindow, 16384);
  process.env.GATEWAY_LOG_DIR = "./custom-logs";
  const standalone = loadConfig();
  assert.ok(standalone.logDir?.endsWith("custom-logs"));
}));

test("API configuration rejects unsafe URL fields without disclosing their values", () => isolatedConfig(() => {
  for (const url of ["not-a-url", "file:///tmp/model", "https://user:private-value@api.example/v1", "https://api.example/v1?key=private-value", "https://api.example/v1#private-value", "https://api.example/v1/chat/completions"]) {
    process.env.GATEWAY_API_BASE_URL = url;
    assert.throws(loadConfig, error => error instanceof Error && /GATEWAY_API_BASE_URL/.test(error.message) && !error.message.includes("private-value"));
  }
  process.env.GATEWAY_API_BASE_URL = "https://api.example/custom/v1";
  process.env.GATEWAY_API_CONTEXT_WINDOW = "4096";
  assert.throws(loadConfig, /GATEWAY_API_CONTEXT_WINDOW/);
  delete process.env.GATEWAY_API_CONTEXT_WINDOW;
  for (const provider of ["api", "openrouter", "siwc"]) {
    process.env.GATEWAY_PROVIDER = provider;
    assert.equal(loadConfig().provider, provider);
  }
  process.env.GATEWAY_PROVIDER = "unknown";
  assert.throws(loadConfig, /must be api, siwc or openrouter/);
}));

test("retired Official Account settings fail clearly; owner-managed iLink is the WeChat route", () => isolatedConfig(() => {
  const names = ["WECHAT_TOKEN", "WECHAT_APP_ID", "WECHAT_APP_SECRET", "WECHAT_OWNER_OPENID", "TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_ID", "GATEWAY_ILINK_ENABLED", "GATEWAY_HEARTBEAT_CHANNEL"];
  const saved = names.map(name => process.env[name]);
  try {
    for (const name of names) delete process.env[name];
    for (const name of names.slice(0, 4)) {
      process.env[name] = "fixture-private-value";
      assert.throws(loadConfig, error => error instanceof Error && /旧微信公众号接入已移除/.test(error.message) && !error.message.includes("fixture-private-value"));
      delete process.env[name];
    }
    process.env.GATEWAY_ILINK_ENABLED = "true";
    assert.throws(() => validateServeConfig(loadConfig()), /Telegram/);
    process.env.TELEGRAM_BOT_TOKEN = "fixture-token";
    process.env.TELEGRAM_OWNER_ID = "123";
    process.env.GATEWAY_HEARTBEAT_CHANNEL = "wechat";
    process.env.GATEWAY_HEARTBEAT_ENABLED = "true";
    const config = loadConfig();
    assert.equal(config.ilink?.enabled, true);
    assert.equal("wechat" in config, false);
    assert.doesNotThrow(() => validateServeConfig(config));
    process.env.GATEWAY_ILINK_ENABLED = "false";
    assert.throws(() => validateServeConfig(loadConfig()), /iLink/);
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  }
}));

test("proactive defaults adopt quiet 01:00–07:00, 60-minute cooldown and 8 attempts while respecting overrides", () => isolatedConfig(() => {
  const names = [
    "GATEWAY_TIMEZONE",
    "GATEWAY_QUIET_START",
    "GATEWAY_QUIET_END",
    "GATEWAY_HEARTBEAT_COOLDOWN_MINUTES",
    "GATEWAY_HEARTBEAT_DAILY_CAP",
    "GATEWAY_HEARTBEAT_DAILY_PLANNING",
  ] as const;
  const saved = names.map(name => process.env[name]);
  try {
    for (const name of names) delete process.env[name];

    const defaults = loadConfig().heartbeat;
    assert.equal(defaults.timezone, "UTC");
    assert.equal(defaults.quietStart, "01:00");
    assert.equal(defaults.quietEnd, "07:00");
    assert.equal(defaults.cooldownMinutes, 60);
    assert.equal(defaults.dailyCap, 8);
    assert.equal(defaults.planningEnabled, false);

    process.env.GATEWAY_QUIET_START = "02:00";
    process.env.GATEWAY_QUIET_END = "09:00";
    process.env.GATEWAY_HEARTBEAT_COOLDOWN_MINUTES = "90";
    process.env.GATEWAY_HEARTBEAT_DAILY_CAP = "3";
    const override = loadConfig().heartbeat;
    assert.equal(override.quietStart, "02:00");
    assert.equal(override.quietEnd, "09:00");
    assert.equal(override.cooldownMinutes, 90);
    assert.equal(override.dailyCap, 3);
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  }
}));
