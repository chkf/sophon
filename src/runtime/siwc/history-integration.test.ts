import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../sessions/store.js";
import { SiwcRuntime } from "./index.js";

test("real SIWC direct runtime registers and executes original history without unrelated tool writes", async t => {
  const directory = await mkdtemp(join(tmpdir(), "siwc-history-runtime-"));
  let runtime: SiwcRuntime | undefined;
  const sessions = new SessionStore(directory);
  try {
    const encryption = { id: "fixture", isAvailable: () => true, encrypt: (s: string) => Buffer.from(s), decrypt: (b: Uint8Array) => Buffer.from(b).toString() };
    await writeFile(join(directory, "chatgpt-auth.json"), JSON.stringify({ version: 3, provider: "fixture", ciphertext: Buffer.from(JSON.stringify({ version: 2,
      activeProfileId: "fixture", profiles: [{ id: "fixture", status: "connected", scopes: ["chatgpt.tokens.use.direct"], credentials: { accessToken: "fixture-token" } }],
    })).toString("base64") }));
    const sdk = { async getSession() { return { status: "connected", sharing: true }; }, async listModels() { return [{ slug: "fixture/chat", displayName: "fixture" }]; },
      async streamResponse() { assert.fail("history-capable turn must use Responses tools"); } };
    runtime = new SiwcRuntime(sdk as never, directory, directory, encryption);
    await sessions.append("telegram", "owner", "owner", [{ role: "user", content: "历史约定", at: "2026-10-10T12:00:00Z" }]);
    const requests: any[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); requests.push(body);
      const events = requests.length === 1 ? [
        { type: "response.output_item.done", item: { type: "function_call", name: "gateway_read_history", namespace: "gateway", call_id: "read", arguments: '{"query":"约定"}' } },
        { type: "response.completed" },
      ] : [{ type: "response.output_text.delta", delta: "查到了" }, { type: "response.completed" }];
      return new Response(events.map(event => "data: " + JSON.stringify(event) + "\n\n").join(""));
    });
    const reply = await runtime.reply({ purpose: "chat", sessionId: "telegram:owner", text: "检查原话", history: (await sessions.view("telegram", "owner")).history,
      async executeTool() { assert.fail("local original lookup must not call an unrelated tool"); } });
    assert.equal(reply.text, "查到了"); assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[0].tools), /gateway_read_history/);
    assert.match(JSON.stringify(requests[1].input), /历史约定/); assert.match(JSON.stringify(requests[1].input), /2026-10-10T12:00:00Z/);
  } finally { await runtime?.close(); sessions.close(); await rm(directory, { recursive: true, force: true }); }
});
