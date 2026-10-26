import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiRuntime, ApiError, type ApiConfig } from "./api.js";
import { ProviderRuntime } from "./providers.js";
import { historyFromMessages } from "./history.js";
import { runtimeFailureReply, runtimeFailureRetryAfterMs } from "./failure-message.js";
import { writeJsonAtomic } from "../util/atomic-json.js";
import type { ChatRequest, ManagedChatRuntime } from "./types.js";

const model = "local/manual-model";
const request = (id = "turn"): ChatRequest => ({ purpose: "chat", sessionId: "shared", operationId: id, text: "你好" });
const json = (content: string, toolCalls?: unknown[]) => new Response(JSON.stringify({
  choices: [{ finish_reason: toolCalls ? "tool_calls" : "stop", message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
}), { headers: { "content-type": "application/json" } });
const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const streamText = (text: string, reason = "stop", done = true) => "data: " + JSON.stringify({ choices: [{ delta: { role: "assistant", content: text }, finish_reason: null }] }) +
  "\n\ndata: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] }) + "\n\n" + (done ? "data: [DONE]\n\n" : "");
const sse = (text: string, reason = "stop", done = true) => new Response(streamText(text, reason, done), { headers: { "content-type": "text/event-stream" } });

async function temp(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "gateway-api-"));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function fixture(root: string, replies: Array<Response | Error>, options: ApiConfig = {}) {
  const sent: Array<{ url: string; init: RequestInit; body: any }> = [];
  const runtime = new ApiRuntime({ dataDir: root, baseUrl: "https://endpoint.example/custom/v1/", defaultModel: model, stream: false, ...options,
    fetch: async (url, init) => {
      sent.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
      const next = replies.shift();
      if (!next) throw new Error("Unexpected request");
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { runtime, sent };
}

test("API uses a keyless local endpoint and manually selected model with real chunked SSE and no discovery", () => temp(async root => {
  const received: Array<{ url: string; authorization?: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({ url: req.url!, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const body = Buffer.from(streamText("本地接口连接成功"));
    // Split inside UTF-8 characters and SSE fields, as real transports can do.
    for (let index = 0; index < body.length; index += 7) res.write(body.subarray(index, index + 7));
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const runtime = new ApiRuntime({ dataDir: root, baseUrl: `http://127.0.0.1:${port}/gateway/v1/` });
  try {
    assert.equal((await runtime.getSession()).status, "disconnected");
    assert.deepEqual(await runtime.listModels(), []);
    await runtime.selectModel(model);
    assert.equal((await runtime.getSession()).status, "connected");
    assert.match((await runtime.getSession()).profileLabel!, /已配置/);
    assert.deepEqual(await runtime.listModels(), [{ id: model, displayName: model }]);
    assert.equal(received.length, 0, "readiness and selection never probe paid/account/catalogue endpoints");
    assert.equal((await runtime.reply(request())).text, "本地接口连接成功");
    assert.equal(received.length, 1);
    assert.equal(received[0]!.url, "/gateway/v1/chat/completions");
    assert.equal(received[0]!.authorization, undefined);
    assert.equal(received[0]!.body.model, model);
    assert.equal(received[0]!.body.stream, true);
    assert.equal(received[0]!.body.provider, undefined);
    assert.equal(received[0]!.body.tools, undefined);
    assert.equal(received[0]!.body.messages.at(-1).content, "你好");
  } finally {
    await runtime.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}));

test("JSON mode honors a custom URL and optional key without OpenRouter extensions or silent image routing", () => temp(async root => {
  const { runtime, sent } = fixture(root, [json("回复")], { apiKey: "fixture-key", ...({ webSearch: true, imageModel: "unwanted/image" } as any) });
  const result = await runtime.reply({ ...request(), allowImageGeneration: true, imageOutputAllowed: true });
  assert.match(result.text, /通用 API/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, "https://endpoint.example/custom/v1/chat/completions");
  assert.equal(new Headers(sent[0]!.init.headers).get("authorization"), "Bearer fixture-key");
  assert.equal(sent[0]!.init.redirect, "error", "never forward credentials to another endpoint");
  assert.equal(sent[0]!.body.stream, false);
  assert.equal(sent[0]!.body.stream_options, undefined);
  assert.equal(sent[0]!.body.provider, undefined);
  assert.equal(sent[0]!.body.tools, undefined);
  assert.equal(result.usage?.totalTokens, 13);
  assert.deepEqual(await runtime.getImageSettings(), { route: "provider", proactive: false, dailyLimit: 0 });
  assert.equal(await runtime.canGenerateImage(true), false);
  assert.equal((await runtime.getUsage()).supported, false);
  await assert.rejects(runtime.generateImage({ operationId: "image", prompt: "test", autonomous: false }), /不支持内建生图/);
  await assert.rejects(runtime.selectImageModel("anything"), /不支持内建生图/);
  await assert.rejects(runtime.selectImageRoute("openrouter"), /不支持内建生图/);
  await assert.rejects(runtime.setProactiveImages(true), /不支持内建生图/);
  assert.equal(sent.length, 1);
}));

test("API shares bounded history and local tool execution, then replays its completed journal without another request", () => temp(async root => {
  const { runtime, sent } = fixture(root, [json("", [call("history", "gateway_read_history", { index: 0 }), call("save", "fixture_save", { value: "recorded" })]), json("已完成")]);
  let writes = 0;
  const turn: ChatRequest = { ...request("tools"), history: historyFromMessages([{ role: "user", content: "一段可检索的历史" }]),
    tools: [{ name: "fixture_save", parameters: { type: "object", properties: { value: { type: "string" } } } }],
    executeTool: async (name, args) => { assert.equal(name, "fixture_save"); assert.deepEqual(args, { value: "recorded" }); writes++; return { saved: true }; },
  };
  assert.equal((await runtime.reply(turn)).text, "已完成");
  assert.equal(writes, 1);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0]!.body.tools.map((tool: any) => tool.type), ["function", "function"]);
  const outputs = sent[1]!.body.messages.filter((message: any) => message.role === "tool");
  assert.match(outputs[0].content, /一段可检索的历史/);
  assert.equal(JSON.parse(outputs[1].content).saved, true);
  assert.equal(sent[1]!.body.messages.find((message: any) => message.role === "assistant").tool_calls.length, 2);
  const restarted = fixture(root, []);
  assert.equal((await restarted.runtime.reply(turn)).text, "已完成");
  assert.equal(writes, 1);
  assert.equal(restarted.sent.length, 0);
  const hash = createHash("sha256").update("tools").digest("hex");
  assert.equal(JSON.parse(await readFile(join(root, "runtime", "api-turns", hash + ".json"), "utf8")).status, "completed");
}));

test("streamed function arguments are assembled before executing a local tool", () => temp(async root => {
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "local", type: "function", function: { name: "fixture_save", arguments: '{"value":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ready"}' } }] }, finish_reason: "tool_calls" }] },
  ];
  const first = new Response(chunks.map(chunk => "data: " + JSON.stringify(chunk) + "\n\n").join("") + "data: [DONE]\n\n");
  const { runtime, sent } = fixture(root, [first, sse("完成")], { stream: true });
  let writes = 0;
  const response = await runtime.reply({ ...request("stream-tool"), tools: [{ name: "fixture_save", parameters: { type: "object" } }],
    executeTool: async (name, args) => { writes++; assert.equal(name, "fixture_save"); assert.deepEqual(args, { value: "ready" }); return { saved: true }; },
  });
  assert.equal(response.text, "完成");
  assert.equal(writes, 1);
  assert.equal(sent.length, 2);
}));

