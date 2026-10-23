import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiwcRuntime } from "./index.js";
import { LaneStore } from "./lane-store.js";
import { textFrom } from "./responses-codec.js";
import { StatefulResponsesBridge, type StatefulResponsesSocket } from "./stateful-responses.js";
import type { SiwcClient, CredentialEncryptionAdapter } from "./sdk.js";

const marker = "[[gateway_quote:0123456789abcdef0123456789abcdef]]";
const quote = "用户原话：周五再讨论";
const sessionId = "telegram:quote-fixture";
const tool = { name: "quote_fixture", readOnly: true, parameters: { type: "object" } };
const toolCall = { type: "function_call", call_id: "quote-call", namespace: "gateway",
  name: tool.name, arguments: '{"id":"original"}' };
const encryption: CredentialEncryptionAdapter = {
  id: "fixture", isAvailable: () => true,
  encrypt: text => Buffer.from(text), decrypt: bytes => Buffer.from(bytes).toString(),
};

class FixtureSocket implements StatefulResponsesSocket {
  readonly sent: Record<string, unknown>[] = [];
  private current?: Record<string, unknown>[];
  private listeners: Array<() => void> = [];
  constructor(private readonly turns: Record<string, unknown>[][]) {}
  send(event: Record<string, unknown>): void {
    assert.equal(event.finalizeReplyText, undefined, "local renderer must not be sent to the provider");
    this.sent.push(event);
    this.current = this.turns.shift();
    assert.ok(this.current, "unexpected model request");
  }
  async *stream() {
    assert.ok(this.current);
    for (const message of this.current) yield { type: "message", message };
    this.current = undefined;
  }
  close(): void { for (const listener of this.listeners) listener(); }
  onClose(listener: () => void): void { this.listeners.push(listener); }
}

function completed(id: string, output: Record<string, unknown>[]) {
  return [{ type: "response.completed", response: { id, output } }];
}

function assistantText(items: Record<string, unknown>[]): string {
  return items.filter(item => item.role === "assistant")
    .map(item => typeof item.content === "string" ? item.content : textFrom([item])).join("");
}

async function runtimeFixture(root: string, bridge?: StatefulResponsesBridge,
  streamResponse: SiwcClient["streamResponse"] = async () => { throw new Error("unexpected generic SDK call"); }) {
  const storage = join(root, "chatgpt");
  await mkdir(storage, { recursive: true });
  await writeFile(join(storage, "chatgpt-auth.json"), JSON.stringify({ version: 3, provider: "fixture",
    ciphertext: Buffer.from(JSON.stringify({ version: 2, activeProfileId: "fixture", profiles: [{
      id: "fixture", status: "connected", scopes: ["chatgpt.tokens.use.direct"],
      credentials: { accessToken: "fixture-token" },
    }] })).toString("base64"),
  }));
  const client: SiwcClient = {
    async signIn() { return { status: "connected", sharing: true }; },
    async getSession() { return { status: "connected", sharing: true }; },
    async listModels() { return [{ slug: "fixture/chat", displayName: "Fixture" }]; },
    streamResponse,
  };
  const runtime = new SiwcRuntime(client, storage, root, encryption);
  if (bridge) Object.assign(runtime, { statefulResponses: bridge });
  return runtime;
}

