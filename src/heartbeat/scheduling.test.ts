import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setImmediate} from 'node:timers/promises';
import {HeartbeatRunner} from './runner.js';
import {nextMorning,nextPlannedCheck} from './clock.js';
import {parseWakePlan,type DailyWakePlan} from './planner.js';
import {ReminderRunner} from '../reminders/runner.js';
import {ReminderStore} from '../reminders/store.js';
import {avoidReminderWakes,reminderBlocks} from '../reminders/heartbeat.js';
import {controlHeartbeatTiming} from '../control/heartbeat.js';
import {SerialQueue} from '../util/serial-queue.js';
import {localContext} from '../core/context-fixture.js';
import type {HeartbeatConfig} from '../config/index.js';
const config:HeartbeatConfig={enabled:true,planningEnabled:true,timezone:'UTC',quietStart:'23:00',quietEnd:'07:00',cooldownMinutes:30,dailyCap:4,minIntervalMinutes:60,maxIntervalMinutes:60};
const now=new Date('2030-01-02T08:00:00Z');
const makePlan=():DailyWakePlan=>({date:'2030-01-02',channel:'telegram',generatedAt:now.toISOString(),wakes:[{time:'09:00',intent:'Review document A'},{time:'12:00',intent:'Review document B'}]});
const settle=async()=>{for(let n=0;n<30;n++)await setImmediate();};

test('incremental plans retain unaffected candidates and reject cross-day or cross-channel reuse',()=>{
 const previous=makePlan();previous.wakes.unshift({time:'07:30',intent:'Completed sample',consumed:true});
 const parse=(value:unknown,old=previous)=>parseWakePlan(JSON.stringify(value),now,'UTC','23:00','07:00',4,'telegram',undefined,old);
 assert.deepEqual(parse({keep:true}).wakes.map(w=>w.time),['09:00','12:00']);
 assert.deepEqual(parse({remove:['09:00'],wakes:[{time:'10:00',intent:'Revised review'}]}).wakes.map(w=>w.time),['10:00','12:00']);
 assert.throws(()=>parse({keep:true},{...previous,date:'2030-01-01'}));
 assert.throws(()=>parse({keep:true},{...previous,channel:'wechat'}));
 assert.throws(()=>parse({keep:false}));assert.throws(()=>parse({remove:['18:00'],wakes:[]}));
});

test('deadlines use local calendar time across DST and wait until tomorrow for an empty plan',()=>{
 const dst={...config,timezone:'America/New_York'};
 assert.equal(new Date(nextMorning(new Date('2030-03-10T06:30:00Z'),dst)).toISOString(),'2030-03-10T11:00:00.000Z');
 assert.equal(new Date(nextMorning(new Date('2030-11-03T05:30:00Z'),dst)).toISOString(),'2030-11-03T12:00:00.000Z');
 assert.equal(new Date(nextPlannedCheck(now,config,{dateKey:'2030-01-02',sentToday:0,recent:[],plan:makePlan()})).toISOString(),'2030-01-02T09:00:00.000Z');
 assert.equal(new Date(nextPlannedCheck(now,config,{dateKey:'2030-01-02',sentToday:0,recent:[],plan:{...makePlan(),wakes:[]}})).toISOString(),'2030-01-03T07:00:00.000Z');
});

test('unified scheduler delivers a reminder while proactive is paused and does not poll an idle model',async t=>{
 const root=await mkdtemp(join(tmpdir(),'sophon-scheduler-'));let sends=0;let runner:HeartbeatRunner|undefined;
 t.mock.timers.enable({apis:['Date','setTimeout'],now});
 const store=new ReminderStore(root,()=>runner?.requestCheck());
 const delivery=new ReminderRunner(store,async()=>true,async()=>{sends++;});
 runner=new HeartbeatRunner(root,config,{reply:async()=>{assert.fail('Paused model must not run');}},{} as any,{} as any,{} as any,
  undefined,()=>true,undefined,new SerialQueue(),undefined,undefined,undefined,undefined,undefined,undefined,store,delivery);
 try{
  await runner.start();t.mock.timers.tick(1);await (runner as any).pendingTick;await settle();
  assert.equal(runner.scheduling().nextActionAt,null);
  const task=await store.create({text:'Check sample report',dueAt:'2030-01-02T08:05:00Z',timezone:'UTC',channel:'telegram',target:'70001',source:'sample'},new Date());
  t.mock.timers.tick(1);await (runner as any).pendingTick;await settle();assert.equal(sends,0);
  t.mock.timers.tick(300_000);await (runner as any).pendingTick;await settle();assert.equal(sends,1);
  assert.equal((await store.list()).find(r=>r.id===task.id)?.status,'delivered');
  t.mock.timers.tick(60*60_000);await (runner as any).pendingTick;await settle();assert.equal(sends,1);
 }finally{await runner.stop();await rm(root,{recursive:true,force:true});}
});

