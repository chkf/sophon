import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenRouterRuntime, OpenRouterError } from "./openrouter.js";
import { safeOpenRouterFailure } from "./openrouter-error.js";
import { IMAGE_PRESETS } from "./image-settings.js";
import { ProviderRuntime, lazyRuntime } from "./providers.js";
import { historyFromMessages } from "./history.js";
import { readChatStream } from "./openrouter-stream.js";
import { imageInfo, saveGeneratedImage, downloadImage } from "./openrouter-media.js";
import { runtimeFailureReply, runtimeFailureRetryAfterMs } from "./failure-message.js";
import { GatewayCommandRouter } from "../commands/router.js";
import { Gateway } from "../gateway.js";
import { SessionStore } from "../sessions/store.js";
import { recordDeliveredAssistant } from "../delivery/coordinator.js";
import { localContext } from "../core/context-fixture.js";
import { VoiceSettingsStore } from "../voice/settings.js";
import { deliverPreparedReply } from "../channels/telegram/delivery.js";
import type { ManagedChatRuntime, ChatRequest } from "./types.js";

const KEY = "sk-or-v1-fixture-secret";

test("OpenRouter saves native Telegram reply selection in completed journal and reopens without rerunning tools", () => temp(async root => {
  const target = { channel: "telegram" as const, accountId: "telegram-bot:2468", chatId: "123", messageId: 901 };
  let selected = false, calls = 0;
  const first = fixture(root, [
    stream({ tool_calls: [call("gateway_reply_native", { target: "current" })] }),
    stream({ content: "引用消息后继续回答。" }),
  ]);
  const requestWithReply: ChatRequest = {
    ...request("native-telegram-journal"),
    tools: [{ name: "gateway_reply_native", readOnly: true, parameters: { type: "object" } }],
    getPreparedNativeReply: () => selected ? target : undefined,
    async executeTool(name, args) {
      calls++;
      assert.equal(name, "gateway_reply_native");
      assert.deepEqual(args, { target: "current" });
      selected = true;
      return { status: "selected" };
    },
  };
  try {
    const result = await first.runtime.reply(requestWithReply);
    assert.equal(result.text, "引用消息后继续回答。");
    assert.deepEqual(result.nativeReply, target);
    assert.equal(calls, 1);
    const turnPath = join(root, "runtime", "openrouter-turns");
    const entries = await readdir(turnPath);
    assert.equal(entries.length, 1);
    const saved = JSON.parse(await readFile(join(turnPath, entries[0]!), "utf8"));
    assert.equal(saved.status, "completed");
    assert.deepEqual(saved.response.nativeReply, target);
  } finally { await first.runtime.close(); }
  const reopened = fixture(root, []);
  try {
    const result = await reopened.runtime.reply({
      ...requestWithReply,
      getPreparedNativeReply: () => undefined,
      executeTool: async () => { assert.fail("completed journal must not re-run native selection"); },
    });
    assert.deepEqual(result.nativeReply, target);
    assert.equal(result.text, "引用消息后继续回答。");
    assert.equal(reopened.calls.filter(x => x.path === "chat/completions").length, 0);
  } finally { await reopened.runtime.close(); }
}));

test("OpenRouter persists Gateway's chosen speech instruction with text and reopens without another paid call",()=>temp(async root=>{
  const {VoiceTurn,voiceTool}=await import("../voice/tool.js");
  const voice=new VoiceTurn();
  const text="语音测试内容。", instruction="发音清晰，语速适中，句末自然停顿。";
  const first=fixture(root,[
    stream({tool_calls:[call("send_voice",{text,instruction})]}),
    stream({content:""}),
  ]);
  try{
    const voiceRequest={...request("instruction-journal"),tools:[voiceTool],
      getPreparedVoice:()=>voice.text,getPreparedVoiceInstruction:()=>voice.instruction,
      executeTool:async(_name:string,args:Record<string,unknown>)=>voice.select(args)};
    const response=await first.runtime.reply(voiceRequest);
    assert.equal(response.voiceText,text);
    assert.equal(response.voiceInstruction,instruction);
    const dir=join(root,"runtime","openrouter-turns");
    const entries=await readdir(dir);
    assert.equal(entries.length,1);
    const saved=JSON.parse(await readFile(join(dir,entries[0]!),"utf8"));
    assert.equal(saved.response.voiceInstruction,instruction);
  }finally{await first.runtime.close();}
  const reopened=fixture(root,[]);
  try{
    const response=await reopened.runtime.reply({...request("instruction-journal"),
      getPreparedVoice:()=>undefined,getPreparedVoiceInstruction:()=>undefined,
      executeTool:async()=>{assert.fail("No tool re-execution after completed journal");}});
    assert.equal(response.voiceText,text);
    assert.equal(response.voiceInstruction,instruction);
    assert.equal(reopened.calls.filter(c=>c.path==="chat/completions").length,0);
  }finally{await reopened.runtime.close();}
}));

test("OpenRouter accepts selected voice with empty final text and persists it for replay",()=>temp(async root=>{
  const {VoiceTurn,voiceTool}=await import("../voice/tool.js");
  const voice=new VoiceTurn();
  const {runtime,calls}=fixture(root,[stream({tool_calls:[call("send_voice",{text:"语音测试"})]}),stream({content:""})]);
  const req={...request("voice-only"),tools:[voiceTool],getPreparedVoice:()=>voice.text,executeTool:async(_name:string,args:Record<string,unknown>)=>voice.select(args)};
  const result=await runtime.reply(req);
  assert.equal(result.text,"");assert.equal(result.voiceText,"语音测试");
  const paid=calls.filter(c=>c.path==="chat/completions").length;
  const replay=await runtime.reply({...req,getPreparedVoice:()=>undefined,executeTool:async()=>{throw Error("must not replay tool");}});
  assert.equal(replay.voiceText,"语音测试");assert.equal(calls.filter(c=>c.path==="chat/completions").length,paid);
}));

test("OpenRouter finalizes only visible reply text before journaling and reopens without model or renderer replay", () => temp(async root => {
  const marker = "[[gateway_quote:0123456789abcdef0123456789abcdef]]";
  const final = "记得：" + marker;
  const rendered = "记得：用户原话：周五再讨论\n\nhttps://fixture.invalid/source";
  let registered = false, finalized = 0;
  const first = fixture(root, [
    stream({ content: "工具证据 " + marker, tool_calls: [call("quote_fixture", { id: "original" })] }),
    stream({ content: final, annotations: [{ url_citation: { url: "https://fixture.invalid/source" } }] }),
  ]);
  const req: ChatRequest = { ...request("finalized-quote"), text: "用户输入 " + marker,
    instructions: "保留规则 " + marker,
    tools: [{ name: "quote_fixture", readOnly: true, parameters: { type: "object" } }],
    getPreparedVoice: () => "语音原文 " + marker,
    async executeTool(name, args) {
      assert.equal(name, "quote_fixture"); assert.deepEqual(args, { id: "original" });
      registered = true;
      return { marker };
    },
    finalizeReplyText(text) {
      assert.equal(registered, true);
      finalized++;
      assert.equal(text, final + "\n\nhttps://fixture.invalid/source");
      return text.replace(marker, "用户原话：周五再讨论");
    },
  };
  try {
    const result = await first.runtime.reply(req);
    assert.equal(result.text, rendered);
    assert.equal(result.voiceText, "语音原文 " + marker);
    assert.equal(finalized, 1);
    const chat = first.calls.filter(item => item.path === "chat/completions");
    assert.equal(chat.length, 2);
    assert.equal(chat[1]!.body.messages.find((item: any) => item.role === "tool").content, JSON.stringify({ marker }));
    assert.ok(chat[0]!.body.messages[0].content.includes("保留规则 " + marker));
    assert.equal(chat[0]!.body.messages[1].content[0].text, "用户输入 " + marker);
    assert.equal(chat[0]!.body.finalizeReplyText, undefined);
    const journalDir = join(root, "runtime", "openrouter-turns");
    const files = await readdir(journalDir);
    assert.equal(files.length, 1);
    const saved = JSON.parse(await readFile(join(journalDir, files[0]!), "utf8"));
    assert.equal(saved.status, "completed");
    assert.equal(saved.response.text, rendered);
    assert.equal(saved.response.voiceText, "语音原文 " + marker);
  } finally { await first.runtime.close(); }

  const reopened = fixture(root, []);
  try {
    const replay = await reopened.runtime.reply({ ...req,
      executeTool: async () => { assert.fail("completed tool must not run again"); },
      finalizeReplyText: () => { assert.fail("completed journal must not require the old marker registry"); },
    });
    assert.equal(replay.text, rendered);
    assert.equal(replay.voiceText, "语音原文 " + marker);
    assert.equal(finalized, 1);
    assert.equal(reopened.calls.filter(item => item.path === "chat/completions").length, 0);
  } finally { await reopened.runtime.close(); }
}));

