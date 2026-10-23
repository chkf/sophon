import { writeLegacyPersonaFixture } from "../../../scripts/testing/persona-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IlinkAdapter } from "./adapter.js";
import { IlinkStore } from "./store.js";
import type { Binding, IlinkClient, IlinkMessage } from "./api.js";
import type { InboundMessage } from "../types.js";
import { MediaStore } from "../../media/store.js";
import { VoiceService } from "../../voice/service.js";
import { VoiceStore } from "../../voice/store.js";
import { VoiceSettingsStore } from "../../voice/settings.js";
import { SessionStore } from "../../sessions/store.js";
import { PersonaStore } from "../../persona/store.js";
import { migrateState, migrateSchema } from "../../state/migration.js";
import { SerialQueue } from "../../util/serial-queue.js";
import { createCredentialEncryption } from "../../runtime/siwc/credential-encryption.js";

const owner:Binding={token:"fixture-token",botId:"bot-a",userId:"wx-owner",baseUrl:"https://ilinkai.weixin.qq.com",telegramOwner:"123"};
const platformId="18446744073709551615";
function event(binding:Binding,id=platformId,text="account-a"):IlinkMessage {
  return {message_id:id,from_user_id:binding.userId,to_user_id:binding.botId,message_type:1,
    context_token:"fixture-context",item_list:[{type:3,voice_item:{playtime:1000,media:{encrypt_query_param:text}}}]};
}
async function fixture(run:(f:any)=>Promise<void>,central=false) {
  const base=await mkdtemp(join(tmpdir(),"ilink-voice-scope-")),root=join(base,"data");
  await mkdir(root);const key=join(base,"fixture.key");await writeFile(key,randomBytes(32).toString("base64"),{mode:0o600});
  if(central) {
    await mkdir(join(root,"core"));await writeFile(join(root,"core/core.md"),"# Synthetic Core\nFixture identity.\n");
    new SessionStore(root).close();await writeLegacyPersonaFixture(root,"formal");
    await migrateState(root,true);await migrateSchema(root,true);
  }
  const encryption=createCredentialEncryption(process.platform,key);
  const store=new IlinkStore(root,encryption),voiceStore=new VoiceStore(root),settings=new VoiceSettingsStore(root);
  await settings.update({asr:true});let attempts=0;
  const client={configured:()=>true,transcribe:async(bytes:Buffer)=>{attempts++;return bytes.toString("utf8");},
    synthesize:async()=>{throw new Error("TTS must not run");}};
  const codec={prepare:(path:string)=>readFile(path),opus:async()=>{throw new Error("TTS must not run");}};
  const speech=new VoiceService(settings,voiceStore,client,codec);
  const api:IlinkClient={qr:async()=>{throw new Error("No login");},qrStatus:async()=>{throw new Error("No login");},
    updates:async()=>({}),send:async()=>({messageId:"fixture-response"}),
    media:async item=>Buffer.from(item.voice_item?.media?.encrypt_query_param??"fixture")};
  const options={ownerId:"123",store,media:new MediaStore(join(root,"media")),queue:new SerialQueue(),api,
    bind:async()=>{},activate:async()=>{},notify:async()=>{},qrPhoto:async()=>{},delivered:async()=>{},discarded:async()=>{}};
  const adapter=new IlinkAdapter(options);
  let closed=false;
  const close=async()=>{if(closed)return;await adapter.stop();store.close();voiceStore.close();closed=true;};
  try {await run({base,root,key,encryption,store,voiceStore,settings,speech,client,codec,options,adapter,close,count:()=>attempts});}
  finally {await close();await rm(base,{recursive:true,force:true});}
}

test("new iLink voice events bind ASR cache to the bot, owner, peer and exact uint64 message",()=>fixture(async f=>{
  const seen:InboundMessage[]=[],transcripts:string[]=[];
  (f.adapter as any).handler=async(message:InboundMessage)=>{
    seen.push(structuredClone(message));transcripts.push((await f.speech.preprocess(message)).attachments[0]!.transcription!);
    return {kind:"local_reply",text:"ok"};
  };
  for(const [binding,text] of [[owner,"account-a"],[{...owner,botId:"bot-b",token:"fixture-token-b"},"account-b"]] as const) {
    await f.store.mutate((s:any)=>{s.binding=binding;});
    await f.adapter.accept([event(binding,platformId,text)],"fixture-cursor",binding);await f.adapter.flush();
  }
  assert.deepEqual(transcripts,["account-a","account-b"]);assert.equal(f.count(),2);
  assert.notEqual(seen[0]!.attachments[0]!.remoteId,seen[1]!.attachments[0]!.remoteId);
  for(const message of seen) {
    assert.equal(message.platformMessages![0]!.messageId,platformId);
    assert.equal(message.attachments[0]!.sourceMessageId,platformId+":0");
    assert.match(message.attachments[0]!.remoteId!,/^ilink:[a-f0-9]{64}$/);
    await f.speech.preprocess(message);
  }
  assert.equal(f.count(),2,"retry reuses the original persisted attempt");
  const normalize=(binding:Binding)=> (f.adapter as any).normalize({id:"batch",events:[event(binding)],firstAt:1,lastAt:1},binding);
  const variants=await Promise.all([normalize(owner),normalize({...owner,userId:"other-peer"}),normalize({...owner,telegramOwner:"456"})]);
  assert.equal(new Set(variants.map(m=>m.attachments[0].remoteId)).size,3);
}));

