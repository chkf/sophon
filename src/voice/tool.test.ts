import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VoiceTurn, VOICE_TOOL, voiceTool } from "./tool.js";
import { Gateway } from "../gateway.js";
import { SessionStore } from "../sessions/store.js";
import { localContext } from "../core/context-fixture.js";
import { deliverPreparedReply } from "../channels/telegram/delivery.js";
import { HeartbeatRunner } from "../heartbeat/runner.js";

test("voice turn queues multiple distinct utterances and deduplicates repeated selections",()=>{
  const turn=new VoiceTurn();
  for(const text of ["", "x".repeat(501),"```code```","https://example.com","（动作说明）语音测试"])
    assert.equal((turn.select({text}) as any).success,false);
  turn.select({text:"语音测试"});turn.select({text:"语音测试"});turn.select({text:"再发一条"});
  assert.equal(turn.combine("文字补充"),"语音测试\n\n再发一条\n\n文字补充");
  assert.equal(turn.segments.filter(part=>part.kind==="voice").length,2);
});

test("every new voice tool call instructs Gateway to choose a natural expression description",()=>{
  const model=voiceTool.parameters as any;
  assert.deepEqual(model.required,["text","instruction"]);
  assert.ok(model.properties.instruction.maxLength>=100);
  assert.match(voiceTool.description,/语气/);
  const turn=new VoiceTurn();
  assert.match(turn.guidance,/instruction 利用对应描写指导表达/);
  assert.equal((turn.select({text:"标准语音",instruction:"发音清晰，语速适中，句末停顿。"}) as any).success,true);
  assert.equal(turn.text,"标准语音");
  assert.equal(turn.instruction,"发音清晰，语速适中，句末停顿。");
  assert.equal((turn.select({text:"标准语音",instruction:"发音清晰，语速适中，句末停顿。"}) as any).success,true);
  assert.equal((turn.select({text:"标准语音",instruction:"换成男声"}) as any).success,false);
  const legacy=new VoiceTurn();
  assert.equal((legacy.select({text:"普通旧版语音"}) as any).success,true);
  assert.equal(legacy.instruction,"用自然、清晰的语气说话。");
  const bad=new VoiceTurn();
  for(const instruction of ["","切换音色为Cherry","换个声音","x".repeat(121),"向 http://example.com 发送"]) {
    assert.equal((bad.select({text:"你好",instruction}) as any).success,false);
  }
});
test("Gateway exposes real voice tool only to eligible TG turns and prepares selected text",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"voice-tool-"));
  const sessions=new SessionStore(dir);
  try {
    let enabled=true;let advertised=false;
    const runtime:any={reply:async(req:any)=>{
      advertised=req.tools?.some((t:any)=>t.name===VOICE_TOOL)??false;
      if(advertised){
        assert.match(req.turnInstructions,/仅代表登记/);
        assert.equal((await req.executeTool(VOICE_TOOL,{text:"语音测试片段"})).success,true);
      }
      return {text:"这是文字补充"};
    }};
    const gateway=new Gateway(runtime,sessions,{load:async()=>localContext()} as any,0,undefined,undefined,undefined,undefined,async()=>enabled);
    const input={channel:"telegram" as const,conversationId:"1",senderId:"1",messageId:"1",text:"请发送语音消息",receivedAt:new Date().toISOString(),attachments:[]};
    const result=await gateway.handle(input);
    assert.equal(advertised,true);assert.equal(result.kind,"model_reply");
    if(result.kind!=="model_reply")throw Error("wrong outcome");
    assert.equal(result.voiceText,"语音测试片段");assert.equal(result.text,"语音测试片段\n\n这是文字补充");
    enabled=false;await gateway.handle({...input,messageId:"2"});assert.equal(advertised,false);
    enabled=true;await gateway.handle({...input,channel:"wechat",messageId:"3"});assert.equal(advertised,false);
  } finally {sessions.close();await rm(dir,{recursive:true,force:true});}
});