for (const scenario of [
  { name: "TTS disabled, voice-only", final: "", credentials: true, expected: "语音测试" },
  { name: "TTS disabled, text supplement", final: "下一条消息", credentials: true, expected: "语音测试\n\n下一条消息" },
  { name: "credentials removed, repeated final text", final: "语音测试", credentials: false, expected: "语音测试" },
]) test("Gateway recovers completed voice as text after reopening: " + scenario.name,()=>temp(async root=>{
  const settings = new VoiceSettingsStore(root);
  await settings.update({ tts: true });
  const input = { channel: "telegram" as const, conversationId: "123", senderId: "123", messageId: "voice-recovery",
    text: "请用语音回复测试内容", receivedAt: "2026-10-22T12:00:00Z", attachments: [] };
  const context = { load: async () => localContext() };

  const first = fixture(root, [stream({ tool_calls: [call("send_voice", { text: "语音测试" })] }), stream({ content: scenario.final })]);
  const firstSessions = new SessionStore(root);
  try {
    const gateway = new Gateway(first.runtime, firstSessions, context as any,
      0, undefined, undefined, undefined, undefined, async () => (await settings.get()).tts, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {turnDecisionEnabled:false});
    const reply = await gateway.handle(input);
    assert.equal(reply.kind, "model_reply");
    if (reply.kind !== "model_reply") throw new Error("Expected a completed model reply.");
    assert.equal(reply.voiceText, "语音测试");
    assert.equal(reply.text, scenario.expected);
    assert.equal(first.calls.filter(item => item.path === "chat/completions").length, 2);
    // The model completed, but the channel has not persisted/sent this reply yet.
  } finally { firstSessions.close(); await first.runtime.close(); }

  if (scenario.credentials) await settings.update({ tts: false });
  const reopenedSettings = new VoiceSettingsStore(root);
  const reopened = fixture(root, []); // Any new paid model request fails this fixture.
  const sessions = new SessionStore(root);
  let recoveredRequests = 0, voiceSends = 0;
  const textSends: string[] = [];
  try {
    const gateway = new Gateway({ reply: async request => {
      recoveredRequests++;
      assert.equal(request.tools?.some(tool => tool.name === "send_voice") ?? false, false);
      assert.equal(request.getPreparedVoice, undefined);
      return reopened.runtime.reply(request);
    } }, sessions, context as any, 0, undefined, undefined, undefined, undefined,
    async () => scenario.credentials && (await reopenedSettings.get()).tts);
    const reply = await gateway.handle(input);
    assert.equal(reply.kind, "model_reply");
    if (reply.kind !== "model_reply") throw new Error("Expected recovered text.");
    assert.equal(reply.text, scenario.expected);
    assert.equal(reply.voiceText, undefined, "restored text must not authorize a new TTS attempt");
    await deliverPreparedReply({} as any, { ...reply, chatId: "123", senderId: "123" }, {
      sendVoice: async () => { voiceSends++; throw new Error("Recovery must not synthesize or send voice."); },
      onReplyDelivered: event => gateway.commitDeliveredAssistant("telegram", event.conversationId, event.senderId,
        event.reply, event.images, event.deliveryId, event.complete),
    }, async (_target, text) => { textSends.push(text); });
    assert.deepEqual(textSends, scenario.expected.split("\n\n"));
    assert.equal(voiceSends, 0);
    assert.equal(recoveredRequests, 1);
    assert.equal(reopened.calls.filter(item => item.path === "chat/completions").length, 0);
    const history = (await sessions.get("telegram", "123"))!.messages;
    assert.equal(history.filter(message => message.role === "user").length, 1);
    assert.deepEqual(history.filter(message => message.role === "assistant").map(message => message.content), [scenario.expected]);
  } finally { sessions.close(); await reopened.runtime.close(); }
}));

test("OpenRouter does not accept empty final text just because voice tool is advertised",()=>temp(async root=>{
  const {voiceTool}=await import("../voice/tool.js");
  const {runtime}=fixture(root,[stream({content:""})]);
  await assert.rejects(runtime.reply({...request("empty-voice"),tools:[voiceTool],getPreparedVoice:()=>undefined}),/空回复/);
}));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHh0AAAAASUVORK5CYII=";
const MODEL = "fixture/chat";
const imageModel = "fixture/image";
const models = [{id:MODEL,name:"Fixture",architecture:{input_modalities:["text","image"],output_modalities:["text"]},supported_parameters:["tools"],context_length:128000}];
function json(value: unknown, status=200) { return new Response(JSON.stringify(value),{status}); }
function stream(message: any, usage: any={prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.01}, split=7) {
  const bytes=new TextEncoder().encode("data: "+JSON.stringify({choices:[{delta:message,finish_reason:null}]})+"\r\n\r\ndata: "+JSON.stringify({choices:[{delta:{},finish_reason:message.tool_calls?.length?"tool_calls":"stop"}],usage})+"\r\n\r\ndata: [DONE]\r\n\r\n");
  return new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=split)controller.enqueue(bytes.slice(i,i+split));controller.close();}}));
}
function call(name:string,args:unknown,id="call-1") { return {index:0,id,type:"function",function:{name,arguments:JSON.stringify(args)}}; }
function fixture(root:string, outputs:Array<Response|Error>, options:Record<string,any>={}) {
  const calls:Array<{path:string;body:any}>=[];
  const fetcher=async(url:any,init:any)=>{
    const path=new URL(String(url)).pathname.split("/v1/")[1]!;
    const body=init.body?JSON.parse(init.body):undefined;calls.push({path,body});
    assert.equal(init.headers.Authorization,"Bearer "+KEY);
    if(path==="key") return json({data:{limit:1}});
    if(path==="models") return json({data:models});
    if(path==="images/models") return json({data:[imageModel,...IMAGE_PRESETS.map(p=>p.model)].map(id=>({id,architecture:{input_modalities:["text","image"],output_modalities:["image"]}}))});
    const response=outputs.shift(); if(response instanceof Error)throw response;
    assert.ok(response,"unexpected paid call "+path); return response;
  };
  const runtime=new OpenRouterRuntime({dataDir:root,apiKey:KEY,defaultModel:MODEL,imageModel,fetch:fetcher as typeof fetch,...options});
  return {runtime,calls};
}
function request(id="turn-1"):ChatRequest { return {purpose:"chat",deliveryId:id,deferAssistantCommit:true,sessionId:"telegram:owner",operationId:id,text:"你好",context:{controlRevision:"control",contextRevision:"ctx",content:'{"recent":"LIVE"}'}}; }
async function temp(work:(root:string)=>Promise<void>) {const root=await mkdtemp(join(tmpdir(),"gateway-or-"));try{await work(root);}finally{await rm(root,{recursive:true,force:true});}}
function fakeRuntime(name="siwc", available=true) {
  const requests:ChatRequest[]=[];const commits:any[]=[];let selected=name+"/a";
  const runtime:ManagedChatRuntime={
    async signIn(){return this.getSession();},async getSession(){return {status:available?"connected":"disconnected",sharing:available};},
    async listModels(){return [{id:name+"/a",displayName:name},{id:name+"/b",displayName:name}];},
    async getModelSelection(){return {mode:"pinned",model:selected,resolvedModel:selected};},
    async selectModel(model){if(model&&!model.startsWith(name+"/"))throw new Error("Model invalid");selected=model??name+"/a";return this.getModelSelection();},
    async reply(r){requests.push(r.history ? {...r,messages:[...await r.history.readRange(0,r.history.count),...(r.messages??[])]} : r);return {text:name+" reply"};},async commitSession(id,text){commits.push([id,text]);},async resetSession(){},
  };return {runtime,requests,commits};
}

test("history search finds text beyond 4000 characters and supports complete message paging", () => temp(async root => {
  const sessions = new SessionStore(root);
  try {
  const original = "前".repeat(5000) + "约定关键词" + "后".repeat(5000);
  await sessions.append("telegram", "owner", "owner", [{ id: "long", role: "user", content: original, at: "2026-10-10T12:00:00Z" }]);
  const { runtime, calls } = fixture(root, [stream({ tool_calls: [call("gateway_read_history", { query: "约定关键词" })] }), stream({ tool_calls: [call("gateway_read_history", { index: 0, char_offset: 0 }, "read-0")] }), stream({ tool_calls: [call("gateway_read_history", { index: 0, char_offset: 4000 }, "read-1")] }), stream({ tool_calls: [call("gateway_read_history", { index: 0, char_offset: 8000 }, "read-2")] }), stream({ content: "完成" })]);
  await runtime.reply({ ...request(), history: (await sessions.view("telegram", "owner")).history });
  const chat = calls.filter(c => c.path === "chat/completions");
  assert.match(JSON.stringify(chat[0]!.body.tools), /gateway_read_history/);
  const outputs = chat.at(-1)!.body.messages.filter((m: any) => m.role === "tool").map((m: any) => JSON.parse(m.content));
  assert.match(outputs[0].entries[0].content, /约定关键词/);
  assert.equal(outputs[0].entries[0].at, "2026-10-10T12:00:00Z");
  const parts = outputs.slice(1).map((o: any) => o.entries[0]);
  assert.equal(parts.map((p: any) => p.content).join(""), original);
  assert.deepEqual(parts.map((p: any) => p.nextCharOffset), [4000, 8000, null]);
  } finally { sessions.close(); }
}));

