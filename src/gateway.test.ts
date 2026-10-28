import { selectTestTurn } from "./testing/turn-decision.js";
import { seedPersonaDatabase } from "../scripts/testing/persona-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { Gateway, explicitImageRequest } from "./gateway.js";
import { localContext } from "./core/context-fixture.js";
import { ExpressionStore } from "./expression/store.js";
import { SessionStore } from "./sessions/store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const readyContext = { async load() { return { available: true, data: localContext().data }; } };

test("Gateway shares owner history while isolating other users", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-history-visibility-"));
  const sessions = new SessionStore(root);
  try {
    await sessions.append("telegram", "123", "123", [
      { id: "tg-original", role: "user", content: "之前查询过电影资料", at: "2026-10-20T12:00:00Z" },
    ]);
    await sessions.bindOwnerSession("123", "wx-owner");
    await sessions.append("wechat", "wx-owner", "wx-owner", [
      { id: "wx-original", role: "assistant", content: "周末继续整理资料", at: "2026-10-21T12:00:00Z" },
    ]);
    await sessions.append("wechat", "other-user", "other-user", [
      { id: "other-original", role: "user", content: "其他会话的隔离测试消息", at: "2026-10-21T13:00:00Z" },
    ]);
    const requests: any[] = [];
    const gateway = new Gateway({ async reply(request: any) {
      requests.push(request);
      return { text: "收到" };
    } } as any, sessions, readyContext as any);
    const inbound = (channel: "telegram" | "wechat", conversationId: string, id: string) => ({
      channel, conversationId, senderId: conversationId, messageId: id,
      text: "查一下聊天记录", attachments: [],
    });
    await gateway.handle(inbound("telegram", "123", "tg-current"));
    await gateway.handle(inbound("wechat", "wx-owner", "wx-current"));
    for (const request of requests) {
      assert.equal(request.tools.filter((tool: any) => tool.name === "gateway_read_history").length, 1);
      assert.equal(request.tools.find((tool: any) => tool.name === "gateway_read_history").readOnly, true);
      assert.doesNotMatch(request.turnInstructions, /本轮可用函数/);
      await selectTestTurn(request);
    }
    const tgResult = await requests[0].executeTool("gateway_read_history", { query: "周末" });
    assert.deepEqual(tgResult.entries.map((entry: any) => entry.id), ["wx-original"]);
    const wxResult = await requests[1].executeTool("gateway_read_history", { query: "电影" });
    assert.deepEqual(wxResult.entries.map((entry: any) => entry.id), ["tg-original"]);

    await gateway.handle(inbound("wechat", "other-user", "other-current"));
    await selectTestTurn(requests[2]);
    const isolated = await requests[2].executeTool("gateway_read_history", { query: "周末" });
    assert.equal(isolated.total, 0, "another user cannot search the owner's history");

  } finally {
    sessions.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("shared chat lets Telegram choose speech naturally while WeChat remains text-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-voice-preference-"));
  const sessions = new SessionStore(root);
  const requests: Array<{ instructions?: string; turnInstructions?: string;
    resetVoicePreferenceOnReconnect?: boolean; tools?: Array<{ name: string }> }> = [];
  try {
    const gateway = new Gateway({ reply: async request => {
      requests.push(request);
      return { text: "收到" };
    } }, sessions, readyContext as any, 0, undefined, undefined, undefined, undefined,
    async () => true);
    const base = { channel: "telegram" as const, senderId: "123", text: "你好",
      receivedAt: "2026-10-22T12:00:00Z" };

    await gateway.handle({ ...base, conversationId: "voice", messageId: "1",
      attachments: [{ kind: "voice", transcription: "你好" }] });
    assert.equal(requests[0]?.tools?.some(tool => tool.name === "send_voice"), true);
    assert.equal(requests[0]?.resetVoicePreferenceOnReconnect, false);

    await gateway.handle({ ...base, conversationId: "text", messageId: "2", attachments: [] });
    assert.doesNotMatch(requests[1]?.turnInstructions ?? "", /本轮用户没有发送语音/);

    await gateway.handle({ ...base, channel: "wechat", conversationId: "wechat", messageId: "3", attachments: [] });
    assert.equal(requests[2]?.resetVoicePreferenceOnReconnect, false);
    assert.equal(requests[2]?.tools?.some(tool => tool.name === "send_voice") ?? false, false);
    assert.match(requests[2]?.instructions ?? "", /本轮台词选文字或语音一种/);
  } finally { sessions.close(); await rm(root, { recursive: true, force: true }); }
});

