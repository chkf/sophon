import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRuntime } from "./providers.js";

test("subscription exhaustion stays on SIWC and never calls the paid provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-usage-provider-"));
  try {
    let exhausted = true;
    let siwcCalls = 0;
    let paidCalls = 0;
    const runtime = new ProviderRuntime(dir, {
      siwc: {
        async reply() {
          siwcCalls++;
          if (exhausted) throw Object.assign(new Error("A ChatGPT sharing limit has been reached"), {
            code: "subscription_sharing_usage_limit_exceeded", status: 429, inboundRetryable: true,
          });
          return { text: "恢复成功" };
        },
        async resetSession() {},
      },
      openrouter: {
        async reply() { paidCalls++; throw new Error("paid provider must not run"); },
      },
    } as any);
    const request = { purpose: "chat" as const, sessionId: "telegram:123", operationId: "telegram:123:9",
      messages: [{ role: "user" as const, content: "原问题" }], stateful: true,
      deferAssistantCommit: true };
    await assert.rejects(runtime.reply(request), /sharing limit/);
    assert.equal(await runtime.getProvider(), "siwc");
    assert.equal(paidCalls, 0);
    exhausted = false;
    assert.equal((await runtime.reply(request)).text, "恢复成功");
    assert.equal(siwcCalls, 2);
    assert.equal(paidCalls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SIWC model A -> B -> A returns to its original isolated checkpoint generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-provider-model-checkpoint-"));
  try {
    let model = "model-a";
    const identities: string[] = [];
    let paidCalls = 0;
    const siwc = {
      async getModelSelection() { return { mode: "pinned", model, resolvedModel: model }; },
      async listModels() { return [{ id: "model-a", displayName: "A" }, { id: "model-b", displayName: "B" }]; },
      async selectModel(requested: string) { model = requested; return this.getModelSelection(); },
      async reply(turn: { sessionId: string }) { identities.push(turn.sessionId); return { text: "fixture" }; },
    };
    const runtime = new ProviderRuntime(dir, { siwc, openrouter: {
      async reply() { paidCalls++; throw new Error("unexpected paid Provider usage"); },
    } } as any);
    const request = { purpose: "chat" as const, sessionId: "telegram:owner",
      messages: [{ role: "user" as const, content: "message" }], stateful: true };
    await runtime.reply(request);
    await runtime.selectModel("model-b", "siwc");
    await runtime.reply(request);
    await runtime.selectModel("model-a", "siwc");
    await runtime.reply(request);
    assert.deepEqual(identities, ["telegram:owner", "telegram:owner:provider:siwc:1", "telegram:owner"]);
    assert.equal(paidCalls, 0);
    const restarted = new ProviderRuntime(dir, { siwc, openrouter: {
      async reply() { paidCalls++; throw new Error("unexpected paid Provider usage"); },
    } } as any);
    await restarted.reply(request);
    assert.equal(identities.at(-1), "telegram:owner", "the model-specific lane mapping must survive restart");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
