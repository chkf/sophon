import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "./gateway.js";
import { localContext } from "./core/context-fixture.js";
import { SessionStore } from "./sessions/store.js";
import type { InboundMessage } from "./channels/types.js";
import type { ChatRuntime, ChatRequest } from "./runtime/types.js";

const account="telegram-bot:2468";
const inbound=(id:string,text:string,channel:"telegram"|"wechat"="telegram"):InboundMessage=>({
  channel,conversationId:"123",senderId:"123",messageId:id,text,
  receivedAt:"2026-10-22T10:00:00Z",attachments:[],
  ...(channel==="telegram"?{platformMessages:[{accountId:account,conversationId:"123",
    direction:"inbound" as const,messageId:id,text}]}:{})
});
async function fixture(run:(gateway:Gateway,store:SessionStore)=>Promise<void>,runtime:ChatRuntime) {
  const root=await mkdtemp(join(tmpdir(),"tg-native-gateway-"));const store=new SessionStore(root);
  try{const gateway=new Gateway(runtime,store,{load:async()=>localContext()} as never); await run(gateway,store);}
  finally{store.close();await rm(root,{recursive:true,force:true});}
}

test("Gateway exposes only native reply selection in TG and hands the verified target to prepared model reply",()=>fixture(
  async(gateway,store)=>{
    const result=await gateway.handle(inbound("40","请引用我这条消息"));
    assert.equal(result.kind,"model_reply");
    if(result.kind!=="model_reply")return;
    assert.deepEqual(result.nativeReply,{channel:"telegram",accountId:account,chatId:"123",messageId:40});
    assert.equal(result.text,"我会引用这条消息。");
    const saved=(await store.get("telegram","123"))?.messages[0];
    assert.deepEqual(saved?.source?.platformMessages?.map(x=>x.messageId),["40"]);
  },
  {reply:async(req:ChatRequest)=>{
    assert.equal(req.tools?.some(x=>x.name==="gateway_quote_message") ?? false,false);
    assert.equal(req.tools?.some(x=>x.name==="gateway_reply_native"),true);
    await assert.rejects(req.executeTool!("gateway_quote_message",{target:"current"}));
    const selected=await req.executeTool!("gateway_reply_native",{target:"current"}) as {status:string};
    assert.equal(selected.status,"selected");
    return {text:"我会引用这条消息。",nativeReply:req.getPreparedNativeReply?.()};
  }}
));
test("Gateway selects a previously delivered assistant TG bubble by actual platform ID",()=>fixture(
  async(gateway,store)=>{
    await store.append("telegram","123","123",[{role:"user",at:"2026-10-22T09:00:00Z",content:"你好",
      source:{channel:"telegram",senderId:"123",messageId:"3",platformMessages:[
        {accountId:account,conversationId:"123",direction:"inbound",messageId:"3",text:"你好"}]}}]);
    await store.append("telegram","123","123",[{role:"assistant",at:"2026-10-22T09:01:00Z",content:"上一条回复",
      source:{channel:"telegram",senderId:"123",messageId:"internal-delivery",platformMessages:[
        {accountId:account,conversationId:"123",direction:"outbound",messageId:"400",text:"上一条回复"}]}}]);
    const result=await gateway.handle(inbound("41","回复你上次说的"));
    assert.equal(result.kind,"model_reply");
    if(result.kind==="model_reply")assert.equal(result.nativeReply?.messageId,400);
  },{reply:async(req)=>{
    const selected=await req.executeTool!("gateway_reply_native",{target:"history",index:1}) as {status:string};
    assert.equal(selected.status,"selected");
    return {text:"当然。"};
  }}
));
test("WeChat retains history but never advertises a fake native reply or text quote tool",()=>fixture(
  async(gateway)=>{
    const result=await gateway.handle(inbound("49","请引用", "wechat"));
    assert.equal(result.kind,"model_reply");
    if(result.kind==="model_reply") {
      assert.equal(result.nativeReply,undefined);
      assert.equal(result.text,"目前不能以原生样式引用。");
    }
  },{reply:async(req)=>{
    assert.equal(req.tools?.some(x=>x.name==="gateway_reply_native") ?? false,false);
    assert.equal(req.tools?.some(x=>x.name==="gateway_quote_message") ?? false,false);
    return {text:"目前不能以原生样式引用。"};
  }}
));
test("Old marker is stripped only from newly completed text; incoming/history remains unchanged",()=>fixture(
  async(gateway,store)=>{
    const result=await gateway.handle(inbound("51","我写了 [[gateway_quote:0123456789abcdef0123456789abcdef]]"));
    assert.equal(result.kind,"model_reply");
    if(result.kind==="model_reply")assert.equal(result.text,"正文");
    assert.match((await store.get("telegram","123"))!.messages[0]!.content,/gateway_quote/);
  },{reply:async(req)=>({text:req.finalizeReplyText?.("正文[[gateway_quote:0123456789abcdef0123456789abcdef]]")??""})}
));