test("Gateway does not restore a provider voice transcript into WeChat", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-voice-boundary-"));
  const sessions = new SessionStore(root);
  try {
    const gateway = new Gateway({ reply: async request => {
      assert.equal(request.tools?.some(tool => tool.name === "send_voice") ?? false, false);
      assert.equal(request.getPreparedVoice, undefined);
      return { text: "本轮文字", voiceText: "其他范围的语音原文" };
    } }, sessions, readyContext as any, 0, undefined, undefined, undefined, undefined,
    async () => false);
    const input = { conversationId: "123", senderId: "123", messageId: "voice-boundary", text: "你好", attachments: [] };
    {
      const reply = await gateway.handle({ ...input, channel: "wechat" });
      assert.equal(reply.kind, "model_reply");
      if (reply.kind !== "model_reply") throw new Error("Expected ordinary text.");
      assert.equal(reply.text, "本轮文字");
      assert.equal(reply.voiceText, undefined);
    }
  } finally { sessions.close(); await rm(root, { recursive: true, force: true }); }
});

test("Gateway does not consume a user turn when a retryable model transport fails", async () => {
  const appended: Array<{ role: string; content: string; at: string }> = [];
  let runtimeCalls = 0;

  const sessions = {
    async get() {
      return appended.length
        ? {
            channel: "telegram",
            conversationId: "123",
            senderId: "123",
            updatedAt: appended.at(-1)!.at,
            messages: appended,
          }
        : undefined;
    },
    async append(_channel: string, _conversationId: string, _senderId: string, messages: typeof appended) {
      appended.push(...messages);
      return {
        channel: "telegram",
        conversationId: "123",
        senderId: "123",
        updatedAt: appended.at(-1)!.at,
        messages: appended,
      };
    },
  };

  const runtime = {
    async reply() {
      runtimeCalls += 1;
      if (runtimeCalls === 1) {
        const error = new Error("Responses WebSocket closed before response.completed.") as Error & {
          inboundRetryable?: boolean;
        };
        error.inboundRetryable = true;
        throw error;
      }
      return { text: "收到啦", compacted: false };
    },
  };

  const context = { async load() { return localContext(); } };

  const gateway = new Gateway(runtime as never, sessions as never, context as never);
  const inbound = {
    channel: "telegram" as const,
    conversationId: "123",
    senderId: "123",
    messageId: "9",
    text: "这条消息不能丢",
    receivedAt: "2026-10-07T12:00:00.000Z",
    attachments: [],
  };

  const first = await gateway.handle(inbound);
  assert.equal(first.kind, "retry");
  assert.equal(first.retryAfterMs, 5_000);
  assert.equal(appended.length, 0);

  const second = await gateway.handle(inbound);
  assert.equal(second.text, "收到啦");
  assert.equal(second.kind, "model_reply");
  assert.equal(appended.length, 1);
  assert.equal(appended[0]!.role, "user");
  assert.equal(appended[0]!.content, "这条消息不能丢");
});

