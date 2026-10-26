import { seedPersonaDatabase } from "../../scripts/testing/persona-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayCommandRouter } from "./router.js";
import { ExpressionStore } from "../expression/store.js";
import { formatHostDiagnosis } from "./host-logs.js";

function message(text: string): any {
  return {
    channel: "telegram",
    conversationId: "1",
    senderId: "1",
    messageId: "1",
    text,
    receivedAt: new Date().toISOString(),
    attachments: [],
  };
}

test("local commands handle model and active channel without model chat", async () => {
  let active: "telegram" | "wechat" | "off" = "telegram";
  let selected = "gpt-a";
  const runtime = {
    async listModels() {
      return [
        { id: "gpt-a", displayName: "GPT A" },
        { id: "gpt-b", displayName: "GPT B" },
      ];
    },
    async getModelSelection() {
      return { mode: "pinned" as const, model: selected, resolvedModel: selected };
    },
    async selectModel(model?: string) {
      if (!model) return { mode: "auto" as const, resolvedModel: "gpt-a" };
      selected = model;
      return { mode: "pinned" as const, model, resolvedModel: model };
    },
  };
  const channels = {
    async getActive() { return active; },
    isConfigured(channel: string) { return channel === "telegram" || channel === "wechat"; },
    async setActive(channel: "telegram" | "wechat" | "off") { active = channel; },
  };

  const router = new GatewayCommandRouter(runtime as any, channels as any);
  const list = await router.execute(message("/model"));
  assert.match(list ?? "", /GPT B · gpt-b/);
  assert.equal(await router.execute(message("/model 2")), "已切到 gpt-b");
  assert.equal(selected, "gpt-b");

  assert.equal(await router.execute(message("/channel wechat")), "主动消息已切到 微信。");
  assert.equal(active, "wechat");
  assert.equal(await router.execute(message("/channel")), "主动消息：微信");
  assert.equal(await router.execute(message("/channel off")), "主动消息已暂停。");
  assert.equal(await router.execute(message("/usage")), "这个命令不存在。");
  for (const retired of ["/wx", "/tg", "/off", "/image", "/provider"]) {
    assert.equal(await router.execute(message(retired)), "这个命令不存在。");
  }
  assert.equal(await router.execute(message("/wat")), "这个命令不存在。");
  assert.equal(await router.execute(message("普通聊天")), undefined);
});

test("generic API status and image commands never probe or mutate OpenRouter",async()=>{
  let provider="api";
  const runtime:any={getProvider:async()=>provider,selectProvider:async(p:string)=>{provider=p;},
    getModelSelection:async()=>({mode:"pinned",model:"custom/model"}),
    providerStatus:async()=>assert.fail("API status must not probe other providers"),
    getImageSettings:async()=>assert.fail("API must not access image settings"),
    selectImageRoute:async()=>assert.fail("API must not enable an OpenRouter route")};
  const router=new GatewayCommandRouter(runtime,{} as any);
  assert.match((await router.execute(message("/model provider api")))!,/Provider：通用 API/);
  assert.equal(provider,"api");
  assert.match((await router.execute(message("/model image route openrouter")))!,/不支持生图或内置联网搜索/);
  assert.equal(provider,"api");
});


test("/logs actively diagnoses the cause and returns the five latest gateway errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-host-logs-"));
  const oldNow = Date.now; Date.now = () => Date.parse("2026-10-07T01:08:00.000Z");
  try {
    await writeFile(join(root, "gateway.log"), [
      "2026-10-07T01:00:00.000Z [gateway] ready",
      "2026-10-07T01:01:00.000Z [gateway] transient runtime error; inbound message retained for retry: network timeout",
      "2026-10-07T01:01:05.000Z [gateway] transient runtime error; inbound message retained for retry: network timeout",
      "2026-10-07T01:06:30.000Z [gateway] transient runtime error; inbound message retained for retry: network timeout",
      "2026-10-07T01:02:00.000Z [runtime] Responses WebSocket closed before response.completed.",
      "2026-10-07T01:04:00.000Z [gateway] failed TELEGRAM_BOT_TOKEN=123456:secret-token",
      "2026-10-07T01:03:00.000Z [voice] timeout contacting upstream",
      "2026-10-07T01:05:00.000Z gateway exited code=1 signal=null",
      "2026-10-07T01:06:00.000Z [telegram] connection reset Authorization: Bearer abc.def.ghi",
      "2026-10-07T01:07:00.000Z gateway healthy",
    ].join("\n") + "\n", "utf8");

    const runtime = {
      async listModels() { return []; },
      async getModelSelection() { return { mode: "auto" as const }; },
      async selectModel() { return { mode: "auto" as const }; },
    };
    const channels = {
      async getActive() { return "telegram" as const; },
      isConfigured() { return true; },
      async setActive() {},
    };

    const router = new GatewayCommandRouter(runtime as any, channels as any, async () => formatHostDiagnosis(root, {
        runtime: { status: "connected", sharing: true },
        chatgptProbeOk: false,
        chatgptProbeError: "Responses WebSocket closed before response.completed.",
        localCoreAvailable: true,
      }));

    const result = await router.execute(message("/logs"));
    assert.match(result ?? "", /诊断：ChatGPT 网络\/连接异常/);
    assert.match(result ?? "", /ChatGPT=FAIL/);
    assert.match(result ?? "", /Local Core\/SQLite=OK/);
    assert.match(result ?? "", /Telegram→Host=OK/);
    assert.doesNotMatch(result ?? "", /123456:secret-token/);
    assert.match(result ?? "", /TELEGRAM_BOT_TOKEN=\[REDACTED\]/);
    assert.doesNotMatch(result ?? "", /abc\.def\.ghi/);
    assert.match(result ?? "", /Bearer \[REDACTED\]/);
    assert.doesNotMatch(result ?? "", /gateway healthy/);
    assert.match(result ?? "", /network timeout\s+\[本时段重复 3 次\]/);

    const errorLines = (result ?? "").split("\n")
      .filter((line) => /^2026-/.test(line));
    assert.equal(errorLines.length, 5);

    assert.equal(await router.execute(message("/logs gateway")), "直接发送 /logs 就可以。");
  } finally {
    Date.now = oldNow;
    await rm(root, { recursive: true, force: true });
  }
});


