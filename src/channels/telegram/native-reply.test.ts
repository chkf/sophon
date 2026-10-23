import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deliverPreparedReply, TelegramDelivery } from "./delivery.js";
import { mergeBufferedBatch } from "./input-buffer.js";
import { TelegramAdapter } from "./adapter.js";
import { TelegramStateStore } from "./state-store.js";
import type { TelegramApiClient } from "./types.js";
import type { TelegramNativeReply } from "../types.js";

const ACCOUNT="telegram-bot:2468";
const quote:TelegramNativeReply={channel:"telegram",chatId:"123",accountId:ACCOUNT,messageId:30};
const pending=(text:string)=>({kind:"model_reply" as const,text,deliveryId:"native-delivery",senderId:"123",
  chatId:"123",nativeReply:quote});
function fixture() {
  const requests: {method:string;body:Record<string,unknown>}[]=[];
  let seq=800;
  const api:TelegramApiClient={
    async call<T>(method,body){requests.push({method,body});
      return (method==="sendMessage" || method==="sendPhoto" || method==="sendVoice"
        ? {message_id:seq++} : true) as T;},
    async getFile(){throw new Error("not needed");},
    async downloadFile(){throw new Error("not needed");},
  };
  return {requests,api};
}
test("real message fragments survive the TG debounce batch with exact IDs",()=>{
  const p=(id:string,text:string)=>({messageId:id,text,receivedAt:"2026-10-22T10:00:00Z",attachments:[],
    platformMessage:{accountId:ACCOUNT,conversationId:"123",direction:"inbound" as const,messageId:id,text}});
  const result=mergeBufferedBatch({chatId:"123",senderId:"123",lastReceivedAtMs:1,parts:[p("20","一"),p("21","二")]});
  assert.equal(result.messageId,"20-21"); // this is not a platform message ID
  assert.deepEqual(result.platformMessages?.map(x=>x.messageId),["20","21"]);
  assert.equal(result.platformMessages?.[0]?.text,"一");
});
test("first TG text bubble alone uses Bot API reply_parameters and persists segment IDs",async()=>{
  const f=fixture();const delivered:any[]=[];
  await deliverPreparedReply(f.api,pending("你好\n\n第二条消息"),{
    async onReplyDelivered(event){delivered.push(event);}
  },async(target,text,onSent,reply,strict)=>{
    await new TelegramDelivery(f.api).sendTextCollectMessageIds(target,text,
      onSent?(id,chunk)=>onSent(chunk,id):undefined,reply ? {message_id:reply.messageId,allow_sending_without_reply:true}:undefined,strict);
  },ACCOUNT);
  const texts=f.requests.filter(x=>x.method==="sendMessage");
  assert.equal(texts.length,2);
  assert.deepEqual(texts[0]!.body.reply_parameters,{message_id:30,allow_sending_without_reply:true});
  assert.equal(texts[1]!.body.reply_parameters,undefined);
  assert.deepEqual(delivered[0].platformMessages.map((x:any)=>x.messageId),["800","801"]);
  assert.deepEqual(delivered[0].platformMessages.map((x:any)=>x.text),["你好","第二条消息"]);
});
test("different bot or different chat leaves normal reply text and never leaks target",async()=>{
  for(const bad of [{...quote,accountId:"telegram-bot:9"},{...quote,chatId:"999"}]){
    const f=fixture();
    await deliverPreparedReply(f.api,{...pending("正常回答"),nativeReply:bad},{},
      async(target,text,onSent,reply)=>{assert.equal(reply,undefined);
        await new TelegramDelivery(f.api).sendTextCollectMessageIds(target,text);},ACCOUNT);
    assert.equal(f.requests[0]!.body.reply_parameters,undefined);
  }
});
test("a voice bubble carries native reply, while its text supplement is unquoted",async()=>{
  const f=fixture(),sent:any[]=[];
  await deliverPreparedReply(f.api,{...pending("语音测试\n\n补充文字"),voiceText:"语音测试"},{
    async sendVoice(_api,_chat,text,_id,reply,onSent){
      assert.equal(text,"语音测试");assert.equal(reply?.messageId,30);
      onSent?.(900);return true;
    },
    async onReplyDelivered(e){sent.push(e);}
  },async(target,text,onSent,reply)=>{
    assert.equal(reply,undefined);
    await new TelegramDelivery(f.api).sendTextCollectMessageIds(target,text,onSent?(id,chunk)=>onSent(chunk,id):undefined);
  },ACCOUNT);
  assert.equal(sent[0].reply,"语音测试\n\n补充文字");
  assert.deepEqual(sent[0].platformMessages.map((x:any)=>x.messageId),["900","800"]);
});
test("known TTS failure keeps quote on first plain-text fallback, and uncertain voice does not replay",async()=>{
  const f=fixture();
  await deliverPreparedReply(f.api,{...pending("语音测试"),voiceText:"语音测试"},{
    async sendVoice(){return false;}
  },async(target,text,onSent,reply,strict)=>{
    assert.equal(reply?.messageId,30);
    await new TelegramDelivery(f.api).sendTextCollectMessageIds(target,text,
      onSent?(id,chunk)=>onSent(chunk,id):undefined,{message_id:30,allow_sending_without_reply:true},strict);
  },ACCOUNT);
  assert.equal(f.requests.filter(x=>x.method==="sendMessage").length,1);
  assert.deepEqual(f.requests.find(x=>x.method==="sendMessage")?.body.reply_parameters,{message_id:30,allow_sending_without_reply:true});
  let sent=0, failed=0;
  await deliverPreparedReply(f.api,{...pending("消息"),voiceText:"消息"},{
    async sendVoice(){throw new Error("lost acknowledgement");},
    async onReplyDeliveryFailed(){failed++;}
  },async()=>{sent++},ACCOUNT);
  assert.equal(sent,0);assert.equal(failed,1);
});
test("partial TG sends keep acknowledged IDs only; no replay after interrupted network send",async()=>{
  const f=fixture(),commit:any[]=[];
  const first=new TelegramDelivery({
    ...f.api,
    async call<T>(method,body){if(method==="sendMessage" && body.text==="第二段")throw new Error("timeout");
      return f.api.call<T>(method,body);}
  });
  await deliverPreparedReply(f.api,pending("第一段\n\n第二段"),{
    async onReplyDelivered(e){commit.push(e);}
  },async(target,text,onSent,reply,strict)=>{
    await first.sendTextCollectMessageIds(target,text,onSent?(id,chunk)=>onSent(chunk,id):undefined,
      reply?{message_id:reply.messageId,allow_sending_without_reply:true}:undefined,strict);
  },ACCOUNT);
  assert.equal(commit.length,1);assert.equal(commit[0].complete,false);
  assert.equal(commit[0].reply,"第一段");
  assert.deepEqual(commit[0].platformMessages.map((x:any)=>x.messageId),["800"]);
});
test("prepared native target survives TG state-file restart without persisting model tool state",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"gateway-tg-native-"));
  try{
    const store=new TelegramStateStore(dir);
    store.state.pendingReply=pending("完成后待发送");
    await store.mutate(()=>undefined);
    const recovered=await new TelegramStateStore(dir).load();
    assert.deepEqual((recovered.pendingReply as any).nativeReply,quote);
    assert.equal((await readFile(join(dir,"channels","telegram.json"),"utf8")).includes("gateway_quote"),false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("invalid Telegram acknowledgement in native text stops further bubbles and never marks the whole reply delivered",async()=>{
  let calls=0,commits:any[]=[],failed=0;
  const api:TelegramApiClient={
    async call<T>(method:string,body:Record<string,unknown>):Promise<T>{
      if(method==="sendMessage"){calls++;return (calls===1?{message_id:810}:{}) as T;}
      if(method==="sendChatAction")return true as T;
      throw new Error("unexpected API: "+method+" "+JSON.stringify(body));
    },
    async getFile(){throw new Error("not needed");},
    async downloadFile(){throw new Error("not needed");}
  };
  await deliverPreparedReply(api,pending("第一段\n\n第二段"),{
    async onReplyDelivered(e){commits.push(e);},async onReplyDeliveryFailed(){failed++;}
  },async(target,text,onSent,reply,strict)=>{
    await new TelegramDelivery(api).sendTextCollectMessageIds(target,text,
      onSent?(id,chunk)=>onSent(chunk,id):undefined,
      reply?{message_id:reply.messageId,allow_sending_without_reply:true}:undefined,strict);
  },ACCOUNT);
  assert.equal(calls,2);
  assert.equal(failed,0);
  assert.equal(commits.length,1);
  assert.equal(commits[0].complete,false);
  assert.equal(commits[0].reply,"第一段");
  assert.deepEqual(commits[0].platformMessages.map((x:any)=>x.messageId),["810"]);
});
test("native first bubble without message_id never sends follow-up or commits a fake successful reply",async()=>{
  let attempts=0,failures=0,commits=0;
  const api:TelegramApiClient={
    async call<T>(method:string):Promise<T>{
      if(method==="sendMessage"){attempts++;return {} as T;}
      if(method==="sendChatAction")return true as T;
      throw new Error("unexpected API: "+method);
    },
    async getFile(){throw new Error("not needed");},
    async downloadFile(){throw new Error("not needed");}
  };
  await deliverPreparedReply(api,pending("第一段\n\n第二段"),{
    async onReplyDelivered(){commits++;},async onReplyDeliveryFailed(){failures++;}
  },async(target,text,onSent,reply,strict)=>{
    await new TelegramDelivery(api).sendTextCollectMessageIds(target,text,
      onSent?(id,chunk)=>onSent(chunk,id):undefined,
      reply?{message_id:reply.messageId,allow_sending_without_reply:true}:undefined,strict);
  },ACCOUNT);
  assert.equal(attempts,1);
  assert.equal(commits,0);
  assert.equal(failures,1);
});