test("Gateway pauses exhausted Telegram turns and commits the original user only after manual replay succeeds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-usage-pause-gateway-"));
  const sessions = new SessionStore(dir);
  try {
    let exhausted = true;
    const requests: any[] = [];
    const gateway = new Gateway({
      async reply(request: any) {
        requests.push(request);
        if (exhausted) throw Object.assign(new Error("A ChatGPT sharing limit has been reached"), {
          code: "subscription_sharing_usage_limit_exceeded", status: 429, inboundRetryable: true,
        });
        return { text: "恢复成功" };
      },
    } as any, sessions, readyContext as any);
    const inbound = { channel: "telegram" as const, conversationId: "123", senderId: "123",
      messageId: "9", text: "原问题", receivedAt: "2026-10-18T01:00:00Z", attachments: [] };

    assert.deepEqual(await gateway.handle(inbound), { kind: "pause", reason: "subscription_usage_limit" });
    assert.deepEqual(await gateway.handle(inbound), { kind: "pause", reason: "subscription_usage_limit" });
    assert.equal((await sessions.get("telegram", "123"))?.messages.length ?? 0, 0);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].timezone, "Asia/Shanghai");
    assert.equal(requests[0].messages.at(-1)?.at, inbound.receivedAt,
      "retry must retain the original transport timestamp instead of assigning a new one");
    assert.equal(requests.every(request => request.testProvider === undefined), true);

    exhausted = false;
    const result = await gateway.handle(inbound);
    assert.equal(result.kind, "model_reply");
    assert.equal(result.text, "恢复成功");
    assert.equal(new Set(requests.map(request => request.operationId)).size, 1);
    const transcript = await sessions.get("telegram", "123");
    assert.deepEqual(transcript?.messages.map(message => [message.role, message.content, message.id]),
      [["user", "原问题", "telegram:123:9:user"]]);
    if (result.kind === "model_reply") {
      await gateway.commitDeliveredAssistant("telegram", "123", "123", result.text, undefined, result.deliveryId);
      await gateway.commitDeliveredAssistant("telegram", "123", "123", result.text, undefined, result.deliveryId);
    }
    assert.deepEqual((await sessions.get("telegram", "123"))?.messages.map(message => message.role),
      ["user", "assistant"], "delivery acknowledgement is idempotent");
  } finally {
    sessions.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Gateway does not offer quota replay after an unsafe tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-usage-unsafe-gateway-"));
  const sessions = new SessionStore(dir);
  try {
    const gateway = new Gateway({
      async reply() { throw Object.assign(new Error("A ChatGPT sharing limit has been reached"), {
        code: "subscription_sharing_usage_limit_exceeded", inboundRetryable: false,
      }); },
      async resetSession() {},
    } as any, sessions, readyContext as any);
    const inbound = { channel: "telegram" as const, conversationId: "123", senderId: "123",
      messageId: "10", text: "写入后失败", receivedAt: "2026-10-18T01:00:00Z", attachments: [] };
    const unsafe = await gateway.handle(inbound);
    assert.equal(unsafe.kind, "local_reply");
    assert.equal((await sessions.get("telegram", "123"))?.messages.length, 1);

  } finally {
    sessions.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Gateway retries a delayed message across midnight using processing time while preserving send time", async () => {
  const sentAt = "2026-10-05T15:55:00.000Z";
  let now = new Date("2026-10-05T15:58:00.000Z");
  const turns: string[] = [];
  const appended: any[] = [];
  const gateway = new Gateway({
    async reply(request: any) {
      turns.push(request.turnInstructions);
      if (turns.length === 1) throw Object.assign(new Error("transport closed"), { inboundRetryable: true });
      return { text: "ok" };
    },
  } as any, {
    async get() { return { messages: [{ role: "assistant", content: "earlier", at: "2026-10-05T14:00:00Z" }] }; },
    async append(_channel: string, _conversation: string, _sender: string, messages: any[]) { appended.push(...messages); },
  } as any, readyContext as any, 0, "Asia/Shanghai", () => now);
  const message = { channel: "telegram" as const, conversationId: "123", senderId: "123",
    text: "今天有什么安排？", receivedAt: sentAt, attachments: [] };
  assert.equal((await gateway.handle(message)).retryAfterMs, 5_000);
  assert.equal(appended.length, 0);
  now = new Date("2026-10-05T16:10:00.000Z");
  assert.equal((await gateway.handle(message)).text, "ok");
  assert.match(turns[0]!, /当前渠道本地时间：2026-10-05 23:58/);
  assert.match(turns[1]!, /当前渠道本地时间：2026-10-06 00:10/);
  assert.match(turns[1]!, /本轮用户消息发送时间：2026-10-05 23:55（距当前 15分钟）/);
  assert.match(turns[1]!, /2小时10分钟/);
  assert.equal(appended[0].at, sentAt);
});

test("Gateway saves current and quoted attachment references and restores them in later history", async () => {
  const messages: any[] = [];
  const requests: any[] = [];
  const gateway = new Gateway({ async reply(request: any) { requests.push(request); return { text: "ok" }; } } as any,
    { async get() { return { messages }; },
      async append(_c: string, _id: string, _s: string, entries: any[]) { messages.push(...entries); } } as any,
    readyContext as any);
  await gateway.handle({ channel: "telegram", conversationId: "123", senderId: "123", text: "看这些",
    receivedAt: "2026-10-05T15:55:00Z",
    replyTo: { messageId: "1", sender: "user", text: "旧图片", attachments: [
      { kind: "image", localPath: "/fixture/old.png", mimeType: "image/png" },
    ] }, attachments: [{ kind: "document", localPath: "/fixture/notes.txt", fileName: "notes.txt", mimeType: "text/plain" }],
  });
  const expected = [
    { kind: "image", path: "/fixture/old.png", mimeType: "image/png" },
    { kind: "file", path: "/fixture/notes.txt", fileName: "notes.txt", mimeType: "text/plain" },
  ];
  assert.deepEqual(requests[0].attachments, expected);
  assert.deepEqual(messages[0].attachments, expected);
  await gateway.handle({ channel: "telegram", conversationId: "123", senderId: "123", text: "继续", attachments: [], receivedAt: "2026-10-05T16:00:00Z" });
  assert.deepEqual(requests[1].messages[0].attachments, expected);
});

