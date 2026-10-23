import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../sessions/store.js";
import { LocalKnowledgeStore } from "../knowledge/store.js";
import { acquireInstanceLock } from "../service/instance-lock.js";
import { CORE_KEY, PERSONA_KEY, SCHEMA_KEY, ILINK_KEY, ILINK_RECEIPT_KEY, ROOTS_KEY, RECENT_DELETED_KEY, createStateSchema, getState,
  mainPath, openDatabase, putState, readDocument, readPersonaDocument, schemaVersion, transaction, writeDocument, writePersonaDocument } from "./database.js";
import { createAuxiliarySchema, importCore, migrateSchema, preflightSchema, rollbackExport, schemaV1Export } from "./migration.js";
import { SIX_TABLES, migrateSchemaDatabase, validateSixSchema } from "./schema.js";

const at="2026-10-20T01:02:03.000Z";
const persona={version:2 as const,active:"custom",presets:{default:["CALM","SMART"],custom:["PRECISE","CLEAR"]}};
async function fixture(fn:(root:string,base:string)=>Promise<void>):Promise<void> {
  const base=await mkdtemp(join(tmpdir(),"gateway-six-")),root=join(base,"data");
  await mkdir(root);
  const sessions=new SessionStore(root);
  try {
    await sessions.append("telegram","17","17",[
      {id:"u0",role:"user",content:"original unknown source",at},
      {id:"u1",role:"user",content:"telegram source",at,source:{channel:"telegram",senderId:"17",messageId:"8"}},
      {id:"a1",role:"assistant",content:"wechat source",at,source:{channel:"wechat",senderId:"wx-user",messageId:"delivery-not-platform"}},
    ]);
    await sessions.bindOwnerSession("17","wx-user");
  } finally {sessions.close();}
  const recent=new LocalKnowledgeStore(root,"formal");
  try {recent.createRecent({id:"r1",body:"synthetic Recent topic",sourceId:"source-one",conversationState:"Pending",stateDate:"2026-10-20"});} finally {recent.close();}
  const db=openDatabase(mainPath(root));
  try {
    createStateSchema(db);createAuxiliarySchema(db);
    db.prepare("INSERT INTO gateway_state(key,value,updated_at) VALUES(?,?,?)").run(CORE_KEY,"# Synthetic fixture Core\nIdentity.",at);
    db.prepare("INSERT INTO gateway_state(key,value,updated_at) VALUES(?,?,?)").run(PERSONA_KEY,JSON.stringify({presets:persona.presets,active:persona.active,version:persona.version}),at);
    db.prepare("INSERT INTO gateway_state(key,value,updated_at) VALUES(?,?,?)").run("runtime/provider.json",JSON.stringify({provider:"siwc"}),at);
    db.prepare("INSERT INTO gateway_state_meta VALUES(1,1,?)").run(at);
    db.prepare("INSERT INTO gateway_path_roots VALUES(?)").run("D:\\Synthetic\\Gateway\\data");
    db.prepare("INSERT INTO gateway_path_roots VALUES(?)").run(root);
    db.prepare("UPDATE recent_entries SET revision=4,updated_at=? WHERE id='r1'").run(at);
    db.prepare("INSERT INTO knowledge_review_progress VALUES(?,?,?)").run("formal:telegram:17",1,at);
    db.prepare("INSERT INTO ilink_state VALUES(1,?)").run("AAECAwQFBgc=");
    db.prepare("INSERT INTO ilink_events VALUES(?)").run("bot-original:event-original");
    db.prepare("INSERT INTO voice_jobs(id,kind,day,result,error) VALUES(?,?,?,?,?)").run("job-only","tts","2026-10-20",null,"uncertain");
    db.prepare("INSERT INTO voice_text(token,chat,message,text,page) VALUES(?,?,?,?,?)").run("token-only","17",101,"historical voice original",2);
    db.prepare("INSERT INTO voice_status VALUES(?,?)").run("tts","synthetic note");
  } finally {db.close();}
  try {await fn(root,base);} finally {await rm(base,{recursive:true,force:true});}
}
function messageIdentity(db:ReturnType<typeof openDatabase>) {
  return db.prepare("SELECT rowid,conv_key,seq,msg_id,role,content,at,at_ms,attachments,origin,partial,source FROM messages ORDER BY rowid").all();
}
test("transaction composes with an externally opened transaction and rolls back only its savepoint",()=>fixture(async root=>{
  const db=openDatabase(mainPath(root)), failure=new Error("injected nested failure");
  try {
    const original=getState(db,CORE_KEY)!.value;
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE gateway_state SET value=? WHERE key=?").run("outer Core",CORE_KEY);
    assert.throws(()=>transaction(db,()=>{
      db.prepare("UPDATE gateway_state SET value=? WHERE key=?").run("nested Core",CORE_KEY);
      throw failure;
    }),error=>error===failure);
    assert.equal(db.isTransaction,true);assert.equal(getState(db,CORE_KEY)!.value,"outer Core");
    assert.equal(transaction(db,()=>{
      db.prepare("UPDATE gateway_state SET value=? WHERE key=?").run("successful nested Core",CORE_KEY);return "nested result";
    }),"nested result");
    assert.equal(db.isTransaction,true);assert.equal(getState(db,CORE_KEY)!.value,"successful nested Core");
    db.exec("ROLLBACK");assert.equal(db.isTransaction,false);assert.equal(getState(db,CORE_KEY)!.value,original);
  }finally{db.close();}
}));
test("top-level transactions acquire the write lock before running the body and preserve lock failures",()=>fixture(async root=>{
  const writer=openDatabase(mainPath(root)),contender=openDatabase(mainPath(root));
  try {
    contender.exec("PRAGMA busy_timeout=0");let called=false;
    transaction(writer,()=>{
      assert.equal(writer.isTransaction,true);
      assert.throws(()=>transaction(contender,()=>{called=true;}),error=>error instanceof Error&&/locked/.test(error.message));
      assert.equal(called,false);assert.equal(contender.isTransaction,false);
    });
    assert.equal(writer.isTransaction,false);
    assert.equal(transaction(contender,()=>"lock released"),"lock released");assert.equal(contender.isTransaction,false);
  }finally{contender.close();writer.close();}
}));
test("six-table migration preserves identities, timestamps, source JSON, ciphertext and unpaired voice rows",()=>fixture(async root=>{
  const before=openDatabase(mainPath(root),true);
  const messages=messageIdentity(before), conversation=before.prepare("SELECT updated_at FROM conversations WHERE key='telegram:17'").get()!.updated_at;
  before.close();
  const preview=await preflightSchema(root);assert.equal(preview.from,1);assert.equal(preview.counts.messages,3);
  assert.equal((await migrateSchema(root,true)).changed,true);
  const db=openDatabase(mainPath(root),true);
  try {
    validateSixSchema(db);assert.equal(schemaVersion(db),2);
    const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name);
    assert.deepEqual(tables.filter(name=>!name.startsWith("message_fts")).sort(),[...SIX_TABLES].sort());
    assert.deepEqual(messageIdentity(db),messages);
    assert.deepEqual(db.prepare("SELECT source_channel FROM messages ORDER BY seq").all().map(row=>row.source_channel),[null,"telegram","wechat"]);
    assert.equal(db.prepare("SELECT updated_at FROM conversations WHERE key='telegram:17'").get()!.updated_at,conversation);
    assert.equal(db.prepare("SELECT recent_review_through_seq FROM conversations WHERE key='telegram:17'").get()!.recent_review_through_seq,1);
    assert.equal(db.prepare("SELECT revision FROM context WHERE kind='recent' AND id='r1'").get()!.revision,4);
    assert.deepEqual(readPersonaDocument(db),persona);
    assert.equal(getState(db,ILINK_KEY)!.value,"AAECAwQFBgc=");assert.equal(getState(db,ILINK_KEY)!.encoding,"encrypted_json");
    assert.ok(JSON.parse(getState(db,ROOTS_KEY)!.value).includes("D:\\Synthetic\\Gateway\\data"));
    assert.equal(db.prepare("SELECT count(*) AS n FROM voice_records").get()!.n,2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM voice_records WHERE operation_id IS NOT NULL").get()!.n,1);
    assert.equal(db.prepare("SELECT day FROM voice_records WHERE token='token-only'").get()!.day,null);
    assert.equal(db.prepare("SELECT text FROM voice_records WHERE token='token-only'").get()!.text,"historical voice original");
  } finally {db.close();}
}));
test("v2 document writes and Core imports use context, update revisions and survive an idempotent rerun",()=>fixture(async(root,base)=>{
  await migrateSchema(root,true);
  const db=openDatabase(mainPath(root));
  try {writePersonaDocument(db,{...persona,active:"default"});assert.equal(readPersonaDocument(db)!.active,"default");
    assert.equal(db.prepare("SELECT revision FROM context WHERE kind='persona' AND id='custom'").get()!.revision,2);
    assert.equal(getState(db,PERSONA_KEY),undefined);
  } finally {db.close();}
  await mkdir(join(root,"core"));await writeFile(join(root,"core/core.md"),"stale legacy data");
  const input=join(base,"core.md");await writeFile(input,"# Updated synthetic Core");await importCore(root,input);
  assert.equal(readDocument(join(root,CORE_KEY)).value,"# Updated synthetic Core");
  assert.equal(writeDocument(join(root,"runtime/provider.json"),{provider:"siwc",fixture:true}),true);
  assert.equal((await migrateSchema(root,true)).changed,false);
  assert.equal(JSON.parse(readDocument(join(root,PERSONA_KEY)).value!).active,"default");
  const check=openDatabase(mainPath(root),true);try{assert.equal(check.prepare("SELECT revision FROM context WHERE kind='core'").get()!.revision,2);}finally{check.close();}
}));
test("unknown tables and unmappable review scopes are rejected before any schema mutation",()=>fixture(async root=>{
  const db=openDatabase(mainPath(root));
  try {db.exec("CREATE TABLE unknown_private_state(secret TEXT)");assert.throws(()=>migrateSchemaDatabase(db,root),/未登记/);
    assert.equal(schemaVersion(db),1);db.exec("DROP TABLE unknown_private_state");
    db.prepare("INSERT INTO knowledge_review_progress VALUES(?,?,?)").run("formal:telegram:999",0,at);
    assert.throws(()=>migrateSchemaDatabase(db,root),/孤立|scope/);assert.equal(schemaVersion(db),1);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='context'").get(),undefined);
  }finally{db.close();}
}));
test("failure during data mapping rolls back DDL, version, data and migrated cursor together",()=>fixture(async root=>{
  const db=openDatabase(mainPath(root));
  try {const original=messageIdentity(db);db.exec("CREATE TRIGGER fail_review BEFORE UPDATE ON conversations BEGIN SELECT RAISE(ABORT,'injected mapping failure'); END");
    assert.throws(()=>migrateSchemaDatabase(db,root),/injected/);
    assert.equal(schemaVersion(db),1);assert.deepEqual(messageIdentity(db),original);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='context'").get(),undefined);
    assert.equal(db.prepare("SELECT through_seq FROM knowledge_review_progress").get()!.through_seq,1);
  }finally{db.close();}
}));
test("missing, damaged or unknown v2 version markers fail closed instead of reading legacy files",()=>fixture(async root=>{
  await migrateSchema(root,true);const db=openDatabase(mainPath(root));
  try {db.prepare("DELETE FROM gateway_state WHERE key=?").run(SCHEMA_KEY);assert.throws(()=>schemaVersion(db),/缺失|损坏/);
    putState(db,{key:SCHEMA_KEY,value:"{broken",category:"metadata"});assert.throws(()=>schemaVersion(db),/损坏/);
    putState(db,{key:SCHEMA_KEY,value:JSON.stringify({version:3}),category:"metadata"});assert.throws(()=>schemaVersion(db),/不兼容/);
    assert.throws(()=>readDocument(join(root,CORE_KEY)));
  }finally{db.close();}
}));
test("v1 export includes new v2 writes, valid source channels and a combined job/text row",()=>fixture(async(root,base)=>{
  await migrateSchema(root,true);
  const sessions=new SessionStore(root);
  try{await sessions.append("wechat","wx-user","wx-user",[{id:"v2-new",role:"user",content:"new after schema migration",at,source:{channel:"wechat",senderId:"wx-user",messageId:"99"}}]);}finally{sessions.close();}
  const recent=new LocalKnowledgeStore(root,"formal");try{recent.createRecent({id:"r2",body:"new synthetic Recent",sourceId:"v2:new"});}finally{recent.close();}
  const db=openDatabase(mainPath(root));
  try {db.prepare("INSERT INTO voice_records(id,operation_id,kind,day,result,token,chat,message,text,page) VALUES(?,?,?,?,?,?,?,?,?,?)").run("combined","new-op","tts","2026-10-22","done","new-token","17",102,"new voice",0);
    writePersonaDocument(db,{...persona,active:"default"});
  }finally{db.close();}
  const target=join(base,"v1");await schemaV1Export(root,target,true);
  const old=openDatabase(mainPath(target),true);
  try{assert.equal(schemaVersion(old),1);assert.equal(old.prepare("SELECT count(*) AS n FROM messages").get()!.n,4);
    assert.equal(JSON.parse(old.prepare("SELECT source FROM messages WHERE msg_id='v2-new'").get()!.source as string).channel,"wechat");
    assert.equal(old.prepare("SELECT body FROM recent_entries WHERE id='r2'").get()!.body,"new synthetic Recent");
    assert.equal(old.prepare("SELECT result FROM voice_jobs WHERE id='new-op'").get()!.result,"done");
    assert.equal(old.prepare("SELECT text FROM voice_text WHERE token='new-token'").get()!.text,"new voice");
    assert.equal(old.prepare("SELECT token FROM voice_text WHERE token='token-only'").get()!.token,"token-only");
    assert.equal(JSON.parse(getState(old,PERSONA_KEY)!.value).active,"default");
  }finally{old.close();}
  const current=openDatabase(mainPath(root),true);try{assert.equal(schemaVersion(current),2);}finally{current.close();}
}));
test("downgrade refuses deletion receipts that old writers cannot enforce",()=>fixture(async(root,base)=>{
  await migrateSchema(root,true);
  const recent=new LocalKnowledgeStore(root,"formal");try{recent.deleteRecent([{id:"r1",expectedRevision:4}]);}finally{recent.close();}
  await assert.rejects(schemaV1Export(root,join(base,"unsafe-v1"),true),/删除凭据|复活/);
  const db=openDatabase(mainPath(root),true);try{validateSixSchema(db);assert.equal(JSON.parse(getState(db,RECENT_DELETED_KEY)!.value).entries.length,1);}finally{db.close();}
}));
test("pending iLink delivery receipts validate minimally and refuse unsafe downgrade",()=>fixture(async(root,base)=>{
  await migrateSchema(root,true);const db=openDatabase(mainPath(root));
  try {
    for(const value of ["false","{}",JSON.stringify({pending:true}),JSON.stringify("true")]) {
      putState(db,{key:ILINK_RECEIPT_KEY,category:"metadata",value});
      assert.throws(()=>validateSixSchema(db),/凭据标记损坏/);
    }
    putState(db,{key:ILINK_RECEIPT_KEY,value:"true"});validateSixSchema(db);
    assert.equal(getState(db,ILINK_RECEIPT_KEY)!.category,"metadata");
  }finally{db.close();}
  await assert.rejects(schemaV1Export(root,join(base,"pending-v1"),true),/待结算.*不能降级/);
  const current=openDatabase(mainPath(root),true);
  try {assert.equal(schemaVersion(current),2);assert.equal(getState(current,ILINK_RECEIPT_KEY)!.value,"true");}finally{current.close();}
}));
test("migrated FTS keeps rowid-based insert, content update and delete triggers",()=>fixture(async root=>{
  await migrateSchema(root,true);const db=openDatabase(mainPath(root));
  try {db.prepare("UPDATE messages SET content=? WHERE msg_id='u0'").run("distinct needle phrase");
    assert.equal(db.prepare("SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'needle'").get()!.n,1);
    db.prepare("DELETE FROM messages WHERE msg_id='u0'").run();
    assert.equal(db.prepare("SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'needle'").get()!.n,0);
    db.prepare("INSERT INTO messages(conv_key,seq,msg_id,role,content,at,at_ms) VALUES(?,?,?,?,?,?,?)").run("telegram:17",3,"new-fts","user","new inserted needle",at,Date.parse(at));
    assert.equal(db.prepare("SELECT count(*) AS n FROM message_fts WHERE message_fts MATCH 'needle'").get()!.n,1);
  }finally{db.close();}
}));
test("explicit stopped acknowledgement and the real instance lock guard schema migration",()=>fixture(async root=>{
  await assert.rejects(migrateSchema(root,false),/停止写入/);const lock=await acquireInstanceLock(root);
  try{assert.equal((await preflightSchema(root)).from,1);await assert.rejects(migrateSchema(root,true),/active/);}finally{await lock.release();}
  assert.equal((await migrateSchema(root,true)).changed,true);
}));
test("missing authority database after migration cannot resurrect a retained Core or initialize empty history",()=>fixture(async root=>{
  await migrateSchema(root,true);await mkdir(join(root,"core"));await writeFile(join(root,CORE_KEY),"stale file that must never be loaded");
  await rm(mainPath(root));
  assert.throws(()=>readDocument(join(root,CORE_KEY)),/主数据库缺失/);
  assert.throws(()=>new SessionStore(root),/主数据库缺失/);
}));
test("restoration validators reject duplicate, leaked or malformed Recent deletion receipts",()=>fixture(async root=>{
  await migrateSchema(root,true);const db=openDatabase(mainPath(root));
  const entry={id:"deleted-one",sourceId:"deleted-source",revision:2,deletedAt:at};
  try {
    for(const entries of [[{...entry,body:"must not retain deleted text"}],[{...entry,sourceId:""}],[entry,{...entry,id:"deleted-two"}],[{...entry,deletedAt:"invalid"}]]) {
      putState(db,{key:RECENT_DELETED_KEY,category:"metadata",value:JSON.stringify({version:1,entries})});
      assert.throws(()=>validateSixSchema(db),/删除凭据/);
    }
    putState(db,{key:RECENT_DELETED_KEY,category:"runtime",value:JSON.stringify({version:1,entries:[entry]})});
    assert.throws(()=>validateSixSchema(db),/删除凭据/);
  }finally{db.close();}
}));
test("legacy export preserves new quoted-message attachment references and reconstructs both voice tables",()=>fixture(async(root,base)=>{
  await migrateSchema(root,true);const db=openDatabase(mainPath(root));
  const encryption={id:"test-only",isAvailable:async()=>true,encrypt:async(text:string)=>Buffer.from(text),decrypt:async(bytes:Uint8Array)=>Buffer.from(bytes).toString()};
  try {
    putState(db,{key:ILINK_KEY,category:"channel",encoding:"encrypted_json",value:Buffer.from(JSON.stringify({cursor:"fixture",batches:[]})).toString("base64")});
    db.prepare("UPDATE messages SET source=? WHERE msg_id='a1'").run(JSON.stringify({messageId:"delivery-not-platform",senderId:"wx-user",platformMessages:[{
      accountId:"bot",conversationId:"wx-user",messageId:"platform-17",direction:"outbound",text:"fixture quoted message",attachments:[{kind:"file",path:"gateway-data:media/fixture.png"}],
    }]}));
  }finally{db.close();}
  const target=join(base,"legacy");await rollbackExport(root,target,true,encryption);
  const old=openDatabase(mainPath(target),true);
  try{assert.equal(schemaVersion(old),0);const source=JSON.parse(old.prepare("SELECT source FROM messages WHERE msg_id='a1'").get()!.source as string);
    assert.equal(source.channel,"wechat");assert.equal(source.platformMessages[0].attachments[0].path,join(root,"media/fixture.png"));
  }finally{old.close();}
}));