test("SIWC stateful tool selects one native TG reply target without inserting quote text in conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "siwc-native-reply-"));
  const nativeTool = { name: "gateway_reply_native", readOnly: true,
    parameters: { type: "object", properties: { target: { type: "string" } } } };
  const target = { channel: "telegram" as const, accountId: "telegram-bot:2468", chatId: "123", messageId: 567 };
  const socket = new FixtureSocket([
    completed("native-call", [{ type: "function_call", call_id: "native-call",
      namespace: "gateway", name: nativeTool.name, arguments: '{"target":"current"}' }]),
    completed("native-completed", [{ type: "message", role: "assistant",
      content: [{ type: "output_text", text: "我按你的意思回答。" }] }]),
  ]);
  const runtime = await runtimeFixture(root, new StatefulResponsesBridge(root, () => socket));
  let selected = false, toolCalls = 0;
  try {
    const result = await runtime.reply({ purpose: "chat", sessionId: "telegram:owner",
      deliveryId: "native-delivery", deferAssistantCommit: true, stateful: true,
      text: "引用我刚才那条", tools: [nativeTool],
      async executeTool(name, args) {
        toolCalls++;
        assert.equal(name, nativeTool.name);
        assert.deepEqual(args, { target: "current" });
        selected = true;
        return { status: "selected" };
      },
      getPreparedNativeReply: () => selected ? target : undefined,
    });
    assert.deepEqual(result.nativeReply, target);
    assert.equal(result.text, "我按你的意思回答。");
    assert.equal(toolCalls, 1);
    assert.equal(socket.sent.length, 2);
    assert.equal(socket.sent.some(item => "getPreparedNativeReply" in item), false);
    const store = new LaneStore(root);
    const staged = (await store.read("telegram:owner"))!;
    assert.equal(staged.pendingDeliveryId, "native-delivery");
    await runtime.commitSession("telegram:owner", result.text, "native-delivery");
    const committed = (await store.read("telegram:owner"))!;
    assert.equal(assistantText(committed.contextItems), result.text);
    assert.equal(JSON.stringify(committed.contextItems).includes("telegram-bot:2468"), false,
      "native target stays outside persisted model context");
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SIWC direct runtime finalizes once after a real tool loop without changing input or tool evidence", async t => {
  const root = await mkdtemp(join(tmpdir(), "siwc-direct-finalize-"));
  const runtime = await runtimeFixture(root);
  const requests: any[] = [];
  let registered = false, finalized = 0;
  try {
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); requests.push(body);
      const events = requests.length === 1 ? [
        { type: "response.output_text.delta", delta: "中间文字 " + marker },
        { type: "response.output_item.done", item: toolCall },
        { type: "response.completed" },
      ] : [
        { type: "response.output_text.delta", delta: "记得：" + marker },
        { type: "response.completed" },
      ];
      assert.ok(requests.length <= 2, "unexpected model request");
      return new Response(events.map(event => "data: " + JSON.stringify(event) + "\n\n").join(""));
    });
    const result = await runtime.reply({ purpose: "chat", sessionId, text: "输入 " + marker,
      instructions: "规则 " + marker, tools: [tool],
      async executeTool(name, args) {
        assert.equal(name, tool.name); assert.deepEqual(args, { id: "original" });
        registered = true;
        return { marker };
      },
      finalizeReplyText(text) {
        assert.ok(registered); finalized++;
        assert.equal(text, "记得：" + marker);
        return text.replace(marker, quote);
      },
    });
    assert.equal(result.text, "记得：" + quote);
    assert.equal(finalized, 1); assert.equal(requests.length, 2);
    assert.equal(requests[0].instructions, "规则 " + marker);
    assert.equal(requests[0].input[0].content, "输入 " + marker);
    assert.equal(requests[1].input.find((item: any) => item.type === "function_call_output").output, JSON.stringify({ marker }));
    assert.equal(requests[1].finalizeReplyText, undefined);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

