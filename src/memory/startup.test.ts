import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeGateway} from '../setup.js';
import {GatewayService} from '../service.js';
import type {GatewayConfig} from '../config/index.js';
import type {ManagedChatRuntime} from '../runtime/types.js';
import {SessionStore} from '../sessions/store.js';
import {acquireInstanceLock,readInstanceOwner} from '../service/instance-lock.js';
import {inspectMemory,inspectBootstrap} from './migration.js';
import {prepareStartupMemory} from './startup.js';
import {mainPath,openDatabase} from '../state/database.js';
import {MemoryWorker} from './worker.js';
import {MemoryStore} from './store.js';

const owner='70001';
const runtime={reply:async()=>{throw Error('No model calls during startup');},close:async()=>{}} as ManagedChatRuntime;
function config(dataDir:string):GatewayConfig{return {dataDir,siwcDevkitDir:join(dataDir,'optional-adapter'),maxToolRounds:1,
 telegram:{token:'synthetic-token',ownerId:owner},server:{host:'127.0.0.1',port:8790},
 heartbeat:{enabled:false,timezone:'UTC',quietStart:'01:00',quietEnd:'07:00',cooldownMinutes:60,dailyCap:1,minIntervalMinutes:60,maxIntervalMinutes:120}};}
async function fixture(work:(data:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'memory-startup-')),data=join(root,'state');try{await initializeGateway(data);await work(data);}finally{await rm(root,{recursive:true,force:true});}}
test('default startup prepares a fresh graph with one verified snapshot and keeps its lock',()=>fixture(async data=>{
 const service=await GatewayService.create(config(data),runtime);
 try{
  assert.equal((await inspectMemory(data)).version,2);
  assert.equal((await inspectBootstrap(data,'telegram:'+owner)).initialized,true);
  assert.equal((await readdir(join(data,'.memory-migration'))).length,1);
  assert.ok(await readInstanceOwner(data));await assert.rejects(acquireInstanceLock(data),/still active/);
 }finally{await service.stop();}
 assert.equal(await readInstanceOwner(data),undefined);
 const next=await GatewayService.create(config(data),runtime);
 try{assert.equal((await readdir(join(data,'.memory-migration'))).length,1);}finally{await next.stop();}
}));
test('existing complete synthetic history is queued once and original messages are preserved',()=>fixture(async data=>{
 const sessions=new SessionStore(data);
 try{await sessions.append('telegram',owner,owner,[{role:'user',content:'整理合成测试目录。',at:'2026-01-01T00:00:00Z',id:'sample-u',origin:'chat'},{role:'assistant',content:'可以按日期建立索引。',at:'2026-01-01T00:00:01Z',id:'sample-a',origin:'chat',partial:false}]);}finally{sessions.close();}
 for(let i=0;i<2;i++){
  const service=await GatewayService.create(config(data),runtime);
  try{
   const progress=await inspectBootstrap(data,'telegram:'+owner);assert.equal(progress.jobs.pending,1);assert.equal(progress.missingTurns,0);
   const db=openDatabase(mainPath(data),true);try{assert.equal(db.prepare('SELECT count(*) n FROM messages').get()!.n,2);}finally{db.close();}
  }finally{await service.stop();}
 }
 assert.equal((await readdir(join(data,'.memory-migration'))).length,1);
}));
test('explicit off leaves the memory extension uninstalled',()=>fixture(async data=>{
 for(const settings of [{...config(data),memoryGraphEnabled:false}]){
  const service=await GatewayService.create(settings,runtime);
  try{assert.equal((await inspectMemory(data)).installed,false);}finally{await service.stop();}
 }
}));
test('snapshot failure preserves chat data and does not prevent service construction',()=>fixture(async data=>{
 await writeFile(join(data,'.memory-migration'),'synthetic obstruction');
 const service=await GatewayService.create(config(data),runtime);
 try{assert.equal((await inspectMemory(data)).installed,false);}finally{await service.stop();}
}));
test('startup preparation refuses to mutate state without the active instance lock',()=>fixture(async data=>{
 await assert.rejects(prepareStartupMemory(data,owner,{pid:process.pid,startedAt:'',takeoverToken:'invalid',release:async()=>{}}),/instance lock/);
 assert.equal((await inspectMemory(data)).installed,false);
}));
test('unavailable memory model is visible without invoking ordinary chat',()=>fixture(async data=>{
 const lock=await acquireInstanceLock(data);try{await prepareStartupMemory(data,owner,lock);}finally{await lock.release();}
 const db=openDatabase(mainPath(data));
 try{
  const worker=new MemoryWorker(new MemoryStore(db,'telegram:'+owner),{reply:async()=>{assert.fail('No paid fallback');},getMemoryModel:async()=>{throw Error('Synthetic unavailable model');}});
  await worker.tick();assert.equal(worker.status(),'MODEL_UNAVAILABLE');await worker.stop();
 }finally{db.close();}
}));
test('automatic catchup queues new history without resetting a terminal failure',()=>fixture(async data=>{
 const append=async(id:string)=>{
  const sessions=new SessionStore(data);
  try{await sessions.append('telegram',owner,owner,[{role:'user',content:'合成目录请求',at:'2026-01-01T00:00:00Z',id:id+'-u',origin:'chat'},{role:'assistant',content:'合成目录答复',at:'2026-01-01T00:00:01Z',id:id+'-a',origin:'chat',partial:false}]);}finally{sessions.close();}
 };
 await append('first');const first=await GatewayService.create(config(data),runtime);await first.stop();
 const db=openDatabase(mainPath(data));try{db.prepare("UPDATE memory_jobs SET status='failed',attempts=3,error_code='INVALID_CLASSIFICATION'").run();}finally{db.close();}
 await append('second');const next=await GatewayService.create(config(data),runtime);
 try{const state=await inspectBootstrap(data,'telegram:'+owner);assert.equal(state.jobs.failed,1);assert.equal(state.jobs.pending,1);}finally{await next.stop();}
}));