test("Gateway never runs model when local Core context is unavailable", async () => {
  const context = { async load() { return { available: false, retryAfterMs: 5_000,
    error: "Local Core unavailable" }; } };
  const gateway = new Gateway({ async reply() { assert.fail("model must not run"); } } as any,
    { async get() {}, async append() { assert.fail("transcript must not advance"); } } as any,
    context as any);
  assert.deepEqual(await gateway.handle({ channel: "telegram", conversationId: "123", senderId: "123",
    text: "不要丢失", attachments: [], receivedAt: "2026-10-05T16:00:00Z" }),
    { kind: "retry", retryAfterMs: 5_000 });
});

test("only explicit image requests enable the paid image tool", () => {
  for (const text of ["给我画一张图片", "帮我生成一张猫图", "把这张图改成水彩", "Can you draw a picture of a cat?", "画一只猫", "同样的提示词再生成一张我看看效果"]) assert.equal(explicitImageRequest(text), true, text);
  for (const text of ["今天我画一张图片", "如何画一张图片？", "图片生成接口怎么实现？", "我看过一幅油画", "修改代码", "hello"]) assert.equal(explicitImageRequest(text), false, text);
});

test("Gateway explicitly covers trailing unanswered historical user messages", async () => {
  const history: any[] = [
    { role: "assistant", content: "之前的回答", at: "2026-10-09T12:00:00.000Z" },
    { role: "user", content: "香港有什么推荐？", at: "2026-10-09T12:01:00.000Z" },
    { role: "user", content: "还在吗", at: "2026-10-09T12:02:00.000Z" },
  ];
  const requests: any[] = [];
  const gateway = new Gateway({
    async reply(request: any) { requests.push(request); return { text: "香港可以考虑这些地方", compacted: false }; },
  } as any, {
    async get() { return { messages: history }; },
    async append(_channel: string, _conversationId: string, _senderId: string, entries: any[]) { history.push(...entries); },
  } as any, readyContext as any);
  const inbound = { channel: "telegram" as const, conversationId: "123", senderId: "123",
    messageId: "12", text: "继续", receivedAt: "2026-10-09T12:03:00.000Z", attachments: [] };
  const reply = await gateway.handle(inbound);
  assert.equal(reply.text, "香港可以考虑这些地方");
  assert.match(requests[0].turnInstructions, /还有 2 条用户消息/);
  assert.match(requests[0].turnInstructions, /优先处理仍有效的问题/);
  assert.deepEqual(requests[0].messages.slice(1).map((m: any) => m.content), ["香港有什么推荐？", "还在吗", "继续"]);

  await gateway.commitDeliveredAssistant("telegram", "123", "123", reply.text, undefined, reply.deliveryId);
  await gateway.handle({ ...inbound, messageId: "13", text: "谢谢" });
  assert.doesNotMatch(requests[1].turnInstructions, /还有 2 条用户消息/);
});

test("Gateway changes expression settings without resetting shared chat history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-persona-turn-"));
  try {
    await seedPersonaDatabase(dir);
    const personas = new ExpressionStore(dir);
    const history: any[] = [];
    const requests: any[] = [];
    const gateway = new Gateway({
      async reply(request: any) {
        requests.push(request);
        return { text: "ok" };
      },
    } as any, {
      async get() { return { messages: history }; },
      async append(_channel: string, _conversation: string, _sender: string, entries: any[]) {
        history.push(...entries);
      },
    } as any, readyContext as any, 0, "Asia/Shanghai",
    () => new Date("2026-10-13T13:00:00Z"), personas);

    const inbound = (messageId: string, text: string) => ({
      channel: "telegram" as const, conversationId: "123", senderId: "123", messageId,
      text, receivedAt: "2026-10-13T13:00:00Z", attachments: [],
    });
    await gateway.handle(inbound("1", "记录这个测试话题"));
    await personas.setShowStageDirections(true);
    await gateway.handle(inbound("2", "继续"));
    await personas.setShowStageDirections(true);
    await gateway.handle(inbound("3", "继续"));
    await personas.setShowStageDirections(false);
    await gateway.handle(inbound("4", "最后一问"));

    assert.equal(requests.length, 4);
    assert.deepEqual(requests.map(request => request.sessionId),
      Array(4).fill("telegram:123"), "Persona switching must not fork sessions");
    assert.ok(requests.every(request => !request.instructions.includes("表达风格")),
      "Persona must not be frozen in local Core instructions");
    for (const [index, expected] of ["关闭", "开启", "开启", "关闭"].entries()) {
      assert.match(requests[index].instructions, new RegExp("心理和动作描写已" + expected));
      assert.match(requests[index].turnInstructions, /当前渠道本地时间/);
      assert.doesNotMatch(requests[index].turnInstructions, /CLEAR|HELPFUL/);
    }
    assert.deepEqual(history.map(entry => entry.content),
      ["记录这个测试话题", "继续", "继续", "最后一问"]);
    assert.equal(requests[3].messages[0].content, "记录这个测试话题");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-transient model failure retains a safely replayable Telegram turn for /retry",async()=>{
  const root=await mkdtemp(join(tmpdir(),"gateway-manual-retry-"));const sessions=new SessionStore(root);
  try{
    const {tagInboundRetryability}=await import("./runtime/retry-policy.js");let failed=true;
    const gateway=new Gateway({reply:async()=>{if(failed)throw tagInboundRetryability(new Error("invalid response"),false,true);return {text:"恢复成功"};}},sessions,readyContext as any);
    const inbound={channel:"telegram" as const,conversationId:"123",senderId:"123",messageId:"9",text:"原问题",receivedAt:"2026-10-23T07:00:00Z",attachments:[]};
    assert.deepEqual(await gateway.handle(inbound),{kind:"pause",reason:"model_failure"});
    assert.equal(await sessions.get("telegram","123"),undefined);
    failed=false;assert.equal((await gateway.handle(inbound)).kind,"model_reply");
    const history=(await sessions.get("telegram","123"))!.messages;
    assert.equal(history.length,1);assert.equal(history[0]!.at,inbound.receivedAt);
  }finally{sessions.close();await rm(root,{recursive:true,force:true});}
});