test("missing/invalid OpenRouter Key cannot activate paid routing or leak secrets",()=>temp(async root=>{
  const missing=new OpenRouterRuntime({dataDir:root});assert.equal((await missing.getSession()).status,"disconnected");
  const {runtime}=fixture(root,[],{fetch:async()=>json({error:{message:KEY}},401)});
  assert.equal((await runtime.getSession()).status,"disconnected");
  await assert.rejects(runtime.listModels(),error=>!String(error).includes(KEY)&&String(error).includes("认证失败"));
  const siwc=fakeRuntime();const router=new ProviderRuntime(root,{siwc:siwc.runtime,openrouter:missing});
  await assert.rejects(router.selectProvider("openrouter"));assert.equal(await router.getProvider(),"siwc");
  await router.reply(request());assert.equal(siwc.requests[0]!.sessionId,"telegram:owner");
}));

test("provider and per-provider model state survive restart; checkpoints never cross provider/model boundaries",()=>temp(async root=>{
  const siwc=fakeRuntime();const or=fakeRuntime("openrouter");
  let router=new ProviderRuntime(root,{siwc:siwc.runtime,openrouter:or.runtime});
  await router.reply(request());await router.commitSession("telegram:owner","first","turn-1");
  await router.selectModel("siwc/b");await router.selectProvider("openrouter");
  await router.selectModel("openrouter/b");await router.reply({...request("second"),messages:[{role:"user",content:"first"},{role:"assistant",content:"first reply"},{role:"user",content:"second"}]});
  const orId=or.requests[0]!.sessionId;
  router=new ProviderRuntime(root,{siwc:siwc.runtime,openrouter:or.runtime});
  assert.equal(await router.getProvider(),"openrouter");assert.equal((await router.getModelSelection()).model,"openrouter/b");
  // Delivery binding is persisted independently of the selected provider.
  await router.selectProvider("siwc");await router.commitSession("telegram:owner","OR delivered","second");
  assert.equal(or.commits[0][0],orId);
  assert.equal((await router.getModelSelection()).model,"siwc/b");
  await router.reply({...request("third"),messages:[{role:"user",content:"first"},{role:"assistant",content:"OR delivered"},{role:"user",content:"third"}]});
  assert.notEqual(siwc.requests[0]!.sessionId,siwc.requests[1]!.sessionId);
  assert.match(siwc.requests[1]!.sessionId,/:provider:siwc:/);assert.match(orId,/:provider:openrouter:/);
  await assert.rejects(router.selectModel("openrouter/b"));
}));

test("OpenRouter model pin/auto persist independently and never fall back from a missing pin",()=>temp(async root=>{
  const {runtime}=fixture(root,[]);await runtime.selectModel(MODEL);
  const restarted=fixture(root,[]).runtime;assert.equal((await restarted.getModelSelection()).model,MODEL);
  assert.equal((await restarted.selectModel()).mode,"auto");
  await writeFile(join(root,"runtime","openrouter-model.json"),JSON.stringify({mode:"pinned",model:"gone/model"}));
  await assert.rejects(restarted.getModelSelection());
  assert.equal(JSON.parse(await readFile(join(root,"runtime","openrouter-model.json"),"utf8")).model,"gone/model");
}));

test("owner command router switches locally and bounds model listing with stable pagination",()=>temp(async root=>{
  const siwc=fakeRuntime();const or=fakeRuntime("openrouter");
  or.runtime.listModels=async()=>Array.from({length:80},(_,i)=>({id:"openrouter/"+i,displayName:"Model "+i}));
  const providers=new ProviderRuntime(root,{siwc:siwc.runtime,openrouter:or.runtime});
  const commands=new GatewayCommandRouter(providers,{} as any);
  const message=(text:string)=>({text} as any);
  assert.match((await commands.execute(message("/model provider")))!,/siwc/);
  assert.match((await commands.execute(message("/model provider openrouter")))!,/付费/);
  const first=(await commands.execute(message("/model")))!;assert.match(first,/第 1\/7 页/);assert.ok(first.length<3000);assert.doesNotMatch(first,/Model 12 ·/);
  assert.match((await commands.execute(message("/model page 2")))!,/13\. Model 12/);
  assert.match((await commands.execute(message("/model auto")))!,/Provider：openrouter/);
  assert.equal(or.requests.length+siwc.requests.length,0);
}));

test("streamed Function Calling calls the supplied Gateway semantic executor and returns usage",()=>temp(async root=>{
  const {runtime,calls}=fixture(root,[stream({tool_calls:[call("fixture_read",{area:"recent"})]}),stream({content:"已读取记录"})],{webSearch:true});
  const executions:any[]=[];
  const response=await runtime.reply({...request(),tools:[{name:"fixture_read",parameters:{type:"object"}}],executeTool:async(name,args)=>{executions.push([name,args]);return {recent:"LIVE"};}});
  assert.deepEqual(executions,[["fixture_read",{area:"recent"}]]);assert.equal(response.text,"已读取记录");assert.equal(response.usage?.costUsd,0.02);
  const paid=calls.filter(c=>c.path==="chat/completions");
  assert.ok(paid[0]!.body.messages[0].content.includes("LIVE"));assert.equal(paid[0]!.body.provider.allow_fallbacks,false);
  assert.ok(paid.every(c=>c.body.tools.some((t:any)=>t.type==="openrouter:web_search")));
  assert.equal(paid[1]!.body.messages.at(-1).tool_call_id,"call-1");assert.equal(paid[1]!.body.messages.at(-1).content,'{"recent":"LIVE"}');
  const files=await readdir(join(root,"runtime","openrouter-turns"));assert.equal(files.length,1);
  assert.doesNotMatch(await readFile(join(root,"runtime","openrouter-turns",files[0]!),"utf8"),new RegExp(KEY));
}));

test("tool failure and unknown tools are explicit failures, not successful writes",()=>temp(async root=>{
  let executes=0;
  const {runtime,calls}=fixture(root,[stream({tool_calls:[call("unauthorized_delete",{})]}),stream({tool_calls:[call("fixture_read",{},"call-2")]}),stream({content:"工具失败了"})]);
  await runtime.reply({...request(),tools:[{name:"fixture_read",parameters:{}}],executeTool:async()=>{executes++;throw new Error(KEY);}});
  assert.equal(executes,1);
  for(const c of calls.filter(c=>c.path==="chat/completions").slice(1))assert.match(c.body.messages.filter((m:any)=>m.role==="tool").at(-1).content,/"success":false/);
  assert.doesNotMatch(JSON.stringify(calls),new RegExp(KEY));
}));

test("fragmented SSE assembles tool arguments, reasoning details and UTF-8; truncated/error streams cannot execute tools",async()=>{
  const event=(value:unknown)=>"data: "+JSON.stringify(value)+"\n\n";
  const text=event({choices:[{delta:{tool_calls:[{index:0,id:"id",function:{name:"fixture_",arguments:'{"area":'}}],reasoning_details:[{index:0,type:"reasoning.text",text:"前"}]}}]})+
    event({choices:[{delta:{tool_calls:[{index:0,function:{name:"read",arguments:'"recent"}'}}],reasoning_details:[{index:0,type:"reasoning.text",text:"后"}]},finish_reason:"tool_calls"}]})+"data: [DONE]\n\n";
  const response=await readChatStream(new Response(text));
  assert.equal(response.choices[0].message.tool_calls[0].function.arguments,'{"area":"recent"}');
  assert.equal(response.choices[0].message.tool_calls[0].function.name,"fixture_read");assert.equal(response.choices[0].message.reasoning_details[0].text,"前后");
  await assert.rejects(readChatStream(new Response(text.replace("data: [DONE]",""))));
  await assert.rejects(readChatStream(new Response('data: {"error":{"message":"upstream"}}\n\n')));
});

test("network, 402 and 429 failures have no automatic retries, fallback or leaked keys, including after restart",()=>temp(async root=>{
  for(const [index,response] of [new Error("network "+KEY),json({error:{message:KEY}},402),json({error:{message:KEY}},429)].entries()){
    const {runtime,calls}=fixture(root,[response]);let error:any;
    try{await runtime.reply(request("failed-"+index));}catch(e){error=e;}
    assert.ok(error instanceof OpenRouterError);assert.equal(runtimeFailureRetryAfterMs(error),undefined);assert.doesNotMatch(runtimeFailureReply(error),new RegExp(KEY));
    assert.equal(calls.filter(c=>c.path==="chat/completions").length,1);
    const restarted=fixture(root,[]);await assert.rejects(restarted.runtime.reply(request("failed-"+index)));
    assert.equal(restarted.calls.filter(c=>c.path==="chat/completions").length,0);
  }
}));

