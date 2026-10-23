import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceTurn } from "../voice/tool.js";
import { displayText, replyText, spokenText, visibleSegments, type ReplySegment } from "./reply-segments.js";
import { deliverPreparedReply } from "../channels/telegram/delivery.js";
import { TelegramAdapter } from "../channels/telegram/adapter.js";
import { Gateway } from "../gateway.js";
import { SessionStore } from "../sessions/store.js";
import { localContext } from "../core/context-fixture.js";
import { readHistoryTool } from "./history-tool.js";
import { renderOutputTextPart } from "./siwc/responses-codec.js";
import { replyWithPaidImages } from "./image-decorator.js";
import { HeartbeatRunner } from "../heartbeat/runner.js";

const parts: ReplySegment[]=[{kind:"stage_direction",text:"（查看文档）"},{kind:"text",text:"先说一句"},
  {kind:"voice",text:"第一段",instruction:"语速适中、表达清晰"},{kind:"text",text:"中间文字"},
  {kind:"voice",text:"第二段",instruction:"语速较慢、吐字清晰"},{kind:"text",text:"最后文字"}];
async function temp(run:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),"ordered-reply-"));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}

test("hidden nested, multiline and incomplete stage directions do not become speech or fallback text",()=>{
  assert.equal(displayText("（动作（翻页））\n你好\n（补充说明：\n示例内容）\n再见",false),"你好\n\n再见");
  assert.equal(displayText("你好（未闭合说明",false),"你好");
  assert.equal(spokenText("（动作说明）你好（停顿）再见"),"你好 再见");
  assert.equal(spokenText("f(x)"),"f(x)");
  assert.equal(visibleSegments(parts,false).some(p=>p.kind==="stage_direction"),false);
  assert.deepEqual(visibleSegments([{kind:"stage_direction",text:"PRIVATE_WITHOUT_BRACKETS"}],false),[]);
  const turn=new VoiceTurn(false);
  turn.recordText("（测试动作）\n前文","one");turn.recordText("（测试动作）\n前文","one");
  turn.select({text:"第一段",instruction:"自然语气"});
  assert.equal(turn.combine("第一段\n\n（隐藏说明）\n末尾"),"前文\n\n第一段\n\n末尾");
  assert.doesNotMatch(JSON.stringify(turn.segments),/隐藏说明/);
});

for(const second of ["success","failure","uncertain"] as const) test("ordered fragments preserve delivery progress: "+second,async()=>{
  const events:string[]=[],commits:any[]=[],ids:string[]=[];
  await deliverPreparedReply({} as any,{kind:"model_reply",chatId:"1",senderId:"1",deliveryId:"delivery",replySegments:parts,text:replyText(parts)}, {
    showStageDirections:async()=>false,
    sendVoice:async(_api,_chat,text,id,_reply,onSent,instruction)=>{
      events.push("voice:"+text);ids.push(id);assert.ok(instruction);
      if(text==="第二段"&&second==="uncertain")throw Error("unknown send");
      if(text==="第二段"&&second==="failure")return false;
      onSent?.(ids.length+10);return true;
    },onReplyDelivered:event=>{commits.push(event);},
  },async(_chat,text,onSent)=>{events.push("text:"+text);onSent?.(text,events.length);});
  assert.deepEqual(events,["text:先说一句","voice:第一段","text:中间文字","voice:第二段",...(second==="failure"?["text:第二段"]:[]),...(second==="uncertain"?[]:["text:最后文字"])]);
  assert.equal(new Set(ids).size,2);assert.equal(commits.length,1);assert.doesNotMatch(commits[0].reply,/查看文档/);
  if(second==="uncertain"){assert.equal(commits[0].complete,false);assert.equal(commits[0].reply,"先说一句\n\n第一段\n\n中间文字");}
});

test("proactive adapter delivers multiple voices with stable distinct paid-attempt IDs",()=>temp(async root=>{
  const events:string[]=[],ids:string[]=[];
  const adapter=new TelegramAdapter({token:"fixture",ownerId:"1",dataDir:root,mediaStore:{} as any,
    showStageDirections:async()=>false,api:{call:async(method:string,body:any)=>{if(method==="sendMessage")events.push("text:"+body.text);return {message_id:events.length};}} as any,
    sendProactiveVoice:async(_api,_target,text,_instruction,id)=>{ids.push(id!);events.push("voice:"+text);return text!=="第二段";}});
  await adapter.sendProactiveText("1",replyText(parts),undefined,{deliveryId:"hb",at:new Date().toISOString(),replySegments:parts});
  assert.deepEqual(events,["text:先说一句","voice:第一段","text:中间文字","voice:第二段","text:第二段","text:最后文字"]);
  assert.equal(new Set(ids).size,2);assert.ok(ids.every(id=>id.startsWith("hb:segment:")));
}));