test("Telegram literal npm run commands use a fixed allowlist without model calls", async () => {
  const executed: string[] = [];
  const runtime = {
    async listModels() { throw new Error("Model must not be called for host tests"); },
    async getModelSelection() { throw new Error("Model must not be called for host tests"); },
  };
  const channels = {
    async getActive() { return "telegram" as const; },
    isConfigured() { return true; },
    async setActive() {},
  };
  const router = new GatewayCommandRouter(runtime as any, channels as any, undefined, { async run(script: string) { executed.push(script); return "PASS " + script; } } as any);
  assert.match(await router.execute(message("/test")) ?? "", /npm run runtime:test/);
  assert.match(await router.execute(message("/test")) ?? "", /npm run runtime:diagnose/);
  assert.equal(await router.execute(message("/test runtime:test")), "PASS runtime:test");
  assert.equal(await router.execute(message("/test runtime:diagnose")), "PASS runtime:diagnose");
  assert.equal(await router.execute(message("npm run runtime:test")), "PASS runtime:test");
  assert.equal(await router.execute(message("npm run runtime:diagnose")), "PASS runtime:diagnose");
  assert.equal(await router.execute(message("npm run gateway:check")), "PASS gateway:check");
  assert.equal(await router.execute(message("npm run typecheck")), "PASS typecheck");
  assert.equal(await router.execute(message("npm run test")), "PASS test");
  assert.match(await router.execute(message("npm run test:bootstrap")) ?? "", /白名单测试/);
  assert.match(await router.execute(message("npm run runtime:test --allow-paid")) ?? "", /白名单测试/);
  assert.match(await router.execute(message("npm run runtime:diagnose --allow-paid")) ?? "", /白名单测试/);
  assert.match(await router.execute(message("npm run test; uname -a")) ?? "", /白名单测试/);
  assert.match(await router.execute(message("npm run update")) ?? "", /白名单测试/);
  assert.match(await router.execute(message("/test ../../package.json")) ?? "", /不支持/);
  assert.match(await router.execute({ ...message("/test runtime:test"), channel: "wechat" }) ?? "", /Telegram/);
  assert.deepEqual(executed, [
    "runtime:test", "runtime:diagnose", "runtime:test", "runtime:diagnose", "gateway:check", "typecheck", "test",
  ]);
});


test("model and channel are the only entrypoints for provider, image and active-channel settings", async () => {
  const active: string[] = [];
  const runtime = {
    async getProvider() { return "siwc" as const; },
    async providerStatus() { return [{ provider: "siwc" as const, available: true }]; },
    async selectProvider() {},
    async listModels() { return [{id:"siwc/x", displayName:"SIWC"}]; },
    async getModelSelection() { return { mode:"auto" as const, resolvedModel:"siwc/x" }; },
    async selectModel() { return { mode:"auto" as const, resolvedModel:"siwc/x" }; },
    async getImageSettings() { return { route: "provider" as const, proactive:false, dailyLimit:0 }; },
  };
  const router = new GatewayCommandRouter(runtime as any, {
    async getActive() { return "off" as const; }, isConfigured() { return true; },
    async setActive(channel: string) { active.push(channel); },
  } as any);
  assert.match(await router.execute(message("/model provider")) ?? "", /Provider：siwc/);
  assert.match(await router.execute(message("/model image")) ?? "", /生图路线/);
  assert.match(await router.execute(message("/channel telegram")) ?? "", /Telegram/);
  assert.match(await router.execute(message("/channel wechat")) ?? "", /微信/);
  assert.match(await router.execute(message("/channel off")) ?? "", /暂停/);
  assert.deepEqual(active, ["telegram", "wechat", "off"]);
  for (const removed of ["/provider siwc", "/image", "/tg", "/wx", "/off"]) {
    assert.equal(await router.execute(message(removed)), "这个命令不存在。");
  }
});
