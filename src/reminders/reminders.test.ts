import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReminderStore} from './store.js';
import {ReminderRunner} from './runner.js';
import {ReminderTools} from './tools.js';
import {SessionStore} from '../sessions/store.js';
const now=new Date('2026-01-15T00:00:00Z');
const input={text:'Check the sample document',dueAt:'2026-01-15T08:05:00+08:00',timezone:'Asia/Shanghai',channel:'telegram' as const,target:'70001',source:'sample-message'};
async function fixture(work:(root:string,store:ReminderStore)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'sophon-reminder-'));const sessions=new SessionStore(root);
 try{await work(root,new ReminderStore(root));}finally{sessions.close();await rm(root,{recursive:true,force:true});}
}
test('reminders validate timezone, date, future bounds and content; duplicate tool retries create one persisted task',()=>fixture(async(root,store)=>{
 for(const dueAt of ['2026-01-15T12:00:00','2026-02-30T12:00:00Z','2026-01-15T24:00:00Z','2026-01-14T00:00:00Z','2028-01-15T00:00:00Z'])await assert.rejects(async()=>store.create({...input,dueAt},now));
 await assert.rejects(async()=>store.create({...input,text:''},now));
 const one=await store.create(input,now);assert.equal(one.dueAt,'2026-01-15T00:05:00.000Z');
 assert.equal((await store.create(input,now)).id,one.id);
 assert.equal((await new ReminderStore(root).list()).length,1);
 await store.cancel(one.id,now);assert.equal((await store.list())[0]!.status,'cancelled');
}));
test('due tasks survive restart, cancel before claim, send once and never retry uncertain delivery',()=>fixture(async(root,store)=>{
 const one=await store.create(input,now);
 const cancelled=await store.create({...input,source:'cancelled'},now);await store.cancel(cancelled.id,now);
 let calls=0;const runner=new ReminderRunner(new ReminderStore(root),async()=>true,async task=>{calls++;assert.equal(task.id,one.id);throw Error('synthetic network uncertainty');});
 await runner.tick(now);assert.equal(calls,0);
 const due=new Date('2026-01-15T00:05:00Z');
 await Promise.all([runner.tick(due),runner.tick(due)]);assert.equal(calls,1);
 assert.equal((await store.list()).find(t=>t.id===one.id)!.status,'unknown');
 await runner.tick(due);assert.equal(calls,1);
}));
test('confirmed sends are delivered; interrupted sends become unknown; unavailable tasks expire after 24 hours',()=>fixture(async(root,store)=>{
 const task=await store.create(input,now);let sends=0;
 const runner=new ReminderRunner(store,async()=>true,async()=>{sends++;});
 await runner.tick(new Date('2026-01-15T00:07:00Z'));assert.equal(sends,1);
 assert.equal((await store.list())[0]!.status,'delivered');assert.equal((await store.list())[0]!.late,true);
 const interrupted=await store.create({...input,source:'interrupted'},now);await store.claim(interrupted.id,new Date(task.dueAt));
 await new ReminderStore(root).recover();assert.equal((await store.list()).find(t=>t.id===interrupted.id)!.status,'unknown');
 const waiting=await store.create({...input,source:'unavailable'},now);
 const unavailable=new ReminderRunner(store,async()=>false,async()=>assert.fail('no configured target'));
 await unavailable.tick(new Date(task.dueAt));assert.equal((await store.list()).find(t=>t.id===waiting.id)!.status,'pending');
 await unavailable.tick(new Date('2026-01-17T00:05:00Z'));assert.equal((await store.list()).find(t=>t.id===waiting.id)!.status,'expired');
 await assert.rejects(store.cancel(task.id));
}));
test('tool permissions are rechecked and channel/target come from the authenticated message',()=>fixture(async(_root,store)=>{
 const tools=new ReminderTools(store,m=>m.senderId==='70001'&&m.conversationId==='70001','UTC',()=>now);
 const message={channel:'telegram' as const,senderId:'70001',conversationId:'70001',messageId:'sample',text:'Remind me',receivedAt:now.toISOString(),attachments:[]};
 assert.equal(tools.tools({...message,senderId:'70002'}).length,0);
 await assert.rejects(tools.execute('gateway_reminder_create',input,{...message,senderId:'70002'}));
 await tools.execute('gateway_reminder_create',{...input,target:'70002'},message);
 assert.equal((await store.list())[0]!.target,'70001');
 assert.match(JSON.stringify(await tools.execute('gateway_reminder_create',{text:'Sample',dueAt:'ambiguous'},message)),/isError/);
}));
