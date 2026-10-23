import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SiwcRuntime } from "./index.js";
import type { SiwcClient, CredentialEncryptionAdapter } from "./sdk.js";
import { inboundManualRetryHint, inboundRetryAfterMs, tagInboundRetryability } from "../retry-policy.js";

for (const failure of ["login", "model_list", "empty_models", "credentials", "network", "quota"] as const) {
  test("SIWC preserves pre-model failure for manual retry: " + failure, async () => {
    const root = await mkdtemp(join(tmpdir(), "siwc-prepare-retry-"));
    const storage = join(root, "chatgpt");
    let broken = true;
    let modelCalls = 0;
    const encryption: CredentialEncryptionAdapter = {
      id: "test", isAvailable: () => true,
      encrypt: text => Buffer.from(text), decrypt: bytes => Buffer.from(bytes).toString("utf8"),
    };
    const client: SiwcClient = {
      signIn: async () => ({ status: "connected", sharing: true }),
      getSession: async () => {
        if (broken && failure === "login") throw Object.assign(new Error("expired login"), { code: "invalid_grant" });
        return { status: "connected", sharing: true };
      },
      listModels: async () => {
        if (broken) {
          if (failure === "model_list") throw new Error("model discovery failed");
          if (failure === "network") throw new Error("fetch failed");
          if (failure === "quota") throw Object.assign(new Error("sharing limit"), { code: "subscription_sharing_usage_limit_exceeded" });
          if (failure === "empty_models") return [];
        }
        return [{ slug: "test-model", displayName: "Test Model" }];
      },
      streamResponse: async () => assert.fail("formal chat must use the stateful bridge"),
    };
    const runtime = new SiwcRuntime(client, storage, root, encryption);
    const unsafe = tagInboundRetryability(new Error("failure after write"), false, false);
    Object.assign(runtime, { statefulResponses: {
      reply: async () => {
        modelCalls++;
        if (modelCalls > 1) throw unsafe;
        return { text: "恢复成功", compacted: false };
      },
      close: async () => {},
    } });
    const request = { sessionId: "telegram:123", purpose: "chat" as const, stateful: true, text: "原问题" };
    try {
      await assert.rejects(runtime.reply(request), error => {
        assert.equal(inboundManualRetryHint(error), true);
        assert.equal(inboundRetryAfterMs(error), failure === "network" ? 5_000 : undefined);
        return true;
      });
      assert.equal(modelCalls, 0);
      broken = false;
      await mkdir(storage, { recursive: true });
      await writeFile(join(storage, "chatgpt-auth.json"), JSON.stringify({
        version: 3, provider: "test", ciphertext: Buffer.from(JSON.stringify({
          version: 2, activeProfileId: "fixture", profiles: [{
            id: "fixture", status: "connected", scopes: ["chatgpt.tokens.use.direct"],
            credentials: { accessToken: "fixture-token", expiresAt: Date.now() + 3_600_000 },
          }],
        })).toString("base64"),
      }));
      assert.equal((await runtime.reply(request)).text, "恢复成功");
      await assert.rejects(runtime.reply(request), error => {
        assert.equal(error, unsafe);
        assert.equal(inboundManualRetryHint(error), false, "preflight tagging must not override unsafe tool evidence");
        return true;
      });
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  });
}