for (const [label, reply, stream] of [
  ["unauthorized", new Response("raw-sensitive-upstream-content", { status: 401 }), false],
  ["rate limited", new Response("raw-sensitive-upstream-content", { status: 429 }), false],
  ["server failure", new Response("raw-sensitive-upstream-content", { status: 500 }), false],
  ["unknown network outcome", new Error("raw-sensitive-upstream-content"), false],
  ["truncated JSON response", new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "partial" } }] })), false],
  ["truncated stream", sse("partial", "stop", false), true],
  ["filtered stream", sse("partial", "content_filter"), true],
] as const) {
  test(`API ${label} is safe and never retried, including after reopening`, () => temp(async root => {
    const { runtime, sent } = fixture(root, [reply], { stream });
    let caught: unknown;
    try { await runtime.reply(request()); } catch (error) { caught = error; }
    assert.ok(caught instanceof ApiError);
    assert.equal(caught.code, "api_no_retry");
    assert.equal(runtimeFailureRetryAfterMs(caught), undefined);
    assert.equal(runtimeFailureReply(caught), caught.message);
    assert.doesNotMatch(caught.message, /raw-sensitive-upstream-content|OpenRouter|endpoint\.example/);
    assert.equal(sent.length, 1);
    await assert.rejects(runtime.reply(request()), ApiError);
    assert.equal(sent.length, 1);
    const reopened = fixture(root, []);
    await assert.rejects(reopened.runtime.reply(request()), ApiError);
    assert.equal(reopened.sent.length, 0);
  }));
}

