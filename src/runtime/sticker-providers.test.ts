import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiRuntime } from "./api.js";
import { OpenRouterRuntime } from "./openrouter.js";
import { Gateway } from "../gateway.js";
import { initializeGateway } from "../setup.js";
import { SessionStore } from "../sessions/store.js";
import { LocalCoreContextProvider } from "../core/context.js";
import { StatefulResponsesBridge } from "./siwc/stateful-responses.js";
import type { StatefulResponsesSocket, SocketStreamMessage } from "./siwc/stateful-types.js";
import type { TelegramSticker, InboundMessage } from "../channels/types.js";
import type { ChatRequest } from "./types.js";

const sticker: TelegramSticker = { fileId: "fixture_document_icon", accountId: "telegram-bot:70002", chatId: "70001", format: "static" };
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sticker-provider-"));
  try { await initializeGateway(join(root, "data")); await run(join(root, "data")); } finally { await rm(root, { recursive: true, force: true }); }
}
for (const provider of ["api", "openrouter"] as const) test(`${provider} persists a sticker-only reply and replays it without another request`, () => fixture(async root => {
  let calls = 0;
  const fetcher: typeof fetch = async input => {
    if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "fixture-model", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["tools"], context_length: 32000 }] }));
    calls++;
    if (provider === "openrouter") return new Response("data: " + JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] })); };
  const runtime = provider === "api"
    ? new ApiRuntime({ dataDir: root, baseUrl: "https://api.example/v1", defaultModel: "fixture-model", stream: false, fetch: fetcher })
    : new OpenRouterRuntime({ dataDir: root, apiKey: "fixture-key", defaultModel: "fixture-model", fetch: fetcher });
  const request: ChatRequest = { purpose: "chat", sessionId: "fixture-session", operationId: "fixture-operation", text: "发送文档图标", getPreparedSticker: () => sticker };
  try {
    assert.deepEqual((await runtime.reply(request)).sticker, sticker);
    assert.deepEqual((await runtime.reply({ ...request, getPreparedSticker: undefined })).sticker, sticker);
    assert.equal(calls, 1);
  } finally { await runtime.close(); }
}));
test("Gateway advertises sticker selection and returns its verified metadata with an empty text response", () => fixture(async root => {
  const sessions = new SessionStore(root);
  const runtime = { async reply(request: ChatRequest) {
    assert.ok(request.tools!.some(tool => tool.name === "gateway_sticker"));
    const result = await request.executeTool!("gateway_sticker", { action: "list" }) as { stickers: { key: string }[] };
    await request.executeTool!("gateway_sticker", { action: "select", key: result.stickers[0]!.key });
    assert.deepEqual(request.getPreparedSticker!(), sticker);
    return { text: "" };
  } };
  const gateway = new Gateway(runtime, sessions, new LocalCoreContextProvider(root));
  const inbound: InboundMessage = { channel: "telegram", conversationId: "70001", senderId: "70001", messageId: "1", receivedAt: "2030-01-01T00:00:00Z", text: "发送文档图标", attachments: [],
    platformMessages: [{ accountId: sticker.accountId, conversationId: "70001", direction: "inbound", messageId: "1", text: "", attachments: [{ kind: "image", sticker }] }] };
  const result = await gateway.handle(inbound);
  assert.equal(result.kind, "model_reply");
  if (result.kind === "model_reply") { assert.equal(result.text, ""); assert.deepEqual(result.sticker, sticker); }
}));
test("SIWC accepts a sticker-only result without requiring visible text", () => fixture(async root => {
  let requests = 0;
  const socket: StatefulResponsesSocket = { send() { requests++; }, async *stream(): AsyncIterable<SocketStreamMessage> {
    yield { type: "message", message: { type: "response.completed", response: { id: "fixture-response", output: [] } } };
  }, close() {}, onClose() {} };
  const bridge = new StatefulResponsesBridge(root, () => socket);
  try {
    const result = await bridge.reply({ accessToken: "fixture-token", model: "fixture-model", sessionId: "fixture-sticker-session", messages: [{ role: "user", content: "发送文档图标" }], getPreparedSticker: () => sticker });
    assert.deepEqual(result.sticker, sticker); assert.equal(result.text, ""); assert.equal(requests, 1);
  } finally { await bridge.close(); }
}));