test("complete context includes old evidence and the latest bootstrap while preserving history tools",()=>temp(async root=>{
  const history=Array.from({length:100},(_,i)=>({role:i%2?"assistant" as const:"user" as const,content:"原话"+i+" "+"x".repeat(1000)}));
  history[0]!.content="old-key-evidence";
  const {runtime,calls}=fixture(root,[stream({tool_calls:[call("gateway_read_history",{query:"old-key"})]}),stream({content:"找到原话"})]);
  const result=await runtime.reply({...request(),messages:history});assert.equal(result.contextEffect,"none");
  const paid=calls.filter(c=>c.path==="chat/completions");
  assert.deepEqual(paid[0]!.body.messages.slice(1).map((message:any)=>message.content[0].text),history.map(message=>message.content));
  assert.ok(paid[0]!.body.messages[0].content.includes("LIVE"));assert.match(paid[1]!.body.messages.at(-1).content,/old-key-evidence/);
}));

test("OpenRouter sends complete persistent history and still retrieves original evidence by tool",()=>temp(async root=>{
  const sessions=new SessionStore(root);
  try {
  await sessions.append("telegram","persistent","owner",Array.from({length:180},(_,i)=>({id:"original:"+i,role:i%2?"assistant" as const:"user" as const,
    content:i===0?"old-persistent-evidence":"original "+i+" "+"x".repeat(512),at:"2026-10-11T00:00:00Z"})));
  const history=(await sessions.view("telegram","persistent")).history;
  const {runtime,calls}=fixture(root,[stream({tool_calls:[call("gateway_read_history",{query:"old-persistent"})]}),stream({content:"找到原话"})]);
  const result=await runtime.reply({...request("persistent"),history});
  assert.equal(result.contextEffect,"none");
  const paid=calls.filter(c=>c.path==="chat/completions");
  assert.deepEqual(paid[0]!.body.messages.slice(1,-1).map((message:any)=>message.content[0].text),
    (await history.readRange(0,history.count)).map(message=>message.content));
  assert.match(paid[1]!.body.messages.at(-1).content,/old-persistent-evidence/);
  } finally { sessions.close(); }
}));

test("image generation uses fixed Images API model, real validated bytes, and successful journals replay without spending",()=>temp(async root=>{
  const {runtime,calls}=fixture(root,[stream({tool_calls:[call("gateway_generate_image",{prompt:"一只猫"})]}),json({data:[{b64_json:PNG,media_type:"image/png"}],usage:{cost:0.04}}),stream({content:"画好了"})]);
  const result=await runtime.reply({...request(),allowImageGeneration:true});assert.equal(result.images?.length,1);
  const image=result.images![0]!;assert.equal(image.width,1);assert.equal(image.height,1);assert.equal(image.mimeType,"image/png");assert.deepEqual(await readFile(image.path),Buffer.from(PNG,"base64"));
  const imageCall=calls.find(c=>c.path==="images")!;assert.equal(imageCall.body.n,1);assert.equal(imageCall.body.model,imageModel);assert.equal(imageCall.body.provider.allow_fallbacks,false);
  const replay=fixture(root,[]);assert.deepEqual(await replay.runtime.reply({...request(),allowImageGeneration:true}),result);
  assert.equal(replay.calls.filter(c=>c.path==="images"||c.path==="chat/completions").length,0);
}));

test("failed and empty image outputs cannot generate twice within a turn",()=>temp(async root=>{
  for(const [index,image]of [json({error:{message:KEY}},500),json({data:[]})].entries()){
    const {runtime,calls}=fixture(root,[stream({tool_calls:[call("gateway_generate_image",{prompt:"猫"})]}),image,stream({tool_calls:[call("gateway_generate_image",{prompt:"猫"},"call-2")]}),stream({content:"未生成成功"})]);
    const result=await runtime.reply({...request("empty-"+index),allowImageGeneration:true});assert.equal(result.images,undefined);
    assert.equal(calls.filter(c=>c.path==="images").length,1);
    assert.match(calls.filter(c=>c.path==="chat/completions").at(-1)!.body.messages.at(-1).content,/"success":false/);
  }
}));

test("image success survives a later text failure; image editing carries only explicitly provided references",()=>temp(async root=>{
  const input=join(root,"input.png");await writeFile(input,Buffer.from(PNG,"base64"));
  const {runtime,calls}=fixture(root,[stream({tool_calls:[call("gateway_generate_image",{prompt:"改成水彩",use_input_image:true})]}),json({data:[{b64_json:PNG}]}),new Error("network")]);
  const result=await runtime.reply({...request(),allowImageGeneration:true,attachments:[{kind:"image",path:input}]});
  assert.equal(result.images?.length,1);assert.match(result.text,/图片已生成/);assert.match(calls.find(c=>c.path==="images")!.body.input_references[0].image_url.url,/^data:image\/png;base64,/);
}));

test("ordinary turns and heartbeat have no image capability; paid heartbeat is opt-in",()=>temp(async root=>{
  const {runtime,calls}=fixture(root,[stream({content:"你好"})]);await runtime.reply(request());
  assert.ok(!calls.find(c=>c.path==="chat/completions")!.body.tools.some((t:any)=>t.function?.name==="gateway_generate_image"));
  assert.equal((await runtime.reply({...request(),purpose:"heartbeat_decision",sessionId:"heartbeat:provider:openrouter:1"})).text,"SILENT");
  assert.equal(calls.filter(c=>c.path==="chat/completions").length,1);
}));

test("background text opt-out blocks every scheduler before network or paid journals",()=>temp(async root=>{
  const {runtime,calls}=fixture(root,[],{heartbeat:false});
  for(const purpose of ["heartbeat_plan","heartbeat_decision","media_exploration"] as const){
    // A marker left by an older scheduler is not an owner authorization.
    const scheduled={...request(purpose),purpose,backgroundAuthorized:true};
    assert.deepEqual(await runtime.reply(scheduled),{text:"SILENT",skipped:"background_disabled"});
  }
  assert.equal(calls.length,0);
  await assert.rejects(readdir(join(root,"runtime","openrouter-turns")),{code:"ENOENT"});
}));

test("background text opt-in permits Media work as well as Heartbeat",()=>temp(async root=>{
  const purposes=["heartbeat_plan","heartbeat_decision","media_exploration"] as const;
  const {runtime,calls}=fixture(root,purposes.map(()=>stream({content:"{}"})),{heartbeat:true});
  for(const purpose of purposes){
    assert.equal((await runtime.reply({...request(purpose),purpose})).skipped,undefined);
  }
  assert.equal(calls.filter(c=>c.path==="chat/completions").length,purposes.length);
}));

test("image opt-in only authorizes image-capable Heartbeat, not unrelated background work",()=>temp(async root=>{
  const {runtime,calls}=fixture(root,[stream({content:'{"wakes":[]}'}),stream({content:"SILENT"})],{heartbeat:false});
  await runtime.setProactiveImages(true);
  calls.length=0;
  for(const purpose of ["media_exploration"] as const){
    assert.deepEqual(await runtime.reply({...request(purpose),purpose,imageOutputAllowed:true}),
      {text:"SILENT",skipped:"background_disabled"});
  }
  assert.equal(calls.length,0);
  await assert.rejects(readdir(join(root,"runtime","openrouter-turns")),{code:"ENOENT"});
  for(const purpose of ["heartbeat_plan","heartbeat_decision"] as const){
    assert.deepEqual(await runtime.reply({...request("no-images-"+purpose),purpose}),
      {text:"SILENT",skipped:"background_disabled"});
    assert.equal((await runtime.reply({...request(purpose),purpose,imageOutputAllowed:true})).skipped,undefined);
  }
  assert.equal(calls.filter(c=>c.path==="chat/completions").length,2);
}));

test("image bytes reject unsupported MIME, oversized/invalid base64, mismatched metadata and unsafe URLs",()=>temp(async root=>{
  assert.throws(()=>imageInfo(Buffer.from("<svg/>")));
  await assert.rejects(saveGeneratedImage(root,{b64_json:PNG,media_type:"image/jpeg"},"p","m"));
  await assert.rejects(saveGeneratedImage(root,{b64_json:"!invalid!"},"p","m"));
  await assert.rejects(saveGeneratedImage(root,{b64_json:"a".repeat(12*1024*1024)},"p","m"));
  await assert.rejects(downloadImage("http://127.0.0.1/a"));await assert.rejects(downloadImage("https://127.0.0.1/a"));
}));

