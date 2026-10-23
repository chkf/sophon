import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeartbeatRunner } from "./runner.js";
import { SessionStore } from "../sessions/store.js";
import { localContext } from "../core/context-fixture.js";
import { ActiveChannelRouter } from "../channels/active.js";
import { OpenRouterRuntime } from "../runtime/openrouter.js";
import { SiwcRuntime } from "../runtime/siwc/index.js";
import { writeJsonAtomic } from "../util/atomic-json.js";

const now = new Date("2026-10-11T02:00:00Z");
const plan = '{"wakes":[{"time":"11:00","intent":"自然聊天"}]}';
const json = (data: unknown) => new Response(JSON.stringify(data));
async function temp(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "heartbeat-contract-"));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

for (const provider of ["siwc", "openrouter"] as const) {
  test(`real ${provider} accepts daily planning input from Runner`, t => temp(async root => {
    let paid = 0;
    let modelReads = 0;
    const transport: typeof fetch = async (_url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (!body) return json(String(_url).endsWith("models") ? { data: [{
        id: "fixture/chat", architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        supported_parameters: ["tools"], context_length: 128000,
      }] } : { data: {} });
      paid++;
      const input = provider === "siwc" ? body.input : body.messages;
      assert.ok(input.some((m: any) => m.role === "user" && (typeof m.content === "string" ? m.content.trim() : m.content?.some((p: any) => p.text?.trim()))));
      return new Response(provider === "siwc"
        ? 'data: ' + JSON.stringify({ type: "response.output_text.delta", delta: plan }) + '\n\ndata: {"type":"response.completed"}\n\n'
        : 'data: ' + JSON.stringify({ choices: [{ delta: { content: plan }, finish_reason: "stop" }] }) + '\n\ndata: [DONE]\n\n');
    };
    const sdk = { async getSession() { return { status: "connected", sharing: true }; },
      async listModels() { modelReads++; return [{ slug: "fixture/chat", displayName: "fixture" }]; } };
    const encryption = { id: "fixture", isAvailable: () => true,
      encrypt: (s: string) => Buffer.from(s), decrypt: (b: Uint8Array) => Buffer.from(b).toString() };
    await writeJsonAtomic(join(root, "chatgpt-auth.json"), { version: 3, provider: "fixture", ciphertext: Buffer.from(JSON.stringify({
      version: 2, activeProfileId: "fixture", profiles: [{ id: "fixture", status: "connected", scopes: ["chatgpt.tokens.use.direct"], credentials: { accessToken: "fixture-token" } }],
    })).toString("base64") });
    t.mock.method(globalThis, "fetch", transport);
    const runtime = provider === "siwc" ? new SiwcRuntime(sdk as never, root, root, encryption)
      : new OpenRouterRuntime({ dataDir: root, apiKey: "fixture-only", defaultModel: "fixture/chat", heartbeat: true, fetch: transport });
    if (provider === "siwc") {
      // Background SIWC now uses one isolated WS lane instead of the HTTP
      // Responses transport. Keep the real SIWC input/credential routing under
      // test, while injecting only a fake WS bridge (no external provider calls).
      Object.assign(runtime, { statefulResponses: {
        async reply(request: any) {
          paid++;
          assert.equal(request.accessToken, "fixture-token");
          assert.match(request.sessionId, /^background:/);
          assert.ok(request.messages.some((m: any) => m.role === "user" && m.content.trim()));
          assert.ok(request.instructions.includes("今天剩余时间"));
          assert.equal(request.tools?.length ?? 0, 0);
          return { text: plan, usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, compacted: false };
        },
        async resetSession() {},
        async close() {},
      } });
    }
    const core = { async load() { return { available: true, data: localContext().data }; } };
    const router = new ActiveChannelRouter(root, { telegram: { channel: "telegram", async availableTarget() { return "owner"; }, async sendText() { assert.fail("planning must not send"); } } }, "telegram");
    const sessions = new SessionStore(root);
    const runner = new HeartbeatRunner(root, { enabled: true, planningEnabled: true, timezone: "Asia/Shanghai", quietStart: "01:00", quietEnd: "07:00", dailyCap: 8, cooldownMinutes: 60 } as never,
      runtime, sessions, core as never, router);
    await runner.tick(now);
    const state = JSON.parse(await readFile(join(root, "heartbeat", "state.json"), "utf8"));
    assert.equal(state.plan?.wakes[0]?.time, "11:00", "Runner must produce a valid plan through real Runtime validation");
    assert.equal(paid, 1);
    if (provider === "siwc") assert.equal(modelReads, 1, "one SDK-refreshed catalogue per reply");
    sessions.close();
    await runtime.close();
  }));
}

test("both background purposes skip OpenRouter before paid journal or transport when disabled", () => temp(async root => {
  const runtime = new OpenRouterRuntime({ dataDir: root, apiKey: "fixture-only", defaultModel: "fixture/chat", heartbeat: false,
    fetch: async () => assert.fail("disabled background work must not contact provider") });
  for (const purpose of ["heartbeat_plan", "heartbeat_decision"]) {
    const response = await runtime.reply({ sessionId: "arbitrary-generation", purpose, text: "进行后台判断。" } as never);
    assert.equal(response.text, "SILENT");
  }
}));
