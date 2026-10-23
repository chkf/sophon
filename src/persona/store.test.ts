import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedPersonaDatabase, writeLegacyPersonaFixture } from "../../scripts/testing/persona-fixture.mjs";
import { PersonaStore, personaInstruction, parsePersonaKeywords } from "./store.js";
import { mainPath, openDatabase, readPersonaDocument, writePersonaDocument } from "../state/database.js";
import { executeLocalContextTool } from "../core/tools.js";
async function temp(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "persona-db-"));
  try { await run(root); } finally { await rm(root, {recursive:true,force:true}); }
}
test("SQLite Persona preserves every preset, selection, keyword order and global switch across restart",()=>temp(async root=>{
  const presets={default:["SMART","CALM"],cool:["MY_COOL"],terse:["MY_CUSTOM"],formal:["PRECISE"],custom:["INDEPENDENT","CLEAR"]};
  await seedPersonaDatabase(root,"cool",presets);
  const store=new PersonaStore(root),before=await store.snapshot();
  assert.equal(before.active,"cool");assert.deepEqual({...before.presets},presets);
  assert.equal(before.showStageDirections,false);
  await store.setShowStageDirections(true);await store.select("custom");
  await store.define("extra",["CONCISE"]);await store.remove("extra");
  const reopened=await new PersonaStore(root).snapshot();
  assert.equal(reopened.active,"custom");assert.equal(reopened.showStageDirections,true);
  assert.deepEqual({...reopened.presets},presets);
  await writeLegacyPersonaFixture(root,"default",{default:["STALE"]});
  assert.deepEqual(await store.snapshot(),reopened,"retained JSON never replaces SQLite");
  const db=openDatabase(mainPath(root));try{assert.equal(readPersonaDocument(db)?.showStageDirections,true);}finally{db.close();}
}));
test("missing/corrupt SQLite Persona never falls back to a JSON or code preset",()=>temp(async root=>{
  await writeLegacyPersonaFixture(root);
  await assert.rejects(new PersonaStore(root).snapshot(),/数据库缺失/);
  await seedPersonaDatabase(root);
  const db=openDatabase(mainPath(root));try{db.exec("DELETE FROM context WHERE kind='persona'");}finally{db.close();}
  await assert.rejects(new PersonaStore(root).snapshot(),/Persona 缺失/);
  assert.match(await readFile(join(root,"runtime/persona.json"),"utf8"),/CLEAR/);
}));
test("global setting is preserved by revision-checked model Persona edits and validates its type",()=>temp(async root=>{
  await seedPersonaDatabase(root);
  const store=new PersonaStore(root);await store.setShowStageDirections(true);
  const initial:any=await executeLocalContextTool(root,"formal","gateway_persona_read",{});
  await executeLocalContextTool(root,"formal","gateway_persona_write",{active:"default",presets:{default:["CLEAR"]},expected_revision:initial.persona.revision});
  assert.equal((await store.snapshot()).showStageDirections,true);
  await assert.rejects(executeLocalContextTool(root,"formal","gateway_persona_write",{active:"default",presets:{default:["BAD"]},expected_revision:initial.persona.revision}),/revision/);
  const db=openDatabase(mainPath(root));try{assert.throws(()=>writePersonaDocument(db,{version:2,active:"default",presets:{default:["CLEAR"]},showStageDirections:"false"}),/开关/);}finally{db.close();}
  assert.throws(()=>store.remove("default"),/不能删除/);
  assert.throws(()=>parsePersonaKeywords("A A"),/不重复/);
  assert.throws(()=>store.define("../escape",["A"]),/模式名/);
}));
test("neutral style does not request roleplay by default",()=>{
  const state={active:"custom",presets:{custom:["CLEAR"]},showStageDirections:false};
  assert.doesNotMatch(personaInstruction(state),/始终生成描写|每次回复先生成/);
  assert.match(personaInstruction(state),/保持事实准确/);
  assert.match(personaInstruction({...state,showStageDirections:true}),/用户明确要求角色扮演/);
});
