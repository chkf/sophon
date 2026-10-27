import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HeartbeatRunner} from './runner.js';
import {SessionStore} from '../sessions/store.js';
import {localContext} from '../core/context-fixture.js';
import type {ChatRequest} from '../runtime/types.js';

test('scheduled decision can choose MCP then stay silent; repeated and unauthorized calls are blocked',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sophon-scheduled-mcp-'));
 const sessions=new SessionStore(root);
 let discoveries=0,calls=0;
 try{
  const mcp={async proactiveTools(){discoveries++;return [{name:'mcp_lookup',parameters:{type:'object'},readOnly:false,replaySafe:false}];},async executeProactive(){calls++;return {value:'synthetic result'};}};
  const runtime={async reply(request:ChatRequest){
   if(request.purpose==='heartbeat_plan'){assert.equal(request.tools,undefined);return {text:'{"wakes":[]}'};}
   assert.deepEqual(request.tools?.map(t=>t.name),['mcp_lookup']);
   await assert.rejects(request.executeTool!('mcp_forbidden',{}));
   assert.deepEqual(await request.executeTool!('mcp_lookup',{query:{b:2,a:1}}),{value:'synthetic result'});
   assert.match(JSON.stringify(await request.executeTool!('mcp_lookup',{query:{a:1,b:2}})),/MCP_DUPLICATE_CALL/);
   return {text:'SILENT'};
  }};
  const config={enabled:true,planningEnabled:false,timezone:'UTC',quietStart:'01:00',quietEnd:'07:00',cooldownMinutes:60,dailyCap:8,minIntervalMinutes:60,maxIntervalMinutes:120};
  const context={async load(){return {available:true,data:localContext().data};}};
  const router={async resolve(){return {channel:'telegram',target:'70001'};},async sendIfActive(){assert.fail('silent decision must not send');}};
  const runner=new HeartbeatRunner(root,config,runtime as never,sessions,context as never,router as never,undefined,undefined,undefined,undefined,undefined,undefined,undefined,mcp);
  await runner.tick(new Date('2026-01-15T03:00:00Z'));assert.equal(discoveries,0);
  await runner.tick(new Date('2026-01-15T10:00:00Z'));assert.equal(calls,1);
  config.planningEnabled=true;
  await runner.tick(new Date('2026-01-16T10:00:00Z'));assert.equal(discoveries,1);
 }finally{sessions.close();await rm(root,{recursive:true,force:true});}
});