test("Gateway continuity across SIWC → OpenRouter → SIWC retains history, generated metadata and current Gateway policies",()=>temp(async root=>{
  const siwc=fakeRuntime();const or=fakeRuntime("openrouter");
  const providers=new ProviderRuntime(root,{siwc:siwc.runtime,openrouter:or.runtime});
  const sessions=new SessionStore(root);
  try {let revision="recent-1";const requests:ChatRequest[]=[];
  or.runtime.reply=async r=>{requests.push(r.history ? {...r,messages:[...await r.history.readRange(0,r.history.count),...(r.messages??[])]} : r);return {text:"OR middle"};};
  const context={async load(){const c=localContext();return { ...c, data: { ...c.data, recent: revision } }; }};
  const gateway=new Gateway(providers,sessions,context as any);
  const inbound=(id:string,text:string)=>({channel:"telegram" as const,conversationId:"owner",senderId:"owner",messageId:id,text,receivedAt:new Date().toISOString(),attachments:[]});
  const first=await gateway.handle(inbound("1","first"));await gateway.commitDeliveredAssistant("telegram","owner","owner",first.text,first.images,first.deliveryId);
  await providers.selectProvider("openrouter");revision="recent-2";
  const middle=await gateway.handle(inbound("2","middle"));await gateway.commitDeliveredAssistant("telegram","owner","owner",middle.text,middle.images,middle.deliveryId);
  assert.deepEqual(requests[0]!.messages!.map(m=>m.content),["first","siwc reply","middle"]);
  assert.match(requests[0]!.context!.content,/recent-2/);assert.doesNotMatch(requests[0]!.turnInstructions!,/recent-2/);
  await providers.selectProvider("siwc");const last=await gateway.handle(inbound("3","last"));
  assert.deepEqual(siwc.requests[1]!.messages!.map(m=>m.content),["first","siwc reply","middle","OR middle","last"]);
  assert.match(siwc.requests[1]!.instructions!,/本地 Core/);
  assert.equal(siwc.requests[0]!.sessionId,siwc.requests[1]!.sessionId,"same SIWC model reuses its old generation after returning from OpenRouter");
  await gateway.commitDeliveredAssistant("telegram","owner","owner",last.text,last.images,last.deliveryId);
  const image=await saveGeneratedImage(root,{b64_json:PNG},"cat","image/model");
  await recordDeliveredAssistant(sessions,"telegram","owner","owner","画好了",[image],"image-id");
  await recordDeliveredAssistant(sessions,"telegram","owner","owner","画好了",[image],"image-id");
  const transcript=(await sessions.get("telegram","owner"))!;assert.equal(transcript.messages.length,7);assert.equal((transcript.messages.at(-1)!.attachments![0] as any).sha256,image.sha256);
  } finally { sessions.close(); }
}));

test("lazy SIWC SDK initialization is independent of OpenRouter and fails closed",()=>temp(async root=>{
  let initialized=0;const siwc=lazyRuntime(async()=>{initialized++;throw new Error("no SDK");});const or=fakeRuntime("openrouter");
  const runtime=new ProviderRuntime(root,{siwc,openrouter:or.runtime},"openrouter");
  await runtime.reply(request());assert.equal(initialized,0);await assert.rejects(runtime.selectProvider("siwc"));assert.equal(await runtime.getProvider(),"openrouter");
}));

test("started paid journal from a crash blocks all paid requests on restart",()=>temp(async root=>{
  const {createHash}=await import("node:crypto");const {mkdir}=await import("node:fs/promises");
  const id="crashed-operation";const dir=join(root,"runtime","openrouter-turns");await mkdir(dir,{recursive:true});
  await writeFile(join(dir,createHash("sha256").update(id).digest("hex")+".json"),JSON.stringify({status:"started"}));
  const {runtime,calls}=fixture(root,[]);await assert.rejects(runtime.reply(request(id)),/结果不确定/);
  assert.equal(calls.filter(c=>c.path==="chat/completions"||c.path==="images").length,0);
}));

test("model capability and current-file failures are explicit and incur no paid requests",()=>temp(async root=>{
  const {runtime,calls}=fixture(root,[],{fetch:async()=>json({data:[{...models[0],supported_parameters:[]}]})});
  await assert.rejects(runtime.getModelSelection(),/不支持/);assert.equal(calls.length,0);
  const files=fixture(root,[]);await assert.rejects(files.runtime.reply({...request(),attachments:[{kind:"file",path:"notes.txt"}]}),/文件输入/);
  assert.equal(files.calls.filter(c=>c.path==="chat/completions").length,0);
}));

test("initial environment defaults select API without configuring paid opt-ins",()=>temp(async root=>{
  const {loadConfig}=await import("../config/index.js");
  const names=["GATEWAY_PROVIDER","OPENROUTER_API_KEY","OPENROUTER_DEFAULT_MODEL","OPENROUTER_IMAGE_MODEL","OPENROUTER_WEB_SEARCH","OPENROUTER_HEARTBEAT_ENABLED"];
  const old=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  const oldCwd=process.cwd(); process.chdir(root);
  try {
    for(const name of names)delete process.env[name];
    const config=loadConfig();assert.equal(config.provider,"api");assert.equal(config.openrouter?.apiKey,undefined);assert.equal(config.openrouter?.webSearch,false);assert.equal(config.openrouter?.heartbeat,false);
    process.env.GATEWAY_PROVIDER="unknown";assert.throws(loadConfig,/must be api, siwc or openrouter/);
  } finally {process.chdir(oldCwd);for(const name of names){if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name];}}
}));

test("image settings commands validate choices without paid calls, persist, and never switch SIWC",()=>temp(async root=>{
  const {runtime,calls}=fixture(root,[]);
  const wrapper=new ProviderRuntime(root,{siwc:fakeRuntime().runtime,openrouter:runtime});
  const router=new GatewayCommandRouter(wrapper,{} as any);
  const message=(text:string)=>({text} as any);
  assert.match((await router.execute(message("/model image")))!,/主动生图：关闭/);
  assert.match((await router.execute(message("/model image model nonexistent")))!,/未完成/);
  assert.equal((await runtime.getImageSettings()).model,imageModel);
  assert.match((await router.execute(message("/model image model "+imageModel)))!,/生图模型/);
  assert.match((await router.execute(message("/model image proactive on")))!,/主动生图：开启/);
  assert.equal(await wrapper.getProvider(),"siwc");
  await wrapper.reply({...request(),imageOutputAllowed:true});
  assert.equal(calls.filter(c=>c.path==="chat/completions"||c.path==="images").length,0);
  const restarted=fixture(root,[]).runtime;
  assert.equal((await restarted.getImageSettings()).proactive,true);
  assert.equal((await restarted.getImageSettings()).model,imageModel);
  await runtime.setProactiveImages(false);
  assert.equal((await restarted.getImageSettings()).proactive,false);
}));

test("autonomous images are opt-in, Telegram-only, optional and rate limited across restart",()=>temp(async root=>{
  const {runtime,calls}=fixture(root,[stream({role:"assistant",content:"只聊天"}),
    stream({role:"assistant",content:"这轮不需要图片"}),
    stream({role:"assistant",tool_calls:[call("gateway_generate_image",{prompt:"cat"})]}),
    json({data:[{b64_json:PNG}]}),stream({role:"assistant",content:"已生成猫的示例图片"}),
    stream({role:"assistant",content:"仍可主动生图"}),stream({role:"assistant",content:"微信文字"})]);
  await runtime.reply({...request("disabled"),imageOutputAllowed:true});
  assert.equal(calls.at(-1)!.body.tools.some((t:any)=>t.function?.name==="gateway_generate_image"),false);
  await runtime.setProactiveImages(true);
  const optional=await runtime.reply({...request("optional"),imageOutputAllowed:true});
  assert.equal(optional.text,"这轮不需要图片");assert.equal(optional.images,undefined);
  const image=await runtime.reply({...request("automatic"),imageOutputAllowed:true});
  assert.equal(image.images?.length,1);
  await runtime.reply({...request("no-cooldown"),imageOutputAllowed:true});
  assert.equal(calls.at(-1)!.body.tools.some((t:any)=>t.function?.name==="gateway_generate_image"),true);
  await runtime.reply(request("wechat"));
  assert.equal(calls.at(-1)!.body.tools.some((t:any)=>t.function?.name==="gateway_generate_image"),false);
  const budgetPath=join(root,"runtime","openrouter-images.json");
  const budget=JSON.parse(await readFile(budgetPath,"utf8"));
  await writeFile(budgetPath,JSON.stringify({...budget,attempts:10}));
  const next=fixture(root,[]);
  assert.deepEqual(await next.runtime.reply({...request("wake"),purpose:"heartbeat_decision",sessionId:"heartbeat",imageOutputAllowed:true}),{text:"SILENT",skipped:"background_disabled"});
  assert.equal(next.calls.length,0,"exhausted autonomous heartbeat cannot charge for judging");
}));

test("autonomous image failure consumes attempt and cannot be retried, explicit requests remain available",()=>temp(async root=>{
  const {runtime,calls}=fixture(root,[stream({role:"assistant",tool_calls:[call("gateway_generate_image",{prompt:"cat"})]}),
    new Error("timeout"),stream({role:"assistant",content:"没有生成成功"}),
    stream({role:"assistant",tool_calls:[call("gateway_generate_image",{prompt:"cat"})]}),
    json({data:[{b64_json:PNG}]}),stream({role:"assistant",content:"按你的要求画好了"})]);
  await runtime.setProactiveImages(true);
  await runtime.reply({...request("failed-auto"),imageOutputAllowed:true});
  const state=JSON.parse(await readFile(join(root,"runtime","openrouter-images.json"),"utf8"));
  assert.equal(state.attempts,1);
  await runtime.reply({...request("failed-auto"),imageOutputAllowed:true});
  assert.equal(calls.filter(c=>c.path==="images").length,1);
  await runtime.reply({...request("explicit"),allowImageGeneration:true,imageOutputAllowed:true});
  assert.equal(calls.filter(c=>c.path==="images").length,2);
}));

