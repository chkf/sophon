import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeGateway} from '../setup.js';
import {ExpressionStore,expressionInstruction,EXPRESSION_KEY} from './store.js';
import {mainPath,openDatabase,putState,PERSONA_META_KEY} from '../state/database.js';
import {LOCAL_CONTEXT_TOOLS,executeLocalContextTool} from '../core/tools.js';
import {LocalCoreContextProvider} from '../core/context.js';
import {renderLocalPolicy} from '../core/render.js';
import {CommandPanels} from '../commands/panels.js';
import {TELEGRAM_COMMANDS} from '../commands/router.js';

test('independent expression panel preserves both mental and action descriptions across restart',async()=>{
 const base=await mkdtemp(join(tmpdir(),'expression-test-')),root=join(base,'data');
 try {
  await initializeGateway(root);const store=new ExpressionStore(root);
  const panel=new CommandPanels({} as any,{} as any,store,{} as any,'','UTC',async()=> '');
  assert.equal(TELEGRAM_COMMANDS.some(c=>String(c.command)==='persona'),false);
  const first=await panel.expression();await first.rows[0][0].run();
  assert.equal((await new ExpressionStore(root).snapshot()).showStageDirections,true);
  assert.match(expressionInstruction(await store.snapshot()),/心理和动作描写已开启/);
  const context=new LocalCoreContextProvider(root,()=>'',()=>store.snapshot());
  const on=await context.load();assert.match(renderLocalPolicy(on),/虚构/);
  await (await panel.expression()).rows[0][0].run();
  assert.equal((await store.snapshot()).showStageDirections,false);
  assert.notEqual((await context.load()).data!.coreRevision,on.data!.coreRevision);
 } finally {await rm(base,{recursive:true,force:true});}
});

test('legacy display boolean migrates once without loading presets or exposing retired tools',async()=>{
 const base=await mkdtemp(join(tmpdir(),'expression-migration-')),root=join(base,'data');
 try {
  await initializeGateway(root);const db=openDatabase(mainPath(root));
  db.prepare('DELETE FROM gateway_state WHERE key=?').run(EXPRESSION_KEY);
  putState(db,{key:PERSONA_META_KEY,value:JSON.stringify({showStageDirections:true,active:'old',presets:{old:['SYNTHETIC_MARKER']}})});
  db.close();
  const value=await new ExpressionStore(root).snapshot();assert.deepEqual(value,{showStageDirections:true});
  assert.doesNotMatch(expressionInstruction(value),/SYNTHETIC_MARKER|old/);
  assert.equal(LOCAL_CONTEXT_TOOLS.some(t=>t.name.includes('persona')),false);
  await assert.rejects(executeLocalContextTool(root,'formal','gateway_persona_write',{}),/未知/);
 } finally {await rm(base,{recursive:true,force:true});}
});