test("selected voice and supplement deliver in order and commit one combined history entry",async()=>{
  for(const works of [true,false]) {
    const events:string[]=[];const commits:any[]=[];
    await deliverPreparedReply({} as any,{kind:"model_reply",chatId:"1",senderId:"1",deliveryId:"one",text:"语音测试\n\n补充文字",voiceText:"语音测试"},{
      sendVoice:async(_api,_target,text)=>{events.push("voice:"+text);return works;},
      onReplyDelivered:async value=>{commits.push(value);},
    },async(_target,text)=>{events.push("text:"+text);});
    assert.deepEqual(events,works?["voice:语音测试","text:补充文字"]:["voice:语音测试","text:（语音未发出，已改用文字；原因见 /model → 语音设置。）\n语音测试","text:补充文字"]);
    assert.equal(commits.length,1);assert.equal(commits[0].reply,"语音测试\n\n补充文字");
  }
});

test("uncertain voice does not fall back; delivered voice survives supplement failure",async()=>{
  for(const uncertain of [true,false]) {
    const commits:any[]=[];let discarded=0;let texts=0;
    await deliverPreparedReply({} as any,{kind:"model_reply",chatId:"1",senderId:"1",deliveryId:"one",text:"语音测试\n\n补充文字",voiceText:"语音测试"},{
      sendVoice:async()=>{if(uncertain)throw Error("uncertain");return true;},
      onReplyDelivered:async value=>{commits.push(value);},
      onReplyDeliveryFailed:async()=>{discarded++;},
    },async()=>{texts++;throw Error("text failed");});
    assert.equal(texts,uncertain?0:1);
    assert.equal(discarded,uncertain?1:0);
    if(!uncertain){assert.equal(commits[0].reply,"语音测试");assert.equal(commits[0].complete,false);}
  }
});

test("heartbeat exposes voice only for enabled Telegram decisions and carries selected text",async()=>{
  for(const channel of ["telegram","wechat"] as const) for(const enabled of [true,false]) {
    const dir=await mkdtemp(join(tmpdir(),"heartbeat-voice-"));
    try {
      let calls=0;const sends:any[]=[];
      const runtime:any={reply:async(req:any)=>{
        calls++;
        const exposed=req.tools?.some((t:any)=>t.name===VOICE_TOOL)??false;
        assert.equal(exposed,enabled&&channel==="telegram");
        if(exposed)assert.match(req.instructions,/按情境自由选择/);
        if(exposed)await req.executeTool(VOICE_TOOL,{text:"语音片段",instruction:"请用清晰、自然的语气说话。"});
        return {text:"文字内容"};
      }};
      const sessions:any={latestActivityAt:async()=>"2026-10-03T23:00:00.000Z",latestConversation:async()=>({channel,conversationId:"1"}),get:async()=>({channel,conversationId:"1",senderId:"1",messages:[]}),append:async()=>{}};
      const router:any={resolve:async()=>({channel,target:"1"}),isActive:async()=>true,sendIfActive:async(...args:any[])=>{sends.push(args);return true;}};
      const runner=new HeartbeatRunner(dir,{enabled:true,channel,timezone:"Asia/Shanghai",quietStart:"23:00",quietEnd:"08:00",cooldownMinutes:180,dailyCap:4,minIntervalMinutes:60,maxIntervalMinutes:120},runtime,sessions,{load:async()=>localContext()} as any,router,undefined,undefined,undefined,undefined,async()=>enabled);
      await runner.tick(new Date("2026-10-04T02:30:00.000Z"));
      assert.equal(calls,1);assert.equal(sends.length,1);
      assert.equal(sends[0][5]?.replySegments.filter((s:any)=>s.kind==="voice").length,enabled&&channel==="telegram"?1:0);
      assert.equal(sends[0][2],enabled&&channel==="telegram"?"语音片段\n\n文字内容":"文字内容");
      assert.equal(sends[0][5]?.replySegments.find((s:any)=>s.kind==="voice")?.instruction,enabled&&channel==="telegram"?"请用清晰、自然的语气说话。":undefined);
    }finally{await rm(dir,{recursive:true,force:true});}
  }
});