test("a process interruption after reserving an API operation blocks reissuing its possibly billed request", () => temp(async root => {
  const hash = createHash("sha256").update("interrupted").digest("hex");
  await writeJsonAtomic(join(root, "runtime", "api-turns", hash + ".json"), { status: "started" });
  const { runtime, sent } = fixture(root, []);
  await assert.rejects(runtime.reply(request("interrupted")), /结果不确定/);
  assert.equal(sent.length, 0);
}));

test("unconfigured or invalid API settings stay disconnected and never probe another provider", () => temp(async root => {
  for (const options of [
    { baseUrl: undefined }, { defaultModel: undefined }, { defaultModel: "bad model" }, { contextWindow: 2048 },
    { baseUrl: "file:///private/path" }, { baseUrl: "https://user:pass@example.test/v1" },
    { baseUrl: "https://example.test/v1?key=private" }, { baseUrl: "https://example.test/v1#private" },
    { baseUrl: "https://example.test/v1/chat/completions" },
  ]) {
    const { runtime, sent } = fixture(root, [], options);
    assert.equal((await runtime.getSession()).status, "disconnected");
    await assert.rejects(runtime.reply(request(JSON.stringify(options))), ApiError);
    assert.equal(sent.length, 0);
  }
}));

test("API background work is opt-in and an enabled request uses only its configured endpoint", () => temp(async root => {
  const disabled = fixture(root, []);
  assert.equal((await disabled.runtime.reply({ ...request(), purpose: "heartbeat_decision" })).skipped, "background_disabled");
  assert.equal(disabled.sent.length, 0);
  const enabled = fixture(root, [json("SILENT")], { heartbeat: true });
  assert.equal((await enabled.runtime.reply({ ...request(), purpose: "heartbeat_decision" })).text, "SILENT");
  assert.equal(enabled.sent.length, 1);
}));