test("manual retry permission never follows an unsafe tool or an uncertain paid call",async()=>{
  const root=await mkdtemp(join(tmpdir(),"gateway-retry-unsafe-"));const sessions=new SessionStore(root);
  try{
    const {tagInboundRetryability}=await import("./runtime/retry-policy.js");
    const {OpenRouterError}=await import("./runtime/openrouter-error.js");
    for(const error of [tagInboundRetryability(new Error("after write"),false,false),new OpenRouterError("上次付费结果不确定，不能重复消费")]){
      const gateway=new Gateway({reply:async()=>{throw error;}},sessions,readyContext as any);
      assert.equal((await gateway.handle({channel:"telegram",conversationId:"123",senderId:"123",messageId:error.message,text:"原问题",attachments:[]})).kind,"local_reply");
    }
  }finally{sessions.close();await rm(root,{recursive:true,force:true});}
});

test('temporary chat reuses normal file tools, reads formal history and leaves no formal transcript or trace',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sophon-temporary-fixture-'));const sessions=new SessionStore(root);
 try{
  await sessions.append('telegram','80001','80001',[{role:'user',content:'正式文档问题',at:'2026-01-01T00:00:00Z'}]);
  let request:any,writes=0,traces=0;
  const files={tools:()=>[{name:'fixture_write',description:'合成文件操作',parameters:{type:'object',properties:{}}}],execute:async()=>{writes++;return {ok:true};}};
  const runtime={reply:async(r:any)=>{request=r;await selectTestTurn(r);await r.executeTool('fixture_write',{});return {text:'临时操作完成'};}};
  const gateway=new Gateway(runtime,sessions,readyContext as any,0,undefined,undefined,undefined,undefined,undefined,undefined,()=>{traces++;},files as any);
  const message={channel:'telegram' as const,conversationId:'80001',senderId:'80001',messageId:'temp-fixture',text:'临时文档请求',attachments:[]};
  const result=await gateway.handle(message,{id:'temporary:fixture',messages:[{role:'user',content:'内存前文'},{role:'assistant',content:'内存答复'}]});
  assert.equal(result.kind,'model_reply');assert.equal(writes,1);assert.equal(traces,0);
  assert.equal(request.ephemeral,true);assert.equal(request.temporaryMode,true);assert.equal(request.deferAssistantCommit,false);
  assert.equal(request.history,undefined);assert.equal(request.trace,undefined);assert.equal(request.memory,undefined);
  assert.match(JSON.stringify(request.messages),/内存前文/);assert.doesNotMatch(JSON.stringify(request.messages),/正式文档问题/);
  assert.equal((await request.executeTool('gateway_read_history',{query:'正式文档'})).total,1);
  assert.equal((await sessions.view('telegram','80001')).history.count,1);
  await assert.rejects(request.executeTool('gateway_recent_create',{body:'临时记录'}),/未开放/);
 }finally{sessions.close();await rm(root,{recursive:true,force:true});}
});
