import assert from "node:assert/strict";
import test from "node:test";
import type { InboundMessage, PlatformMessageFragment } from "../channels/types.js";
import { historyFromMessages } from "./history.js";
import { NativeReplyTurn, safeTelegramMessageId, telegramAccountId,
  nativeReplyParameters, stripLegacyQuoteTokens, NATIVE_REPLY_TOOL } from "./native-reply.js";

const ACCOUNT = "telegram-bot:2468";
const peer = "123";
const fragment = (id: string, text: string, direction: "inbound"|"outbound"="inbound",
  accountId=ACCOUNT, conversationId=peer): PlatformMessageFragment =>
  ({accountId,conversationId,direction,messageId:id,text});
const current = (...parts:PlatformMessageFragment[]): InboundMessage =>
  ({channel:"telegram",conversationId:peer,senderId:peer,messageId:"bundle",
    receivedAt:"2026-10-22T10:00:00Z",text:parts.map(x=>x.text).join("\n"),
    attachments:[],platformMessages:parts});
const history = (items:any[]=[])=> historyFromMessages(items);

test("TG bot identity comes only from real token prefix, not secret or owner guess",()=>{
  assert.equal(telegramAccountId("2468:random-secret"),ACCOUNT);
  assert.equal(telegramAccountId("broken"),undefined);
  assert.equal(telegramAccountId("2468:with:colon"),undefined);
  for(const id of ["0","1.0","1e2","-1","9999999999999999999","123-124"])
    assert.equal(safeTelegramMessageId(id),undefined);
  assert.equal(safeTelegramMessageId("2147483647"),2147483647);
});
test("native current target uses the real incoming message ID, never the batch ID",async()=>{
  const turn=new NativeReplyTurn(history(),current(fragment("902","我刚才说的。")));
  assert.equal(turn.enabled,true);
  assert.equal(NATIVE_REPLY_TOOL,"gateway_reply_native");
  assert.deepEqual(await turn.select({target:"current"}),{status:"selected",role:"user",target:"current",fragment_index:0,note:"已登记原生回复目标；发送前不承诺已送达。"});
  assert.equal(turn.prepared?.messageId,902);
  assert.deepEqual(nativeReplyParameters(turn.prepared,peer,ACCOUNT),
    {message_id:902,allow_sending_without_reply:true});
  assert.equal(nativeReplyParameters(turn.prepared,"999",ACCOUNT),undefined);
  assert.equal(nativeReplyParameters(turn.prepared,peer,"telegram-bot:99"),undefined);
});
test("Telegram merged input requires an explicit fragment and validates a partial quote",async()=>{
  const turn=new NativeReplyTurn(history(),current(fragment("100","第一条"),fragment("101","最后一条关于太阳")));
  assert.equal((await turn.select({target:"current"}) as any).status,"ambiguous");
  await turn.select({target:"current",fragment_index:1,quote:"太阳"});
  assert.deepEqual(nativeReplyParameters(turn.prepared,peer,ACCOUNT),
    {message_id:101,quote:"太阳",allow_sending_without_reply:true});
  await assert.rejects(turn.select({target:"current",fragment_index:0}),/只能选择一个/);
});
test("historic TG user and confirmed assistant fragments are both selectable",async()=>{
  const entries=[
    {role:"user",content:"旧用户输入",source:{channel:"telegram",platformMessages:[fragment("9","旧用户输入")]}},
    {role:"assistant",content:"分两条发出",partial:true,source:{channel:"telegram",platformMessages:[
      fragment("78","第一段","outbound"),fragment("79","第二段","outbound")]}},
  ];
  const turnA=new NativeReplyTurn(history(entries),current(fragment("100","回答一下")));
  await turnA.select({target:"history",index:0});
  assert.equal(turnA.prepared?.messageId,9);
  const turnB=new NativeReplyTurn(history(entries),current(fragment("100","回答一下")));
  assert.equal((await turnB.select({target:"history",index:1}) as any).status,"ambiguous");
  const selected=await turnB.select({target:"history",index:1,fragment_index:1});
  assert.equal((selected as any).role,"assistant");
  assert.equal(turnB.prepared?.messageId,79);
});
test("cross-channel, cross-chat and different bot are never native reply targets",async()=>{
  const cases=[
    {role:"user",content:"来自微信",source:{channel:"wechat",platformMessages:[fragment("10","微信")]}},
    {role:"assistant",content:"另一个 bot",source:{channel:"telegram",platformMessages:[fragment("11","不行","outbound","telegram-bot:999")]}},
    {role:"user",content:"另一个私聊",source:{channel:"telegram",platformMessages:[fragment("12","不行","inbound",ACCOUNT,"999")]}},
    {role:"assistant",content:"旧历史没平台 ID",source:{channel:"telegram",messageId:"internal-delivery"}},
  ];
  const turn=new NativeReplyTurn(history(cases),current(fragment("100","你好")));
  for(let index=0;index<cases.length;index++) await assert.rejects(turn.select({target:"history",index}));
  assert.equal(turn.prepared,undefined);
  assert.equal(new NativeReplyTurn(history(cases),{...current(fragment("100","文字")),channel:"wechat"}).enabled,false);
});
test("role direction cannot be spoofed via a saved historical fragment",async()=>{
  const cases=[{role:"assistant",content:"旧话",source:{channel:"telegram",platformMessages:[fragment("32","旧话","inbound")]}}];
  await assert.rejects(new NativeReplyTurn(history(cases),current(fragment("41","新消息"))).select({target:"history",index:0}));
});
test("caller cannot supply message ID, owner, account or another conversation",async()=>{
  const turn=new NativeReplyTurn(history(),current(fragment("100","消息")));
  for(const args of [
    {target:"current",message_id:999}, {target:"current",chatId:"other"},
    {target:"current",accountId:ACCOUNT}, {target:"current",index:0},
    {target:"history",index:"0"}, {target:"history",index:-1},
    {target:"history",index:0,ownerId:"123"},
  ]) await assert.rejects(turn.select(args as any));
  assert.equal(turn.prepared,undefined);
});
test("quoted substring must match exactly, never synthesized from earlier chat text",async()=>{
  const turn=new NativeReplyTurn(history(),current(fragment("200","A  b\n你好🙂")));
  for(const quote of ["A b","你好!","x".repeat(1025)," "])
    await assert.rejects(turn.select({target:"current",quote}));
  const valid=await turn.select({target:"current",quote:"你好🙂"});
  assert.equal((valid as any).status,"selected");
});
test("old pending cannot select a guessed platform ID",async()=>{
  const turn=new NativeReplyTurn(history([{role:"user",content:"以前说的",source:{channel:"telegram",messageId:"400-401"}}]),
    current(fragment("100","后续")));
  await assert.rejects(turn.select({target:"history",index:0}),/映射/);
});
test("retired text quote controls are removed from freshly generated output only",()=>{
  const marker="[[gateway_quote:"+"a".repeat(32)+"]]";
  assert.equal(stripLegacyQuoteTokens("正常讨论旧话"),"正常讨论旧话");
  assert.equal(stripLegacyQuoteTokens("正文"+marker),"正文");
  assert.match(stripLegacyQuoteTokens(marker),/原生引用暂不可用/);
});

test("a stored TG fragment from another owner is rejected even when bot and chat strings match",async()=>{
  const turn=new NativeReplyTurn(history([{
    role:"assistant",content:"伪造的其他所有者记录",
    source:{channel:"telegram",senderId:"456",platformMessages:[fragment("70","内容","outbound")]}
  }]),current(fragment("90","当前聊天")));
  await assert.rejects(turn.select({target:"history",index:0}),/不是本 TG 会话/);
  assert.equal(turn.prepared,undefined);
});