for (const settlement of ["live-commit", "restart-commit", "reset"] as const) {
  test("SIWC final reply expansion preserves delivery checkpoints and tool evidence: " + settlement, async () => {
    const root = await mkdtemp(join(tmpdir(), "siwc-stateful-finalize-"));
    const opaque = { type: "compaction", encrypted_content: "opaque " + marker };
    const media = { type: "output_image", image_url: "fixture-image:" + marker };
    const reasoning = { type: "reasoning", id: "reasoning", encrypted_content: "reasoning " + marker };
    const finalOutput = [{ type: "message", role: "assistant", content: [
      { type: "output_text", text: "记得：" + marker.slice(0, 22) },
      media,
      { type: "output_text", text: marker.slice(22), annotations: [{ type: "url_citation",
        url: "https://fixture.invalid/source", title: "依据", end_index: marker.length - 22 }] },
    ] }, reasoning];
    const rendered = "记得：" + quote + "【依据：https://fixture.invalid/source】";
    const socket = new FixtureSocket([
      completed("quote-tool", [opaque, toolCall]), completed("quote-final", finalOutput),
    ]);
    let runtime: SiwcRuntime | undefined;
    let recovered: SiwcRuntime | undefined;
    let registered = false, finalized = 0;
    const store = new LaneStore(root);
    try {
      runtime = await runtimeFixture(root, new StatefulResponsesBridge(root, token => {
        assert.equal(token, "fixture-token"); return socket;
      }));
      const result = await runtime.reply({ purpose: "chat", sessionId, text: "输入 " + marker,
        stateful: true, instructions: "规则 " + marker, tools: [tool],
        deliveryId: "quote-delivery", deferAssistantCommit: true,
        getPreparedVoice: () => "语音原文 " + marker,
        getPreparedVoiceInstruction: () => "发音清晰，语速适中，句末停顿。",
        async executeTool(name, args) {
          assert.equal(name, tool.name); assert.deepEqual(args, { id: "original" });
          registered = true; return { marker };
        },
        finalizeReplyText(text) {
          assert.ok(registered); finalized++;
          assert.equal(text, "记得：" + marker + "【依据：https://fixture.invalid/source】");
          return text.replace(marker, quote);
        },
      });
      assert.equal(result.text, rendered); assert.equal(result.voiceText, "语音原文 " + marker);
      assert.equal(result.voiceInstruction, "发音清晰，语速适中，句末停顿。");
      assert.equal(finalized, 1); assert.equal(socket.sent.length, 2);
      assert.ok(JSON.stringify(socket.sent[0]!.input).includes("规则 " + marker));
      assert.ok(JSON.stringify(socket.sent[0]!.input).includes("输入 " + marker));
      assert.equal((socket.sent[1]!.input as Record<string, unknown>[])[0]!.output, JSON.stringify({ marker }));
      const pending = (await store.read(sessionId))!;
      assert.equal(pending.pendingDeliveryId, "quote-delivery");
      assert.equal(assistantText(pending.contextItems), "", "undelivered assistant must not enter rollback checkpoint");
      assert.deepEqual(pending.contextItems.find(item => item.type === "compaction"), opaque);

      if (settlement === "live-commit") {
        await runtime.commitSession(sessionId, result.text, "quote-delivery");
        const committed = (await store.read(sessionId))!;
        assert.equal(assistantText(committed.contextItems), rendered);
        assert.deepEqual(committed.contextItems.find(item => item.type === "reasoning"), reasoning);
        const message = committed.contextItems.find(item => item.role === "assistant")!;
        assert.deepEqual((message.content as Record<string, unknown>[]).find(part => part.type === "output_image"), media);
        assert.equal(JSON.stringify(message).includes(marker), true, "non-text media remains unchanged");
        assert.equal(textFrom([message]).includes(marker), false, "visible assistant text has no unresolved marker");
      } else if (settlement === "reset") {
        await runtime.resetSession(sessionId, "quote-delivery");
      }
      await runtime.close(); runtime = undefined;

      const nextSocket = new FixtureSocket([completed("next", [{ type: "message", role: "assistant",
        content: [{ type: "output_text", text: "继续" }] }])]);
      recovered = await runtimeFixture(root, new StatefulResponsesBridge(root, () => nextSocket));
      if (settlement === "restart-commit") {
        await recovered.commitSession(sessionId, result.text, "quote-delivery");
        assert.equal(nextSocket.sent.length, 0, "settlement after restart must not generate again");
        assert.equal(assistantText((await store.read(sessionId))!.contextItems), rendered);
      }
      assert.equal((await store.read(sessionId))!.pendingDeliveryId, undefined);
      await recovered.reply({ purpose: "chat", sessionId, stateful: true, text: "继续讨论" });
      const replayed = nextSocket.sent[0]!.input as Record<string, unknown>[];
      assert.equal(assistantText(replayed), settlement === "reset" ? "" : rendered);
      assert.deepEqual(replayed.find(item => item.type === "compaction"), opaque);
      assert.equal(replayed.find(item => item.type === "function_call_output")?.output, JSON.stringify({ marker }));
      assert.equal(finalized, 1, "commit and recovery do not need the old marker registry");
      assert.equal(textFrom(finalOutput), "记得：" + marker + "【依据：https://fixture.invalid/source】",
        "local finalization must not mutate the provider response or evidence");
    } finally {
      await runtime?.close(); await recovered?.close(); await rm(root, { recursive: true, force: true });
    }
  });
}