test("multiple voice items keep independent transcripts and IDs through batching",()=>fixture(async f=>{
  await f.store.mutate((s:any)=>{s.binding=owner;});let received:InboundMessage|undefined;
  (f.adapter as any).handler=async(message:InboundMessage)=>{received=await f.speech.preprocess(message);return {kind:"local_reply",text:"ok"};};
  const first=event(owner),second=event(owner,platformId,"second clip");
  first.item_list!.push(second.item_list![0]!);
  await f.adapter.accept([first],"cursor",owner);await f.adapter.flush();
  assert.equal(f.count(),2);
  assert.deepEqual(received!.attachments.map(item=>item.transcription),["account-a","second clip"]);
  assert.deepEqual(received!.platformMessages![0]!.attachments!.map(item=>item.transcription),["account-a","second clip"]);
  assert.notEqual(received!.attachments[0]!.remoteId,received!.attachments[1]!.remoteId);
  assert.match(received!.text,/account-a[\s\S]*second clip/);
}));

test("legacy normalized pending input retains its original ASR key and never pays again",()=>fixture(async f=>{
  const legacy:InboundMessage={channel:"wechat",conversationId:owner.userId,senderId:owner.userId,messageId:"ilink:legacy-batch",
    text:"[附件索引 1]",receivedAt:new Date().toISOString(),attachments:[{
      kind:"voice",sourceMessageId:platformId+":0",remoteId:platformId,localPath:"/synthetic-legacy-only",durationSeconds:1,
    }]};
  const id="asr:"+createHash("sha256").update("wechat:"+owner.userId+":"+platformId+":0:"+platformId).digest("hex");
  f.voiceStore.reserve(id,"asr");f.voiceStore.finish(id,"already transcribed");
  await f.store.mutate((s:any)=>{s.binding=owner;s.batches=[{id:"legacy-batch",events:[event(owner)],firstAt:1,lastAt:1,inbound:legacy}];});
  let received:InboundMessage|undefined;
  (f.adapter as any).handler=async(message:InboundMessage)=>{received=await f.speech.preprocess(message);return {kind:"local_reply",text:"ok"};};
  await f.adapter.flush();
  assert.equal(received!.attachments[0]!.transcription,"already transcribed");
  assert.equal(received!.attachments[0]!.remoteId,platformId);assert.equal(f.count(),0);
}));

test("six-table snapshot preserves normalized scope and paid attempts across relocated restart",()=>fixture(async f=>{
  await f.store.mutate((s:any)=>{s.binding=owner;});
  (f.adapter as any).handler=async(message:InboundMessage)=>{await f.speech.preprocess(message);return {kind:"retry",retryAfterMs:1};};
  await f.adapter.accept([event(owner)],"cursor",owner);await f.adapter.flush();assert.equal(f.count(),1);
  const original=(await f.store.load()).batches[0].inbound;
  // All writers are closed before making the synthetic recovery copy, including WAL.
  await f.close();
  const restored=join(f.base,"restored");await cp(f.root,restored,{recursive:true});
  const store=new IlinkStore(restored,f.encryption),voices=new VoiceStore(restored);
  const service=new VoiceService(new VoiceSettingsStore(restored),voices,f.client,f.codec);
  const adapter=new IlinkAdapter({...f.options,store,media:new MediaStore(join(restored,"media"))});
  let received:InboundMessage|undefined;
  (adapter as any).handler=async(message:InboundMessage)=>{received=await service.preprocess(message);return {kind:"local_reply",text:"ok"};};
  try {
    await adapter.flush();assert.equal(f.count(),1);assert.equal(received!.attachments[0]!.transcription,"account-a");
    assert.equal(received!.attachments[0]!.remoteId,original.attachments[0].remoteId);
    assert.ok(received!.attachments[0]!.localPath!.startsWith(restored));
    assert.equal((await store.load()).batches.length,0);
  } finally {await adapter.stop();store.close();voices.close();}
},true));
