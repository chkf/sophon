import assert from "node:assert/strict";
import test from "node:test";
import { requestMessages } from "./request.js";
import { OpenRouterRuntime } from "./openrouter.js";
import { SiwcRuntime } from "./siwc/index.js";

test("invalid request input and purpose fail before SDK, network or paid operations", async () => {
  const runtime = new OpenRouterRuntime({ dataDir: "unused", fetch: async () => assert.fail("network") });
  const siwc = new SiwcRuntime({ async getSession() { assert.fail("SDK"); } } as never, "unused", "unused", {} as never);
  for (const input of [{}, { text: "  " }, { messages: [] }, { messages: [{ role: "user", content: "" }] }, { purpose: "unknown", text: "ok" }]) {
    const request = { purpose: "chat", sessionId: "any", ...input } as never;
    await assert.rejects(runtime.reply(request));
    await assert.rejects(siwc.reply(request));
  }
  assert.equal(requestMessages({ purpose: "chat", sessionId: "any", text: "你好" })[0]?.content, "你好");
});