test("image authorization budget enforces ten attempts without cooldown, UTC midnight and persistent toggle",()=>temp(async root=>{
  const {ImageSettingsStore}=await import("./image-settings.js");
  let store=new ImageSettingsStore(root,imageModel);
  assert.equal(await store.available(),false);await store.enable(true);
  await store.reserve(new Date("2026-10-08T00:00:00Z"));
  store=new ImageSettingsStore(root,imageModel);
  assert.equal(await store.available(new Date("2026-10-08T05:59:59Z")),true);
  await store.reserve(new Date("2026-10-08T00:00:00Z"));
  assert.equal("cooldownHours" in await store.get(),false);
  assert.equal(await store.available(new Date("2026-10-08T12:00:00Z")),true);
  await writeFile(join(root,"runtime","openrouter-images.json"),JSON.stringify({proactive:true,model:imageModel,date:"2026-10-08",attempts:9,lastAttempt:"2026-10-08T06:00:00Z"}));
  await store.reserve(new Date("2026-10-08T12:00:00Z"));
  assert.equal((await store.get()).dailyLimit,10);
  assert.equal(await store.available(new Date("2026-10-08T12:00:00Z")),false);
  assert.equal(await store.available(new Date("2026-10-09T00:00:00Z")),true);
  await store.enable(false);await store.enable(true);
  assert.equal(await store.available(new Date("2026-10-08T12:00:00Z")),false,"toggle must not reset quota");
  await store.select("other/image");
  assert.equal(await store.available(new Date("2026-10-08T12:00:00Z")),false,"model changes must not reset quota");
}));

test("all three curated presets persist without paid requests; premium uses bounded high 1K generation",()=>temp(async root=>{
  const {runtime,calls}=fixture(root,[stream({role:"assistant",tool_calls:[call("gateway_generate_image",{prompt:"cat"})]}),
    json({data:[{b64_json:PNG}]}),stream({role:"assistant",content:"画好了"})]);
  for (const preset of IMAGE_PRESETS) {
    const state=await runtime.selectImageModel(preset.id);
    assert.equal(state.model,preset.model);assert.equal(state.preset,preset.id);
    assert.equal(calls.filter(c=>c.path==="images"||c.path==="chat/completions").length,0);
  }
  const restarted=fixture(root,[]).runtime;
  assert.equal((await restarted.getImageSettings()).preset,"premium");
  await runtime.reply({...request("premium"),allowImageGeneration:true});
  const body=calls.find(c=>c.path==="images")!.body;
  assert.equal(body.model,IMAGE_PRESETS[2].model);assert.equal(body.quality,"high");
  assert.equal(body.size,"1024x1024");assert.equal(body.n,1);assert.equal(body.provider.allow_fallbacks,false);
}));

test("SIWC image-only route uses no OpenRouter text model and sends only necessary prompt/reference",()=>temp(async root=>{
  const {runtime:or,calls}=fixture(root,[json({data:[{b64_json:PNG}]})],{defaultModel:undefined});
  const siwc=fakeRuntime();let localToolCalls=0;
  siwc.runtime.reply=async r=>{
    siwc.requests.push(r);
    assert.match(r.instructions!,/PRIVATE_POLICY/);assert.match(r.context!.content,/PRIVATE_CONTEXT/);
    assert.ok(r.tools?.some(t=>t.name==="gateway_generate_image"));
    assert.equal(await r.executeTool!("fixture_read",{}),"local-fixture");
    const result=await r.executeTool!("gateway_generate_image",{prompt:"一只窗边的猫"});
    assert.equal((result as any).success,true);
    assert.equal((await r.executeTool!("gateway_generate_image",{prompt:"再画一张"}) as any).success,false);
    return {text:"已生成猫的示例图片",model:"siwc/a"};
  };
  let wrapper=new ProviderRuntime(root,{siwc:siwc.runtime,openrouter:or});
  await wrapper.selectImageRoute("openrouter");await wrapper.setProactiveImages(true);
  const response=await wrapper.reply({...request("mixed"),imageOutputAllowed:true,instructions:"PRIVATE_POLICY",
    context:{controlRevision:"revision",contextRevision:"context",content:"PRIVATE_CONTEXT"},
    messages:[{role:"assistant",content:"PRIVATE_HISTORY"},{role:"user",content:"今天有哪些待处理任务"}],
    tools:[{name:"fixture_read",parameters:{type:"object"}}],executeTool:async()=>{localToolCalls++;return "local-fixture";}});
  assert.equal(response.images?.length,1);assert.equal(response.model,"siwc/a");assert.equal(localToolCalls,1);
  assert.equal(calls.some(c=>c.path==="models"||c.path==="chat/completions"),false);
  const paid=calls.filter(c=>c.path==="images");assert.equal(paid.length,1);
  assert.deepEqual(Object.keys(paid[0]!.body).sort(),["model","n","prompt","provider"]);
  assert.doesNotMatch(JSON.stringify(paid),/PRIVATE_|fixture_read|bootstrap|messages|instructions/);
  assert.equal(paid[0]!.body.prompt,"一只窗边的猫");
  wrapper=new ProviderRuntime(root,{siwc:siwc.runtime,openrouter:fixture(root,[],{defaultModel:undefined}).runtime});
  assert.equal(await wrapper.getProvider(),"siwc");assert.equal((await wrapper.getImageSettings()).route,"openrouter");
  assert.equal((await wrapper.getImageSettings()).proactive,true);
}));

test("SIWC explicit image edits forward only the selected actual image and require independent-route authorization",()=>temp(async root=>{
  const reference=await saveGeneratedImage(root,{b64_json:PNG},"reference",imageModel);
  const {runtime:or,calls}=fixture(root,[json({data:[{b64_json:PNG}]})],{defaultModel:undefined});
  const siwc=fakeRuntime();let exposed=false;
  siwc.runtime.reply=async r=>{
    exposed=Boolean(r.tools?.some(t=>t.name==="gateway_generate_image"));
    if(exposed) await r.executeTool!("gateway_generate_image",{prompt:"换成水彩画",use_input_image:true});
    return {text:exposed?"画好了":"聊天"};
  };
  const wrapper=new ProviderRuntime(root,{siwc:siwc.runtime,openrouter:or});
  const turn={...request("edit"),allowImageGeneration:true,imageOutputAllowed:true,attachments:[reference]};
  await wrapper.reply(turn);assert.equal(exposed,false);assert.equal(calls.length,0);
  await wrapper.selectImageRoute("openrouter");
  await wrapper.reply(turn);assert.equal(exposed,true);
  assert.equal(calls.some(c=>c.path==="chat/completions"),false);
  const paid=calls.find(c=>c.path==="images")!.body;
  assert.equal(paid.input_references.length,1);assert.match(paid.input_references[0].image_url.url,/^data:image\/png;base64,/);
  assert.equal((await wrapper.getImageSettings()).proactive,false,"explicit image requests do not enable autonomy");
  await wrapper.selectImageRoute("provider");
  await wrapper.reply({...turn,operationId:"route-disabled"});assert.equal(exposed,false);
}));

test("image-only route rejects missing Key and preserves ordinary SIWC chats without charging",()=>temp(async root=>{
  const or=new OpenRouterRuntime({dataDir:root,imageModel});const siwc=fakeRuntime();
  const wrapper=new ProviderRuntime(root,{siwc:siwc.runtime,openrouter:or});
  await assert.rejects(wrapper.selectImageRoute("openrouter"));
  assert.equal((await wrapper.getImageSettings()).route,"provider");
  await wrapper.reply({...request(),imageOutputAllowed:true,allowImageGeneration:true});
  assert.equal(siwc.requests.length,1);assert.equal(siwc.requests[0]!.tools,undefined);
}));

test("mixed-route image failures never replay paid requests and successful bytes survive SIWC continuation failure",()=>temp(async root=>{
  const {runtime:or,calls}=fixture(root,[new Error("uncertain image"),json({data:[{b64_json:PNG}]})],{defaultModel:undefined});
  const siwc=fakeRuntime();
  siwc.runtime.reply=async r=>{
    const result=await r.executeTool!("gateway_generate_image",{prompt:"cat"});
    if((result as any).success) throw new Error("SIWC WebSocket closed");
    return {text:"图片失败"};
  };
  const wrapper=new ProviderRuntime(root,{siwc:siwc.runtime,openrouter:or});await wrapper.selectImageRoute("openrouter");
  const turn={...request("mixed-failure"),imageOutputAllowed:true,allowImageGeneration:true};
  await wrapper.reply(turn);await wrapper.reply(turn);
  assert.equal(calls.filter(c=>c.path==="images").length,1);
  const recovered=await wrapper.reply({...turn,operationId:"mixed-success"});
  assert.equal(recovered.images?.length,1);assert.match(recovered.text,/后续文字回复未完成/);
  assert.equal(calls.filter(c=>c.path==="images").length,2);
}));