test('interval updates re-arm the scheduler without waiting for an old timeout',async t=>{
 const root=await mkdtemp(join(tmpdir(),'sophon-interval-'));let interval={minIntervalMinutes:60,maxIntervalMinutes:60,revision:"initial"};
 t.mock.timers.enable({apis:['Date','setTimeout'],now});
 const runner=new HeartbeatRunner(root,{...config,planningEnabled:false},{reply:async()=>{assert.fail('Not due');}},{} as any,{} as any,{} as any,
  undefined,()=>false,undefined,undefined,undefined,undefined,undefined,undefined,undefined,async()=>interval);
 try{
  await runner.start();t.mock.timers.tick(1);await (runner as any).pendingTick;await settle();assert.match(runner.scheduling().nextActionAt!,/T09:00/);
  interval={minIntervalMinutes:30,maxIntervalMinutes:30,revision:"updated"};runner.requestCheck();t.mock.timers.tick(1);await (runner as any).pendingTick;await settle();
  assert.match(runner.scheduling().nextActionAt!,/T08:30/);
 }finally{await runner.stop();await rm(root,{recursive:true,force:true});}
});

test('reminder reservations remove only colliding wakes, allow cancellation and survive midnight',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sophon-reservations-'));
 try{
  const store=new ReminderStore(root);const item=await store.create({text:'Review sample',dueAt:'2030-01-02T09:15:00Z',timezone:'UTC',channel:'telegram',target:'70001',source:'sample'},now);
  const plan=makePlan();avoidReminderWakes(plan,[item],'UTC');assert.deepEqual(plan.wakes.map(w=>w.time),['12:00']);
  assert.equal(reminderBlocks([item],new Date('2030-01-02T08:45:00Z')),true);
  const cancelled=await store.cancel(item.id,now);assert.equal(reminderBlocks([cancelled],new Date(item.dueAt)),false);
  const midnight={...item,dueAt:'2030-01-03T00:10:00Z'};assert.equal(reminderBlocks([midnight],new Date('2030-01-02T23:50:00Z')),true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a conflicting reminder requests incremental review while unrelated candidates survive',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sophon-plan-review-'));let calls=0;
 const store=new ReminderStore(root);const sessions={latestActivityAt:async()=>undefined,latestConversation:async()=>({conversationId:'70001'}),get:async()=>({messages:[]})};
 const runner=new HeartbeatRunner(root,config,{reply:async request=>{calls++;assert.equal(request.purpose,'heartbeat_plan');return {text:calls===1?JSON.stringify({wakes:makePlan().wakes}):'{"keep":true}'};}},
  sessions as any,{load:async()=>localContext()} as any,{resolve:async()=>({channel:'telegram',target:'70001'})} as any,
  undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,store);
 try{
  await runner.tick(now);assert.equal(calls,1);
  await store.create({text:'Review sample',dueAt:'2030-01-02T09:10:00Z',timezone:'UTC',channel:'telegram',target:'70001',source:'sample'},now);
  await runner.tick(new Date('2030-01-02T08:30:00Z'));assert.equal(calls,2);
  const state=JSON.parse(await readFile(join(root,'heartbeat/state.json'),'utf8'));assert.deepEqual(state.plan.wakes.map((w:any)=>w.time),['12:00']);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('control timing excludes stale, consumed, disabled and wrong-mode schedules',()=>{
 const state={dateKey:'2030-01-02',sentToday:0,recent:[],plan:makePlan(),nextCheckAt:'2030-01-02T10:00:00Z'};
 assert.equal(controlHeartbeatTiming(state,true,'UTC','telegram',now).nextPlannedWake,'09:00');
 assert.equal(controlHeartbeatTiming(state,false,'UTC','telegram',now).nextPlannedWake,null);
 assert.equal(controlHeartbeatTiming(state,true,'UTC','wechat',now).nextPlannedWake,null);
 assert.equal(controlHeartbeatTiming(state,true,'UTC','telegram',now,false).nextPlannedWake,null);
 state.plan.wakes[0]!.consumed=true;assert.equal(controlHeartbeatTiming(state,true,'UTC','telegram',now).nextPlannedWake,'12:00');
 assert.equal(controlHeartbeatTiming(state,false,'UTC','telegram',new Date('2030-01-02T11:00:00Z')).nextCheckAt,null);
});