for (const fallback of ["output_text", "streamed-delta"] as const) {
  test("SIWC persists rendered final text when completion uses " + fallback, async () => {
    const root = await mkdtemp(join(tmpdir(), "siwc-fallback-finalize-"));
    const events = fallback === "output_text"
      ? [{ type: "response.completed", response: { id: "fallback", output_text: marker } }]
      : [{ type: "response.output_text.delta", delta: marker },
        { type: "response.completed", response: { id: "fallback", output: [] } }];
    const socket = new FixtureSocket([events]);
    const runtime = await runtimeFixture(root, new StatefulResponsesBridge(root, () => socket));
    let finalized = 0;
    try {
      const result = await runtime.reply({ purpose: "chat", sessionId, stateful: true, text: "引用刚才",
        finalizeReplyText(text) { finalized++; return text.replace(marker, quote); },
      });
      assert.equal(result.text, quote); assert.equal(finalized, 1);
      assert.equal(assistantText((await new LaneStore(root).read(sessionId))!.contextItems), quote);
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("SIWC generic SDK response finalizes locally once without sending the callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "siwc-sdk-finalize-"));
  let finalized = 0, calls = 0;
  const runtime = await runtimeFixture(root, undefined, async options => {
    calls++;
    assert.equal((options as Record<string, unknown>).finalizeReplyText, undefined);
    assert.equal(options.instructions, "规则 " + marker);
    return { text: marker };
  });
  try {
    const result = await runtime.reply({ purpose: "diagnostic", sessionId, text: "问候", instructions: "规则 " + marker,
      finalizeReplyText(text) { finalized++; return text.replace(marker, quote); },
    });
    assert.equal(result.text, quote); assert.equal(finalized, 1); assert.equal(calls, 1);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("SIWC captures text between multiple function calls and empty live context has no wrapper",async()=>{
  const {VoiceTurn,voiceTool}=await import("../../voice/tool.js");
  const {replyText}=await import("../reply-segments.js");
  const root=await mkdtemp(join(tmpdir(),"siwc-ordered-")),turn=new VoiceTurn(true);
  const message=(text:string)=>({type:"message",role:"assistant",content:[{type:"output_text",text}]});
  const voice=(id:string,text:string)=>({type:"function_call",call_id:id,namespace:"gateway",name:"send_voice",arguments:JSON.stringify({text,instruction:"清晰自然"})});
  const socket=new FixtureSocket([
    completed("ordered-one",[message("（动作说明）\n先说一句"),voice("v1","第一段"),message("中间文字"),voice("v2","第二段")]),
    completed("ordered-two",[message("最后文字")]),
  ]);
  const runtime=await runtimeFixture(root,new StatefulResponsesBridge(root,()=>socket));
  try{
    const result=await runtime.reply({purpose:"chat",sessionId:"ordered",text:"你好",stateful:true,tools:[voiceTool],context:{controlRevision:"c",contextRevision:"c",content:"{}"},
      instructions:"测试规则",recordReplyText:(text,id)=>turn.recordText(text,id),finalizeReplyText:text=>turn.finalize(text),
      getPreparedVoice:()=>turn.text,getPreparedReplySegments:()=>turn.segments,executeTool:async(_name,args)=>turn.select(args)});
    assert.deepEqual(result.replySegments?.map(p=>p.kind),["stage_direction","text","voice","text","voice","text"]);
    assert.equal(replyText(result.replySegments!),"（动作说明）\n\n先说一句\n\n第一段\n\n中间文字\n\n第二段\n\n最后文字");
    assert.doesNotMatch(JSON.stringify(socket.sent[0]),/当前实时内容数据/);
    assert.ok((socket.sent[0]!.tools as any[]).some(t=>t.type==="web_search"));
  }finally{await runtime.close();await rm(root,{recursive:true,force:true});}
});