test("image route and preset commands keep main Provider SIWC and do not require an OpenRouter default text model",()=>temp(async root=>{
  const {runtime:or,calls}=fixture(root,[],{defaultModel:undefined});
  const wrapper=new ProviderRuntime(root,{siwc:fakeRuntime().runtime,openrouter:or});
  const router=new GatewayCommandRouter(wrapper,{} as any);
  assert.match((await router.execute({text:"/model image model premium"} as any))!,/Sunburst/);
  assert.match((await router.execute({text:"/model image route openrouter"} as any))!,/独立 OpenRouter/);
  assert.match((await router.execute({text:"/model image proactive on"} as any))!,/主动生图：开启/);
  assert.equal(await wrapper.getProvider(),"siwc");
  assert.equal(calls.some(c=>c.path==="chat/completions"||c.path==="images"||c.path==="models"),false);
}));

 test("explicit and autonomous images share the persisted selected model",()=>temp(async root=>{
  const {runtime,calls}=fixture(root,[json({data:[{b64_json:PNG}]}),json({data:[{b64_json:PNG}]})]);
  await runtime.selectImageModel("balanced");await runtime.setProactiveImages(true);
  await runtime.generateImage({operationId:"explicit",prompt:"cat",autonomous:false});
  await runtime.generateImage({operationId:"autonomous",prompt:"cat",autonomous:true});
  const paid=calls.filter(c=>c.path==="images");
  assert.equal(paid[0]!.body.model,"google/gemini-nano-banana-2.1");
  assert.equal(paid[1]!.body.model,"google/gemini-nano-banana-2.1");
  assert.equal((await runtime.getImageSettings()).preset,"balanced");
 }));

test("one-shot provider close releases only initialized transports", () => temp(async root => {
  let initialized = 0;
  let unusedInitialized = 0;
  let closed = 0;
  const siwc = lazyRuntime(async () => {
    initialized++;
    return {
      ...fakeRuntime().runtime,
      close() { closed++; },
    };
  });
  const openrouter = lazyRuntime(async () => {
    unusedInitialized++;
    return fakeRuntime("openrouter").runtime;
  });
  const runtime = new ProviderRuntime(root, { siwc, openrouter });
  assert.equal((await runtime.reply(request())).text, "siwc reply");
  await runtime.close();
  assert.equal(initialized, 1);
  assert.equal(closed, 1, "an initialized SIWC runtime is closed");
  assert.equal(unusedInitialized, 0, "closing must never connect to an unused paid provider");
}));

test("ephemeral text model has no tools, no older history and no response stored on disk",()=>temp(async root=>{
  const noTool = "fixture/roleplay-no-tools";
  const calls:Array<{path:string;body:any}>=[];
  let paid = 0;
  const fetcher=async(url:any,init:any)=>{
    const path=new URL(String(url)).pathname.split("/v1/")[1]!;
    const body=init.body?JSON.parse(init.body):undefined;
    calls.push({path,body});
    if (path==="key") return json({data:{limit:1}});
    if (path==="models") return json({data:[...models,{id:noTool,name:"Roleplay",
      architecture:{input_modalities:["text"],output_modalities:["text"]},
      supported_parameters:["temperature"],context_length:32768}]});
    if (path==="chat/completions") { paid++; return stream({content:"临时回答 PRIVATE_RESPONSE"}); }
    throw new Error("Unexpected request "+path);
  };
  const runtime=new OpenRouterRuntime({dataDir:root,apiKey:KEY,defaultModel:MODEL,webSearch:true,fetch:fetcher as typeof fetch});
  assert.deepEqual(await runtime.validateTestModel(noTool),{model:noTool,supportsTools:false});
  assert.equal((await runtime.listModels()).some(m=>m.id===noTool),false);
  const history=historyFromMessages([
    {role:"assistant",content:"OLD_PRIVATE_CONTEXT "+"h".repeat(20000)},
    {role:"user",content:"temporary sample"},
  ]);
  const req={...request("sandbox-one"),sessionId:"ephemeral:first",
    operationId:"ephemeral:unique",messages:[{role:"user" as const,content:"请进行一次临时文本测试"}],
    history,ephemeral:true,deferAssistantCommit:false,
    testModel:noTool,testHistoryTokens:2048,
    tools:[{name:"fixture_read",parameters:{type:"object"}}],
    executeTool:async()=>{throw new Error("Local tool must not execute");},
    instructions:"Temporary assistant only",context:undefined};
  await assert.rejects(runtime.reply({...req, operationId:"sandbox-reject-image",
    allowImageGeneration:true}), /仅支持文字/);
  await assert.rejects(runtime.reply({...req, operationId:"sandbox-reject-attachment",
    attachments:[{kind:"image" as const,path:"/not-read"}]}), /仅支持文字/);
  assert.equal(paid,0, "reject media before any paid request");
  const response=await runtime.reply(req);
  assert.equal(response.text,"临时回答 PRIVATE_RESPONSE");
  const submitted=calls.find(c=>c.path==="chat/completions")!.body;
  assert.equal(submitted.model,noTool);
  assert.equal(submitted.tools,undefined);
  assert.equal(submitted.max_tokens,1024);
  assert.equal(submitted.provider.allow_fallbacks,false);
  assert.ok(!JSON.stringify(submitted).includes("OLD_PRIVATE_CONTEXT"));
  assert.ok(!JSON.stringify(submitted).includes("gateway_read_history"));
  assert.ok(!JSON.stringify(submitted).includes("openrouter:web_search"));
  assert.equal(paid,1);
  const records=await readdir(join(root,"runtime","openrouter-turns"));
  assert.equal(records.length,1);
  const receipt=await readFile(join(root,"runtime","openrouter-turns",records[0]!),"utf8");
  assert.doesNotMatch(receipt,/PRIVATE_RESPONSE|OLD_PRIVATE_CONTEXT|temporary sample|临时文本测试/);
  assert.match(receipt,/"completed"/);
  await assert.rejects(runtime.reply(req),/未自动重试|不确定/);
  assert.equal(paid,1);
  assert.equal((await runtime.getModelSelection()).resolvedModel,MODEL);
}));

test("ephemeral provider request routes without rewriting production selection",()=>temp(async root=>{
  const siwc=fakeRuntime();
  const or=fakeRuntime("openrouter");
  or.runtime.validateTestModel=async model=>({model,supportsTools:false});
  const providers=new ProviderRuntime(root,{siwc:siwc.runtime,openrouter:or.runtime});
  assert.equal(await providers.getProvider(),"siwc");
  assert.deepEqual(await providers.validateTestModel("openrouter/role"),{model:"openrouter/role",supportsTools:false});
  const req={...request("temp-provider"),ephemeral:true,deferAssistantCommit:false,
    sessionId:"ephemeral:random",testProvider:"openrouter" as const,
    testModel:"openrouter/role",testHistoryTokens:2048};
  assert.equal((await providers.reply(req)).text,"openrouter reply");
  assert.equal(or.requests.length,1);
  assert.equal(siwc.requests.length,0);
  assert.equal(await providers.getProvider(),"siwc");
  await assert.rejects(providers.reply({...request("invalid-provider"),testProvider:"openrouter",testModel:"openrouter/role"}));
  assert.equal(or.requests.length,1);
  assert.equal((await providers.getModelSelection()).resolvedModel,"siwc/a");
  await assert.rejects(providers.reply({...req, deferAssistantCommit:true}), /禁止持久化交付/);
}));

test("oversized paid sandbox message fails before network billing and journal creation",()=>temp(async root=>{
  const {runtime,calls}=fixture(root,[]);
  await assert.rejects(runtime.reply({...request("too-long"),ephemeral:true,deferAssistantCommit:false,
    testModel:MODEL,testHistoryTokens:2048,
    text:"t".repeat(9000),messages:[{role:"user",content:"t".repeat(9000)}]}),/4096/);
  assert.equal(calls.filter(c=>c.path==="chat/completions").length,0);
  await assert.rejects(readdir(join(root,"runtime","openrouter-turns")),/ENOENT/);
}));

test("paid text-only sandbox rejects unsolicited tool calls without executing local tools",()=>temp(async root=>{
  const {runtime,calls}=fixture(root,[stream({tool_calls:[call("fixture_read",{area:"recent"})]})]);
  let executions=0;
  await assert.rejects(runtime.reply({...request("uninvited-tool"),ephemeral:true,
    deferAssistantCommit:false,testModel:MODEL,testHistoryTokens:2048,
    tools:[{name:"fixture_read",parameters:{type:"object"}}],
    executeTool:async()=>{executions++;return {private:"must not leak"};}}), /工具调用/);
  assert.equal(executions,0);
  const paid=calls.filter(c=>c.path==="chat/completions");
  assert.equal(paid.length,1);
  assert.equal(paid[0]!.body.tools,undefined);
  const receipts=await readdir(join(root,"runtime","openrouter-turns"));
  const receipt=await readFile(join(root,"runtime","openrouter-turns",receipts[0]!),"utf8");
  assert.doesNotMatch(receipt,/fixture_read|private|recent|must not leak/);
}));