test("vision must be enabled explicitly and sends standard image_url parts without vendor metadata", () => temp(async root => {
  const path = join(root, "sample.png");
  await writeFile(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHh0AAAAASUVORK5CYII=", "base64"));
  const turn: ChatRequest = { ...request(), attachments: [{ kind: "image", path, mimeType: "image/png" }] };
  const disabled = fixture(root, []);
  await assert.rejects(disabled.runtime.reply(turn), /不支持图片输入/);
  assert.equal(disabled.sent.length, 0);
  const enabled = fixture(root, [json("图片")], { vision: true });
  assert.equal((await enabled.runtime.reply(turn)).text, "图片");
  const content = enabled.sent[0]!.body.messages.at(-1).content;
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image_url");
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
}));

test("unadvertised tools fail closed and local failures never leak raw errors or execute another provider", () => temp(async root => {
  const { runtime, sent } = fixture(root, [json("", [call("unknown", "unknown_tool", {}), call("local", "fixture_save", {})]), json("未完成")]);
  let executions = 0;
  await runtime.reply({ ...request(), tools: [{ name: "fixture_save", parameters: { type: "object" } }],
    executeTool: async name => { executions++; assert.equal(name, "fixture_save"); throw new Error("raw-private-error"); },
  });
  assert.equal(executions, 1);
  const outputs = sent[1]!.body.messages.filter((message: any) => message.role === "tool");
  assert.equal(outputs.length, 2);
  for (const output of outputs) { assert.equal(JSON.parse(output.content).success, false); assert.doesNotMatch(output.content, /raw-private-error/); }
}));

test("API routing preserves shared delivery settlement and diagnostics without consulting OpenRouter", () => temp(async root => {
  const { runtime: api, sent } = fixture(root, [json("交付回复"), json("诊断成功")]);
  const unused = { getSession: async () => { throw new Error("Other provider must not be contacted"); } } as ManagedChatRuntime;
  const providers = new ProviderRuntime(root, { siwc: unused, openrouter: unused, api }, "api");
  assert.equal(await providers.getProvider(), "api");
  assert.equal((await providers.getSession()).status, "connected");
  assert.deepEqual(await providers.diagnosticModels("api"), [{ id: model, displayName: model }]);
  assert.equal((await providers.getUsage()).supported, false);
  assert.equal((await providers.getImageSettings()).proactive, false);
  await assert.rejects(providers.selectImageModel("image"), /不支持内建生图/);
  await assert.rejects(providers.selectImageRoute("openrouter"), /不支持内建生图/);
  await assert.rejects(providers.setProactiveImages(true), /不支持内建生图/);
  assert.equal(sent.length, 0);
  const response = await providers.reply({ ...request(), deferAssistantCommit: true });
  let recorded = 0;
  assert.ok(response.deliveryId);
  assert.equal(await providers.settleSessionDelivery("shared", response.deliveryId!, response.text, async () => { recorded++; }, { durableReceipt: true }), true);
  assert.equal(recorded, 1);
  assert.equal(await providers.settleSessionDelivery("shared", response.deliveryId!, response.text, async () => { recorded++; }), false);
  assert.equal(recorded, 1);
  assert.match(await providers.diagnosticReply("api", "another/manual-model", "text"), /诊断成功/);
  assert.equal(sent[1]!.body.model, "another/manual-model");
  assert.equal((await providers.getModelSelection()).resolvedModel, model, "diagnostics do not change persistent selection");
  await assert.rejects(providers.diagnosticReply("api", model, "image"), /仅支持 OpenRouter/);
  assert.equal(sent.length, 2);
}));

test("ephemeral API spending gates cancel before transport and keep provider selection unchanged", () => temp(async root => {
  const { runtime: api, sent } = fixture(root, [json("临时回复")]);
  const unused = { getSession: async () => ({ status: "connected", sharing: true }) } as ManagedChatRuntime;
  const providers = new ProviderRuntime(root, { siwc: unused, openrouter: unused, api }, "siwc");
  assert.deepEqual(await providers.validateTestModel(model, "api"), { model, supportsTools: true });
  const turn: ChatRequest = { ...request(), ephemeral: true, testProvider: "api", testModel: model, testHistoryTokens: 2048 };
  await assert.rejects(providers.reply({ ...turn, testAuthorized: () => false }), /取消/);
  assert.equal(sent.length, 0);
  assert.equal((await providers.reply(turn)).text, "临时回复");
  assert.equal(await providers.getProvider(), "siwc");
  assert.equal(sent[0]!.body.tools, undefined);
  assert.equal(sent.length, 1);
}));

test('temporary API chat uses selected model and normal tools without a durable turn journal',()=>temp(async root=>{
 const {runtime,sent}=fixture(root,[json('',[call('fixture-call','fixture_write',{})]),json('已完成合成操作')]);let invoked=0;
 const response=await runtime.reply({...request('temp-fixture'),ephemeral:true,temporaryMode:true,
  tools:[{name:'fixture_write',description:'合成写入',parameters:{type:'object',properties:{}}}],executeTool:async()=>{invoked++;return {ok:true};}});
 assert.equal(response.text,'已完成合成操作');assert.equal(invoked,1);assert.equal(sent[0].body.model,model);
 const {readdir}=await import('node:fs/promises');
 assert.deepEqual(await readdir(join(root,'runtime','api-turns')).catch(()=>[]),[]);
}));
