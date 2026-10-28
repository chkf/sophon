import { selectTestTurn } from "../testing/turn-decision.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Gateway} from '../gateway.js';
import {SessionStore} from '../sessions/store.js';
import {LocalCoreContextProvider} from '../core/context.js';
import {initializeGateway} from '../setup.js';
import {ReminderStore} from './store.js';
import {ReminderTools} from './tools.js';
test('formal owner chat actually creates a persisted reminder through the model tool callback',async()=>{
 const base=await mkdtemp(join(tmpdir(),'sophon-reminder-gateway-')),root=join(base,'state');await initializeGateway(root);
 const sessions=new SessionStore(root),store=new ReminderStore(root);const now=new Date('2026-01-15T00:00:00Z');
 const tools=new ReminderTools(store,m=>m.senderId==='70001','UTC',()=>now);
 const gateway=new Gateway({reply:async request=>{
  await selectTestTurn(request,{groups:['plans']});
  assert.ok(request.tools?.some(t=>t.name==='gateway_reminder_create'));
  assert.match(request.instructions!,/创建成功后确认/);
  await request.executeTool!('gateway_reminder_create',{text:'Review sample document',dueAt:'2026-01-15T01:00:00Z'});
  return {text:'Reminder scheduled for 01:00 UTC.'};
 }},sessions,new LocalCoreContextProvider(root),1,'UTC',()=>now,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,tools);
 try{
  await gateway.handle({channel:'telegram',senderId:'70001',conversationId:'70001',messageId:'sample',text:'Remind me in one hour to review the document',receivedAt:now.toISOString(),attachments:[]});
  assert.equal((await store.list()).length,1);
 }finally{sessions.close();await rm(base,{recursive:true,force:true});}
});
