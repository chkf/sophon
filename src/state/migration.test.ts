import { writeLegacyPersonaFixture } from "../../scripts/testing/persona-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../sessions/store.js";
import { PersonaStore } from "../persona/store.js";
import { VoiceStore } from "../voice/store.js";
import { VoiceSettingsStore } from "../voice/settings.js";
import { IlinkStore } from "../channels/ilink/store.js";
import { LaneStore } from "../runtime/siwc/lane-store.js";
import { ProviderDeliveryStore } from "../runtime/delivery-store.js";
import { loadCore } from "../core/loader.js";
import { acquireInstanceLock } from "../service/instance-lock.js";
import { centralEnabled, createStateSchema, mainPath, openDatabase } from "./database.js";
import { exportCore, importCore, migrateState, rollbackExport } from "./migration.js";
import { encryptAesGcm, decryptAesGcm } from "../runtime/siwc/crypto.js";

const encryption = { id: "fixture", isAvailable: async () => true,
  encrypt: async (text:string) => encryptAesGcm(Buffer.alloc(32, 7), text),
  decrypt: async (bytes:Uint8Array) => decryptAesGcm(Buffer.alloc(32, 7), bytes) };
async function fixture(fn:(root:string,base:string)=>Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), "gateway-state-")), root = join(base, "data");
  await mkdir(join(root, "core"), {recursive:true}); await writeFile(join(root, "core/core.md"), "# Fixture Core\n完整中文身份。\n");
  const sessions = new SessionStore(root);
  try {
    await sessions.append("telegram", "123", "123", [{id:"u1",role:"user",content:"fixture original history",at:"2026-10-20T04:00:00Z",attachments:[{kind:"image",path:join(root,"media/one.png")}]}]);
    await sessions.bindOwnerSession("123", "fixture-wechat");
  } finally { sessions.close(); }
  await mkdir(join(root,"media"));await writeFile(join(root,"media/one.png"),"fixture image");
  await writeLegacyPersonaFixture(root,"formal");
  const voice = new VoiceStore(root); voice.reserve("fixture-job","asr");voice.finish("fixture-job","fixture transcript");voice.saveText("text-token","123","fixture original voice");voice.close();
  const ilink = new IlinkStore(root,encryption); await ilink.mutate(s=>{s.cursor="fixture-cursor";},["event-1"]);ilink.close();
  try { await fn(root,base); } finally { await rm(base,{recursive:true,force:true}); }
}
test("migration preserves history, route, encrypted binding, voice ledger and latest settings; second run never overwrites",()=>fixture(async root=>{
  const original = await readFile(join(root,"runtime/persona.json"));
  const first=await migrateState(root,true);assert.equal(first.changed,true);assert.ok(first.archive);
  assert.equal(centralEnabled(root),true);assert.deepEqual(await readFile(join(root,"runtime/persona.json")),original);
  assert.equal((await new PersonaStore(root).snapshot()).active,"formal");
  await new PersonaStore(root).select("default"); await new VoiceSettingsStore(root).update({asr:true});
  await writeFile(join(root,"core/core.md"),"stale old file");
  assert.equal((await migrateState(root,true)).changed,false);
  assert.equal((await new PersonaStore(root).snapshot()).active,"default");
  assert.match((await loadCore(root)).text,/完整中文/);
  const sessions=new SessionStore(root);try{assert.equal(sessions.sessionKey("wechat","fixture-wechat"),"telegram:123");assert.equal((await sessions.get("telegram","123"))?.messages[0]?.content,"fixture original history");}finally{sessions.close();}
  const voice=new VoiceStore(root);try{assert.equal(voice.job("fixture-job")?.result,"fixture transcript");assert.equal(voice.text("text-token")?.text,"fixture original voice");assert.throws(()=>voice.reserve("fixture-job","asr"));}finally{voice.close();}
  const ilink=new IlinkStore(root,encryption);try{assert.equal((await ilink.load()).cursor,"fixture-cursor");assert.equal(ilink.seen("event-1"),true);}finally{ilink.close();}
}));
test("file/database conflict aborts the whole transaction and retains recovery archive",()=>fixture(async root=>{
  const db=openDatabase(mainPath(root));try{createStateSchema(db);db.prepare("INSERT INTO gateway_state VALUES(?,?,?)").run("core/core.md","different database core","fixture");}finally{db.close();}
  await assert.rejects(migrateState(root,true),/冲突/);assert.equal(centralEnabled(root),false);assert.match((await loadCore(root)).text,/Fixture Core/);
}));
test("unregistered auxiliary tables abort instead of silently omitting private state",()=>fixture(async root=>{
  const db=openDatabase(join(root,"voice/voice.sqlite"));
  try{db.exec("CREATE TABLE future_private_state(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO future_private_state VALUES(1,'fixture');");}finally{db.close();}
  await assert.rejects(migrateState(root,true),/未登记的表/);
  assert.equal(centralEnabled(root),false);
  const source=openDatabase(join(root,"voice/voice.sqlite"),true);
  try{assert.equal(source.prepare("SELECT value FROM future_private_state WHERE id=1").get()?.value,"fixture");}finally{source.close();}
}));
test("invalid import cannot replace Core, Markdown roundtrip and rollback export contain latest settings",()=>fixture(async(root,base)=>{
  await migrateState(root,true);const input=join(base,"core.md");await writeFile(input," ");await assert.rejects(importCore(root,input));
  await writeFile(input,"# Updated Fixture Core\n");await importCore(root,input);
  await exportCore(root,join(base,"readable.md"));assert.equal(await readFile(join(base,"readable.md"),"utf8"),"# Updated Fixture Core\n");
  await new PersonaStore(root).select("default");await new VoiceSettingsStore(root).update({tts:true});
  const out=join(base,"rollback");await rollbackExport(root,out,true,encryption);
  assert.equal(centralEnabled(out),false);assert.equal(JSON.parse(await readFile(join(out,"runtime/persona.json"),"utf8")).active,"default");assert.equal((await new VoiceSettingsStore(out).get()).tts,true);
  assert.equal((await loadCore(out)).text,"# Updated Fixture Core\n");
  const voice=new VoiceStore(out);try{assert.equal(voice.text("text-token")?.text,"fixture original voice");}finally{voice.close();}
}));
test("checkpoint removal/archive uses SQLite and never resurrects retained old files",()=>fixture(async root=>{
  const lanes=new LaneStore(root);await lanes.write("telegram:123",{version:1,model:"fixture",contextRevision:"fixture",contextItems:[]});
  const tickets=new ProviderDeliveryStore(join(root,"runtime/provider.json.deliveries"));await tickets.write("telegram:123",{provider:"siwc",id:"old"});
  await migrateState(root,true);await lanes.remove("telegram:123");await tickets.archiveLegacy("telegram:123");
  assert.equal(await new LaneStore(root).read("telegram:123"),undefined);assert.equal(await tickets.read("telegram:123"),undefined);
}));
test("relocation resolves old and stable attachment references without rewriting conversation keys",()=>fixture(async(root,base)=>{
  await migrateState(root,true);const s=new SessionStore(root);
  try{await s.append("telegram","123","123",[{id:"u2",role:"user",content:"new",at:"2026-10-21T04:00:00Z",attachments:[{kind:"image",path:join(root,"media/one.png")}]}]);}finally{s.close();}
  const moved=join(base,"moved");await cp(root,moved,{recursive:true});
  const sessions=new SessionStore(moved);try{const rows=(await sessions.get("wechat","fixture-wechat"))!.messages;assert.equal(rows.length,2);for(const row of rows)assert.equal(row.attachments?.[0]?.path,join(moved,"media/one.png"));}finally{sessions.close();}
}));
test("migration refuses a running instance and requires explicit stopped-writers acknowledgement",()=>fixture(async root=>{
  await assert.rejects(migrateState(root,false),/停止写入/);const lock=await acquireInstanceLock(root);
  try{await assert.rejects(migrateState(root,true),/active/);}finally{await lock.release();}
}));