test("Gateway hidden stage directions are absent from delivered shared history and history search",()=>temp(async root=>{
  const sessions=new SessionStore(root);await sessions.bindOwnerSession("1","wx");
  const context=localContext();context.data!.persona={active:"custom",presets:{custom:["CLEAR"]},showStageDirections:false};
  const gateway=new Gateway({reply:async request=>{
    assert.match(request.instructions!,/【表达风格】当前模式：custom/);
    assert.match(request.instructions!,/不要自行添加角色经历或内心独白/);
    request.recordReplyText!("（PRIVATE_STAGE）\n先说一句","one");
    await request.executeTool!("send_voice",{text:"第一段",instruction:"清晰、自然表达"});
    request.recordReplyText!("中间文字","two");
    await request.executeTool!("send_voice",{text:"第二段",instruction:"平稳表达"});
    return {text:request.finalizeReplyText!("（PRIVATE_END）\n最后文字"),replySegments:request.getPreparedReplySegments!()};
  }},sessions,{load:async()=>context} as any,0,undefined,undefined,undefined,undefined,async()=>true);
  try{
    const reply=await gateway.handle({channel:"telegram",conversationId:"1",senderId:"1",messageId:"1",text:"你好",receivedAt:new Date().toISOString(),attachments:[]});
    assert.equal(reply.kind,"model_reply");if(reply.kind!=="model_reply")return;
    assert.doesNotMatch(JSON.stringify(reply),/PRIVATE/);
    assert.deepEqual(reply.replySegments?.map(p=>p.kind),["text","voice","text","voice","text"]);
    await gateway.commitDeliveredAssistant("telegram","1","1",reply.text);
    const found:any=await readHistoryTool((await sessions.view("wechat","wx")).history,{query:"PRIVATE"});
    assert.equal(found.total,0);
    assert.match((await sessions.view("wechat","wx")).tail.at(-1)!.content,/第二段/);
  }finally{sessions.close();}
}));

test("SILENT decision suppresses all staged text, voice, directions and images",()=>temp(async root=>{
  const runner=new HeartbeatRunner(root,{enabled:true,timezone:"Asia/Shanghai",quietStart:"23:00",quietEnd:"08:00",cooldownMinutes:0,dailyCap:4,minIntervalMinutes:1,maxIntervalMinutes:2},
    {reply:async request=>{request.recordReplyText!("（隐藏描写）","one");await request.executeTool!("send_voice",{text:"不应发出",instruction:"自然表达"});return {text:"SILENT",images:[{} as any]};}},
    {latestActivityAt:async()=>undefined,latestConversation:async()=>undefined} as any,{load:async()=>localContext()} as any,
    {resolve:async()=>({channel:"telegram",target:"1"}),sendIfActive:async()=>assert.fail("silent text"),sendImagesIfActive:async()=>assert.fail("silent image")} as any,
    undefined,undefined,undefined,undefined,async()=>true);
  await runner.tick(new Date("2026-10-23T04:00:00Z"));
}));


test("legacy pending voice text fallback is filtered at delivery time",async()=>{
  const sent:string[]=[];
  await deliverPreparedReply({} as any,{kind:"model_reply",chatId:"1",senderId:"1",deliveryId:"old",text:"（隐藏说明）你好",voiceText:"（隐藏说明）你好"},
    {showStageDirections:async()=>false,sendVoice:async(_api,_chat,text)=>{assert.equal(text,"你好");return false;}},
    async(_chat,text)=>{sent.push(text);});
  assert.equal(sent.length,1);assert.match(sent[0]!,/你好/);assert.doesNotMatch(sent[0]!,/隐藏说明/);
});

test("image failure notice survives ordered fragment delivery",async()=>{
  const turn=new VoiceTurn(false);
  const result=await replyWithPaidImages({reply:async request=>{
    await request.executeTool!("gateway_generate_image",{prompt:"一只猫"});
    const text=request.finalizeReplyText!("（检查结果）这次图片没出来。");
    return {text,replySegments:request.getPreparedReplySegments!()};
  }} as any,{getImageSettings:async()=>({route:"openrouter"}),canGenerateImage:async()=>true,
    generateImage:async()=>{throw Error("fixture failed");}} as any,
    {sessionId:"fixture",purpose:"chat",text:"hi",imageOutputAllowed:true,
      finalizeReplyText:text=>turn.finalize(text),getPreparedReplySegments:()=>turn.segments});
  assert.equal(result.replySegments?.[0]?.text,"本轮没有成功生成图片。");
  assert.equal(result.replySegments?.[1]?.text,"这次图片没出来。");
});


test("display filtering preserves literal code and generated source citations",()=>{
  const code='```js\nconst value = "（数据）";\n\nconsole.log(value);\n```';
  const citation=renderOutputTextPart({type:"output_text",text:"已查证",annotations:[{type:"url_citation",url:"https://fixture.invalid/source",title:"依据",end_index:3}]});
  const turn=new VoiceTurn(false);turn.finalize("（隐藏动作）\n"+code+"\n\n"+citation);
  assert.equal(turn.segments[0]?.text,code);
  assert.match(turn.segments[1]!.text,/https:\/\/fixture.invalid\/source/);
  assert.doesNotMatch(replyText(turn.segments),/隐藏动作/);
});
