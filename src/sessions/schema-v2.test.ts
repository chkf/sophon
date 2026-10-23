import { writeLegacyPersonaFixture } from "../../scripts/testing/persona-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "./store.js";
import { PersonaStore } from "../persona/store.js";
import { VoiceStore } from "../voice/store.js";
import { IlinkStore, validateIlinkReceipt } from "../channels/ilink/store.js";
import { IlinkAdapter } from "../channels/ilink/adapter.js";
import { IlinkError, type Binding, type IlinkClient } from "../channels/ilink/api.js";
import { MediaStore } from "../media/store.js";
import { SerialQueue } from "../util/serial-queue.js";
import { recordDeliveredAssistant } from "../delivery/coordinator.js";
import { migrateState } from "../state/migration.js";
import { migrateSchemaDatabase, SIX_TABLES } from "../state/schema.js";
import { mainPath, openDatabase, getState, ILINK_RECEIPT_KEY } from "../state/database.js";
import { encryptAesGcm, decryptAesGcm } from "../runtime/siwc/crypto.js";
const encryption={id:"fixture",isAvailable:async()=>true,encrypt:async(text:string)=>encryptAesGcm(Buffer.alloc(32,7),text),decrypt:async(bytes:Uint8Array)=>decryptAesGcm(Buffer.alloc(32,7),bytes)};
const binding:Binding={token:"fixture-secret",botId:"bot",userId:"wx-owner",baseUrl:"https://ilinkai.weixin.qq.com",telegramOwner:"123"};
function receiptAdapter(root:string,store:IlinkStore,options:Partial<ConstructorParameters<typeof IlinkAdapter>[0]>={}) {
  const api:IlinkClient={
    qr:async()=>{throw new Error("unexpected QR");},qrStatus:async()=>{throw new Error("unexpected QR status");},
    updates:async(_binding,_cursor,signal)=>new Promise(resolve=>{if(signal?.aborted)resolve({});else signal?.addEventListener("abort",()=>resolve({}),{once:true});}),
    send:async()=>{throw new Error("unexpected send");},media:async()=>{throw new Error("unexpected media");},
  };
  return new IlinkAdapter({ownerId:"123",store,media:new MediaStore(join(root,"media")),queue:new SerialQueue(),api,
    bind:async()=>{},activate:async()=>{},notify:async()=>{},qrPhoto:async()=>{},delivered:async()=>{},discarded:async()=>{},...options});
}
const deliverPending=(adapter:IlinkAdapter)=>(adapter as unknown as {deliverPending():Promise<void>}).deliverPending();
async function fixture(run:(root:string)=>Promise<void>) {
  const root=await mkdtemp(join(tmpdir(),"six-table-stores-"));
  try {
    await mkdir(join(root,"core"));await writeFile(join(root,"core/core.md"),"# Fixture Core\n合成测试身份。\n");
    await writeLegacyPersonaFixture(root,"default");
    const sessions=new SessionStore(root);
    assert.equal(sessions.supportsDurableIlinkDelivery(),false);
    await sessions.append("telegram","123","123",[{id:"first",role:"user",content:"历史原文 unchanged",at:"2026-10-20T04:00:00Z",source:{channel:"telegram",senderId:"123",messageId:"1"}}]);
    await sessions.bindOwnerSession("123","wx-owner");sessions.close();
    const voice=new VoiceStore(root);voice.reserve("old-asr","asr");voice.finish("old-asr","old transcript");voice.saveText("legacy-token","123","legacy original");voice.sent("legacy-token",42);voice.shown("legacy-token",42,1);voice.close();
    const ilink=new IlinkStore(root,encryption);await ilink.mutate(state=>{state.cursor="old-cursor";},["bot:original"]);ilink.close();
    await migrateState(root,true);
    const v1Sessions=new SessionStore(root);try{assert.equal(v1Sessions.supportsDurableIlinkDelivery(),false);}finally{v1Sessions.close();}
    const db=openDatabase(mainPath(root));try{migrateSchemaDatabase(db,root);}finally{db.close();}
    await run(root);
  } finally {await rm(root,{recursive:true,force:true});}
}
test("v2 stores preserve six tables, canonical routes, channel authority and FTS",()=>fixture(async root=>{
  const sessions=new SessionStore(root),voice=new VoiceStore(root),ilink=new IlinkStore(root,encryption);
  try {
    assert.equal(sessions.supportsDurableIlinkDelivery(),true);
    assert.equal(sessions.sessionKey("wechat","wx-owner"),"telegram:123");
    await sessions.append("wechat","wx-owner","wx-owner",[{id:"wx-new",role:"user",content:"微信检索 evidence",at:"2026-10-21T00:00:00Z",source:{channel:"wechat",senderId:"wx-owner",messageId:"batch"}}]);
    const db=openDatabase(mainPath(root));
    try {
      const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'message_fts%' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
      assert.deepEqual(tables,[...SIX_TABLES].sort());
      const raw=db.prepare("SELECT rowid,source_channel,source FROM messages WHERE msg_id='wx-new'").get() as {rowid:number;source_channel:string;source:string};
      assert.equal(raw.source_channel,"wechat");assert.equal(JSON.parse(raw.source).channel,undefined);
      db.prepare("UPDATE messages SET source=? WHERE msg_id='wx-new'").run(JSON.stringify({channel:"telegram",senderId:"wx-owner",messageId:"batch"}));
      assert.equal((await sessions.readTail("telegram","123",1))[0]!.source!.channel,"wechat");
      db.prepare("UPDATE messages SET source_channel=NULL WHERE msg_id='wx-new'").run();
      assert.equal((await sessions.readTail("telegram","123",1))[0]!.source!.channel,undefined);
      db.prepare("UPDATE messages SET source=NULL,source_channel='wechat' WHERE msg_id='wx-new'").run();
      assert.deepEqual((await sessions.readTail("telegram","123",1))[0]!.source,{channel:"wechat"});
      db.prepare("UPDATE messages SET source_channel=NULL WHERE msg_id='wx-new'").run();
      assert.equal((await sessions.readTail("telegram","123",1))[0]!.source,undefined);
      assert.equal(db.prepare("SELECT rowid FROM messages WHERE msg_id='wx-new'").get()!.rowid,raw.rowid);
      assert.equal((await (await sessions.view("telegram","123")).history.search("evidence",0,10)).total,1);
      assert.equal((await (await sessions.view("telegram","123")).history.search("微信",0,10)).total,1);
      assert.equal((await (await sessions.view("wechat","wx-owner")).history.search("历史",0,10)).total,1);
      assert.equal((await (await sessions.view("wechat","wx-owner")).history.search("无关",0,10)).total,0);
      assert.equal((getState(db,"sessions/owner_routes")?.encoding),"json");
    } finally {db.close();}
    await assert.rejects(sessions.bindOwnerSession("999","wx-owner"),/identity/);
  } finally {sessions.close();voice.close();ilink.close();}
}));
test("v2 voice keeps unpaired legacy text, optional UTC cap and one row for each new TTS",()=>fixture(async root=>{
  const voice=new VoiceStore(root);
  try {
    assert.deepEqual({...voice.job("old-asr")!},{result:"old transcript",error:null});
    assert.deepEqual({...voice.text("legacy-token")!},{token:"legacy-token",chat:"123",message:42,text:"legacy original",page:1});
    voice.reserve("new-tts","tts");voice.saveText("new-token","123","new spoken original","new-tts");voice.sent("new-token",43);voice.finish("new-tts","sent");
    assert.equal(voice.status("tts","fixture success"),"fixture success");
    const db=openDatabase(mainPath(root));
    try {
      const old=db.prepare("SELECT operation_id,day FROM voice_records WHERE token='legacy-token'").get();assert.equal(old!.operation_id,null);assert.equal(old!.day,null);
      assert.equal(db.prepare("SELECT count(*) AS n FROM voice_records WHERE operation_id='new-tts' AND token='new-token'").get()!.n,1);
      assert.equal(db.prepare("SELECT day FROM voice_records WHERE operation_id='new-tts'").get()!.day,new Date().toISOString().slice(0,10));
      for(let i=1;i<30;i++)voice.reserve("tts-limit-"+i,"tts");
      voice.reserve("tts-unlimited","tts");
      assert.throws(()=>voice.reserve("tts-over-limit","tts",30),/每日上限/);
      assert.equal(db.prepare("SELECT count(*) AS n FROM voice_records WHERE kind='tts' AND operation_id IS NOT NULL").get()!.n,31);
      assert.equal(db.prepare("SELECT count(*) AS n FROM voice_records WHERE token IS NOT NULL").get()!.n,2);
    } finally {db.close();}
  } finally {voice.close();}
  const restarted=new VoiceStore(root);try{assert.equal(restarted.job("new-tts")!.result,"sent");assert.equal(restarted.text("new-token")!.message,43);assert.equal(restarted.status("tts"),"fixture success");}finally{restarted.close();}
}));
test("v2 iLink state and receipt commit atomically and preserve ciphertext on failure",()=>fixture(async root=>{
  const store=new IlinkStore(root,encryption),db=openDatabase(mainPath(root));
  try {
    assert.equal((await store.load()).cursor,"old-cursor");assert.equal(store.seen("bot:original"),true);
    const before=getState(db,"channels/ilink")!.value;
    db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON channel_events WHEN new.event_key='bot:fail' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    await assert.rejects(store.mutate(state=>{state.cursor="bad-cursor";},["bot:fail"]),/fixture failure/);
    assert.equal(getState(db,"channels/ilink")!.value,before);assert.equal(store.seen("bot:fail"),false);assert.equal((await store.load()).cursor,"old-cursor");
    db.exec("DROP TRIGGER fail_event");
    await store.mutate(state=>{state.cursor="new-cursor";},["bot:next"]);
    assert.equal(getState(db,"channels/ilink")!.encoding,"encrypted_json");
    assert.ok(!getState(db,"channels/ilink")!.value.includes("new-cursor"));
  } finally {store.close();db.close();}
  const restarted=new IlinkStore(root,encryption);try{assert.equal((await restarted.load()).cursor,"new-cursor");assert.equal(restarted.seen("bot:next"),true);}finally{restarted.close();}
}));
test("platform ID lookup is exact to bot, peer and direction after restart; missing media degrades",()=>fixture(async root=>{
  const sessions=new SessionStore(root);
  const fragment={accountId:"bot",conversationId:"wx-owner",direction:"outbound" as const,messageId:"18446744073709551615",text:"confirmed bubble",attachments:[{kind:"image" as const,localPath:join(root,"media/missing.png"),fileName:"lost.png"}]};
  try {
    await sessions.append("wechat","wx-owner","wx-owner",[{id:"delivery:assistant",role:"assistant",content:"full reply",at:new Date().toISOString(),source:{channel:"wechat",senderId:"wx-owner",messageId:"delivery",platformMessages:[fragment]}}]);
  } finally {sessions.close();}
  const reopened=new SessionStore(root);
  try {
    const found=await reopened.findPlatformMessage("wechat","wx-owner","bot",fragment.messageId);
    assert.equal(found?.text,"confirmed bubble");assert.equal(found?.sender,"assistant");assert.equal(found?.attachments?.[0]?.localPath,undefined);assert.match(found?.attachments?.[0]?.error??"",/过期/);
    assert.equal(await reopened.findPlatformMessage("wechat","wx-owner","another-bot",fragment.messageId),undefined);
    assert.equal(await reopened.findPlatformMessage("wechat","another-peer","bot",fragment.messageId),undefined);
    assert.equal(await reopened.findPlatformMessage("telegram","123","bot",fragment.messageId),undefined);
    assert.equal(await reopened.findPlatformMessage("wechat","wx-owner","bot","delivery"),undefined);
  } finally {reopened.close();}
}));
test("v2 confirmed delivery survives history-finalization failure and restarts without a network resend",()=>fixture(async root=>{
  const store=new IlinkStore(root,encryption),sessions=new SessionStore(root),db=openDatabase(mainPath(root));
  let sends=0,commits=0;
  const delivered:ConstructorParameters<typeof IlinkAdapter>[0]["delivered"]=async(user,text,id,complete,fragments)=>{
    commits++;await recordDeliveredAssistant(sessions,"wechat",user,user,text,undefined,id,"2026-10-21T10:00:00Z",{origin:"chat",partial:complete===false},fragments);
  };
  const adapter=receiptAdapter(root,store,{delivered,api:{send:async()=>({messageId:String(++sends)})} as IlinkClient});
  try {
    await store.mutate(s=>{s.binding=binding;s.context="context";s.pending={batchId:"normal-batch",userId:binding.userId,reply:{kind:"model_reply",text:"normal answer",deliveryId:"normal-delivery"}};});
    db.exec("CREATE TRIGGER fail_receipt_clear BEFORE DELETE ON gateway_state WHEN old.key='channels/ilink_delivery_receipt_pending' BEGIN SELECT RAISE(ABORT,'fixture finalization failure'); END");
    await assert.rejects(deliverPending(adapter),/fixture finalization failure/);
    assert.equal(sends,1);assert.equal(commits,1);assert.equal((await store.load()).pending,undefined);
    assert.equal((await store.load()).deliveryReceipt?.complete,true);assert.equal(await adapter.availableTarget(),undefined);
    assert.equal(getState(db,ILINK_RECEIPT_KEY)?.value,"true");assert.ok(!getState(db,"channels/ilink")!.value.includes("normal answer"));
    db.exec("DROP TRIGGER fail_receipt_clear");
  } finally {await adapter.stop();store.close();}
  const restarted=new IlinkStore(root,encryption),recovered=receiptAdapter(root,restarted,{delivered});
  try {
    await recovered.start(async()=>undefined);
    assert.equal(sends,1);assert.equal(commits,2);assert.equal(getState(db,ILINK_RECEIPT_KEY),undefined);
    assert.equal((await restarted.load()).deliveryReceipt,undefined);
    assert.equal((await sessions.readTail("wechat",binding.userId,10)).filter(row=>row.id==="normal-delivery:assistant").length,1);
    assert.equal((await sessions.findPlatformMessage("wechat",binding.userId,binding.botId,"1"))?.text,"normal answer");
  } finally {await recovered.stop();restarted.close();sessions.close();db.close();}
}));
test("v2 recovery commits only durable partial acknowledgements and validates receipt marker both ways",()=>fixture(async root=>{
  const store=new IlinkStore(root,encryption),db=openDatabase(mainPath(root));
  const committed:unknown[][]=[];
  const adapter=receiptAdapter(root,store,{delivered:async(...args)=>{committed.push(args);}});
  try {
    await store.mutate(s=>{s.binding=binding;s.context="context";s.deliveryReceipt={batchId:"interrupted",userId:binding.userId,botId:binding.botId,
      reply:{kind:"model_reply",text:"first\n\nuncertain second",deliveryId:"interrupted-delivery"},complete:false,
      confirmed:[{text:"first",fragment:{accountId:binding.botId,conversationId:binding.userId,direction:"outbound",messageId:"confirmed-first",text:"first"}}]};});
    const receiptState=structuredClone(await store.load());
    assert.throws(()=>validateIlinkReceipt(receiptState,false,2),/不一致/);
    assert.throws(()=>validateIlinkReceipt({...receiptState,deliveryReceipt:undefined},true,2),/不一致/);
    assert.throws(()=>validateIlinkReceipt(receiptState,true,1),/损坏|不匹配/);
    db.prepare("DELETE FROM gateway_state WHERE key=?").run(ILINK_RECEIPT_KEY);
    const inconsistent=new IlinkStore(root,encryption);try{await assert.rejects(inconsistent.load(),/不一致/);}finally{inconsistent.close();}
    db.prepare("INSERT INTO gateway_state(key,category,encoding,value,updated_at) VALUES(?,'metadata','json','true',?)").run(ILINK_RECEIPT_KEY,new Date().toISOString());
    await adapter.start(async()=>undefined);
    assert.deepEqual(committed[0]?.slice(0,4),[binding.userId,"first","interrupted-delivery",false]);
    assert.equal(committed.length,1);assert.equal(getState(db,ILINK_RECEIPT_KEY),undefined);
  } finally {await adapter.stop();store.close();db.close();}
}));
test("v2 proactive receipt preserves the delivery time and platform IDs across a history-write failure",()=>fixture(async root=>{
  const store=new IlinkStore(root,encryption),sessions=new SessionStore(root),db=openDatabase(mainPath(root));
  let sends=0;
  const adapter=receiptAdapter(root,store,{api:{send:async()=>({messageId:"proactive-"+(++sends)})} as IlinkClient,
    proactiveDelivered:async()=>{throw new Error("fixture history unavailable");}});
  const delivery={deliveryId:"heartbeat:fixture:text",at:"2026-10-21T12:34:56Z"};
  try {
    await store.mutate(s=>{s.binding=binding;s.context="context";});
    await assert.rejects(adapter.sendProactiveText(binding.userId,"first\n\nsecond",undefined,delivery),/fixture history unavailable/);
    assert.equal(sends,2);assert.equal((await store.load()).deliveryReceipt?.origin,"proactive");assert.equal(getState(db,ILINK_RECEIPT_KEY)?.value,"true");
  } finally {await adapter.stop();store.close();}
  const restarted=new IlinkStore(root,encryption),recovered=receiptAdapter(root,restarted,{
    delivered:async()=>{throw new Error("proactive must not settle an interactive runtime");},
    proactiveDelivered:async(user,text,id,at,fragments)=>recordDeliveredAssistant(sessions,"wechat",user,user,text,undefined,id,at,{origin:"proactive"},fragments),
  });
  try {
    await recovered.start(async()=>undefined);assert.equal(sends,2);assert.equal(getState(db,ILINK_RECEIPT_KEY),undefined);
    const row=(await sessions.readTail("wechat",binding.userId,1))[0]!;
    assert.equal(row.origin,"proactive");assert.equal(row.at,delivery.at);assert.equal(row.content,"first\n\nsecond");
    assert.deepEqual(row.source?.platformMessages?.map(fragment=>fragment.messageId),["proactive-1","proactive-2"]);
  } finally {await recovered.stop();restarted.close();sessions.close();db.close();}
}));
test("v2 proactive partial failure records confirmed chunks then rejects so callers cannot record the full text",()=>fixture(async root=>{
  const store=new IlinkStore(root,encryption),db=openDatabase(mainPath(root));let attempts=0;const committed:unknown[][]=[];
  const adapter=receiptAdapter(root,store,{api:{send:async()=>{if(++attempts===2)throw new IlinkError("network");return {messageId:"only-confirmed"};}} as IlinkClient,
    proactiveDelivered:async(...args)=>{committed.push(args);}});
  try {
    await store.mutate(s=>{s.binding=binding;s.context="context";});
    await assert.rejects(adapter.sendProactiveText(binding.userId,"first\n\nnot confirmed",undefined,{deliveryId:"partial-proactive",at:"2026-10-21T10:00:00Z"}),IlinkError);
    assert.equal(attempts,2);assert.equal(committed.length,1);assert.equal(committed[0]?.[1],"first");
    assert.equal((await store.load()).deliveryReceipt,undefined);assert.equal(getState(db,ILINK_RECEIPT_KEY),undefined);
  } finally {await adapter.stop();store.close();db.close();}
}));