test("image API rejection exposes allowlisted diagnostics without echoing upstream private text", async () => {
  const privatePrompt = "VERY_PRIVATE_IMAGE_PROMPT";
  const diagnostic = await safeOpenRouterFailure(json({
    error: { code: "provider_error", type: "invalid_request_error",
      message: "No provider for FLUX.2 Pro supports requested parameter(s): n. " + privatePrompt },
  }, 400));
  assert.deepEqual(diagnostic, {
    httpStatus: 400, category: "unsupported_parameter",
    upstreamCode: "provider_error", upstreamType: "invalid_request_error",
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /VERY_PRIVATE_IMAGE_PROMPT/);
  assert.equal((await safeOpenRouterFailure(new Response(privatePrompt, { status: 400 }))).category, "other_bad_request");
  assert.equal((await safeOpenRouterFailure(json({ error: { message: "Request blocked by content policy" } }, 400))).category, "content_policy");
});

test("rejected image writes a safe failure receipt and never replays paid generation", () => temp(async root => {
  const privatePrompt = "PRIVATE_IMAGE_PROMPT";
  const { runtime, calls } = fixture(root, [
    json({ error: { code: "provider_error", type: "invalid_request_error",
      message: "No provider for the model supports requested parameter(s): n; " + privatePrompt } }, 400),
  ]);
  const req = { operationId: "rejected-image", prompt: privatePrompt, autonomous: false };
  await assert.rejects(runtime.generateImage(req), /HTTP 400/);
  const receipts = await readdir(join(root, "runtime", "openrouter-image-turns"));
  assert.equal(receipts.length, 1);
  const journal = JSON.parse(await readFile(join(root, "runtime", "openrouter-image-turns", receipts[0]!), "utf8"));
  assert.equal(journal.status, "failed");
  assert.equal(journal.model, imageModel);
  assert.equal(journal.stage, "image_request");
  assert.deepEqual(journal.diagnostic, {
    httpStatus: 400, category: "unsupported_parameter",
    upstreamCode: "provider_error", upstreamType: "invalid_request_error",
  });
  assert.doesNotMatch(JSON.stringify(journal), /PRIVATE_IMAGE_PROMPT|prompt/);
  assert.equal(calls.filter(c => c.path === "images").length, 1);
  await assert.rejects(runtime.generateImage(req), /不确定|重复消费/);
  assert.equal(calls.filter(c => c.path === "images").length, 1);
}));

test("image failures expose safe HTTP stage and never leak prompts or repeat paid calls",()=>temp(async root=>{
  const {runtime,calls}=fixture(root,[
    json({error:{message:"provider error PRIVATE_IMAGE_PROMPT sk-or-v1-fixture-secret"}},400),
  ]);
  const req={operationId:"failed-image",prompt:"PRIVATE_IMAGE_PROMPT",autonomous:false};
  await assert.rejects(runtime.generateImage(req), error =>
    /HTTP 400/.test(String(error)) && !/PRIVATE_IMAGE_PROMPT|sk-or-v1-fixture-secret/.test(String(error)));
  assert.equal(calls.filter(call=>call.path==="images").length,1);
  assert.equal(calls.filter(call=>call.path==="chat/completions").length,0);
  const imageLogs=await readdir(join(root,"runtime","openrouter-image-turns"));
  assert.equal(imageLogs.length,1);
  const imageLog=await readFile(join(root,"runtime","openrouter-image-turns",imageLogs[0]!),"utf8");
  const diagnostic=JSON.parse(imageLog);
  assert.equal(diagnostic.status,"failed");
  assert.equal(diagnostic.stage,"image_request");
  assert.match(diagnostic.error,/HTTP 400/);
  assert.doesNotMatch(imageLog,/PRIVATE_IMAGE_PROMPT|sk-or-v1-fixture-secret/);
  await assert.rejects(runtime.generateImage(req),/不确定|重复消费/);
  assert.equal(calls.filter(call=>call.path==="images").length,1);
}));

test("image catalogue failures are journaled before any paid image call",()=>temp(async root=>{
  const calls:string[]=[];
  const fetcher=async(url:any)=>{
    const path=new URL(String(url)).pathname.split("/v1/")[1]!;
    calls.push(path);
    if(path==="images/models") return json({data:[]});
    throw new Error("unexpected paid call "+path);
  };
  const runtime=new OpenRouterRuntime({dataDir:root,apiKey:KEY,imageModel,fetch:fetcher as typeof fetch});
  const req={operationId:"image-precheck",prompt:"PRIVATE_PRECHECK_PROMPT",autonomous:false};
  await assert.rejects(runtime.generateImage(req), /模型目录校验失败/);
  assert.equal(calls.filter(path=>path==="images").length,0,"no paid image request without a valid model");
  assert.equal(calls.filter(path=>path==="chat/completions").length,0);
  const files=await readdir(join(root,"runtime","openrouter-image-turns"));
  assert.equal(files.length,1);
  const journal=await readFile(join(root,"runtime","openrouter-image-turns",files[0]!),"utf8");
  assert.equal(JSON.parse(journal).stage,"model_check");
  assert.equal(JSON.parse(journal).status,"failed");
  assert.doesNotMatch(journal,/PRIVATE_PRECHECK_PROMPT|sk-or-v1-fixture-secret/);
  await assert.rejects(runtime.generateImage(req), /不确定|重复消费/);
  assert.equal(calls.length,1,"a failed preflight cannot silently retry");
}));

test("diagnostics select an isolated provider/model, transmit an image and verify a read-only tool without changing production",()=>temp(async root=>{
  const {runtime:or,calls}=fixture(root,[stream({content:"白色图片"}),stream({tool_calls:[call("diagnostic_echo",{})]}),stream({content:"检测成功"})]);
  const wrapper=new ProviderRuntime(root,{siwc:fakeRuntime().runtime,openrouter:or});
  const before=await or.getModelSelection();
  assert.match(await wrapper.diagnosticReply("openrouter",MODEL,"vision"),/白色图片/);
  const imageCall=calls.find(c=>c.path==="chat/completions")!;
  assert.ok(imageCall.body.messages.at(-1).content.some((c:any)=>c.type==="image_url"));
  assert.match(await wrapper.diagnosticReply("openrouter",MODEL,"tools"),/检测成功/);
  assert.equal(await wrapper.getProvider(),"siwc");assert.deepEqual(await or.getModelSelection(),before);
  const journals=await readdir(join(root,"runtime","openrouter-turns"));
  for(const file of journals){const saved=await readFile(join(root,"runtime","openrouter-turns",file),"utf8");assert.doesNotMatch(saved,/白色图片|检测成功/);}
}));

test("OpenRouter preserves ordered multi-voice fragments through its paid journal without replay",()=>temp(async root=>{
  const {VoiceTurn,voiceTool}=await import("../voice/tool.js");
  const turn=new VoiceTurn(false);
  const first=fixture(root,[
    stream({content:"前文（含附录）",tool_calls:[call("send_voice",{text:"第一段",instruction:"平稳表达"},"v1")]}),
    stream({content:"中间文字",tool_calls:[call("send_voice",{text:"第二段",instruction:"轻快表达"},"v2")]}),
    stream({content:"结束"}),
  ]);
  const req:ChatRequest={...request("ordered-voices"),tools:[voiceTool],recordReplyText:(text,id)=>turn.recordText(text,id),
    finalizeReplyText:text=>turn.finalize(text),getPreparedVoice:()=>turn.text,getPreparedReplySegments:()=>turn.segments,
    executeTool:async(_name,args)=>turn.select(args)};
  const response=await first.runtime.reply(req);
  assert.deepEqual(response.replySegments?.map(p=>p.kind),["text","voice","text","voice","text"]);
  assert.doesNotMatch(JSON.stringify(response),/隐藏/);
  const reopened=fixture(root,[]);const recovered=await reopened.runtime.reply({...request("ordered-voices")});
  assert.deepEqual(recovered.replySegments,response.replySegments);
  assert.equal(reopened.calls.some(c=>c.path==="chat/completions"),false);
}));
for(const webSearch of [true,false]) test("Media discovery exposes actual configured search capability: "+webSearch,()=>temp(async root=>{
  const f=fixture(root,[stream({content:'{"candidates":[]}'})],{heartbeat:true,webSearch});
  await f.runtime.reply({...request("media-search"),purpose:"media_exploration"});
  const body=f.calls.find(c=>c.path==="chat/completions")!.body;
  assert.equal((body.tools??[]).some((t:any)=>t.type==="openrouter:web_search"),webSearch);
  if(!webSearch)assert.match(body.messages[0].content,/联网检索未启用/);
}));
