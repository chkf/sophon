import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeGateway} from '../setup.js';
import {mainPath,openDatabase} from '../state/database.js';
import {SessionStore,messageRevision} from '../sessions/store.js';
import {migrateMemory,inspectMemory} from './migration.js';
import {MemoryStore} from './store.js';
import {beginBootstrap,bootstrapStatus} from './bootstrap.js';
import {MemoryWorker} from './worker.js';
import {MemoryRecent} from './recent.js';
import {LocalKnowledgeStore} from '../knowledge/store.js';
import {parseClassification} from './validation.js';
import {memoryWindow,buildMemoryRebase,memoryWindowDue} from '../runtime/siwc/memory-rebase.js';
import {compactChatHistory} from '../runtime/siwc/chat-compaction.js';
import {historyFromMessages} from '../runtime/history.js';
import {ControlMemory} from '../control/memory.js';
const owner='70001',at='2026-10-26T08:00:00.000Z';
const result={schema_version:1,decision:'STORE',kind:'plan',importance:0.7,gist:'用户计划整理文档索引。',labels:[{topic_id:'t1',score:0.9}],proposed_topics:[{client_temp_id:'t1',parent_id:null,name:'文档整理',description:'目录和索引管理',aliases:[]}],relation_hints:[]};
async function fixture(run:(root:string,sessions:SessionStore,graph:MemoryStore)=>Promise<void>){
 const base=await mkdtemp(join(tmpdir(),'memory-public-')),root=join(base,'data');
 let sessions:SessionStore|undefined;let db:ReturnType<typeof openDatabase>|undefined;
 try {await initializeGateway(root);await migrateMemory(root,true);sessions=new SessionStore(root);db=openDatabase(mainPath(root));await run(root,sessions,new MemoryStore(db,'telegram:'+owner));}
 finally {db?.close();sessions?.close();await rm(base,{recursive:true,force:true});}
}
async function exchange(sessions:SessionStore,id='sample'){
 await sessions.append('telegram',owner,owner,[{role:'user',content:'下周整理文档索引。',at,id:id+'-u',origin:'chat'},
 {role:'assistant',content:'已记录文档整理计划。',at,id:id+'-a',origin:'chat',partial:false}]);
}
test('memory migration is explicit, snapshotted and idempotent',()=>fixture(async(root)=>{
 await assert.rejects(migrateMemory(root,false),/停止/);
 const state=await inspectMemory(root);assert.equal(state.version,2);
 assert.equal((await migrateMemory(root,true)).changed,false);
}));
test('bootstrap covers complete exchanges, worker persists grounded topics and readiness',()=>fixture(async(root,sessions,graph)=>{
 await exchange(sessions);assert.equal(graph.context().ready,false);
 beginBootstrap(graph);assert.equal(bootstrapStatus(graph).ready,false);
 let calls=0;const worker=new MemoryWorker(graph,{reply:async()=>{throw Error('unused');},classifyMemory:async input=>{
  calls++;assert.match(input,/下周整理文档索引/);return JSON.stringify(result);
 }});
 await worker.tick(new Date(Date.now()+1000));assert.equal(calls,1);assert.equal(bootstrapStatus(graph).ready,true);
 assert.equal(graph.topics()[0].name,'文档整理');assert.equal(graph.context().ready,true);
 const ui=new ControlMemory(graph.db,{ownerId:owner,enabled:true},sessions);assert.equal(ui.overview().available,true);
 assert.equal(Number(graph.db.prepare('SELECT count(*) n FROM memory_sources').get()!.n),2);
 const snapshot=await sessions.view('telegram',owner);assert.equal(snapshot.history.count,2);
 assert.equal(beginBootstrap(graph).enqueuedNow,0);await worker.stop();
}));
test('delivered chat queues once and partial or proactive messages do not qualify',()=>fixture(async(root,sessions,graph)=>{
 sessions.enableMemory(owner);await exchange(sessions);await exchange(sessions);
 assert.equal(Number(graph.db.prepare('SELECT count(*) n FROM memory_jobs').get()!.n),1);
 await sessions.append('telegram',owner,owner,[{role:'assistant',content:'部分输出',at,id:'partial',origin:'chat',partial:true},
 {role:'assistant',content:'定时提示',at,id:'proactive',origin:'proactive',partial:false}]);
 assert.equal(Number(graph.db.prepare('SELECT count(*) n FROM memory_jobs').get()!.n),1);
}));
test('classification rejects changed evidence and malformed output without partial nodes',()=>fixture(async(_root,sessions,graph)=>{
 await exchange(sessions);beginBootstrap(graph);const job=graph.claim(new Date(Date.now()+1000))!;
 const turn=graph.collect(job.assistant_rowid),revision=graph.revision();
 graph.db.prepare('UPDATE messages SET content=? WHERE rowid=?').run('修订后的合成记录',turn.sources[0].rowid);
 assert.throws(()=>graph.complete(job,turn,revision,parseClassification(JSON.stringify(result))),/SOURCE_CHANGED/);
 assert.equal(Number(graph.db.prepare('SELECT count(*) n FROM memory_nodes').get()!.n),0);
 assert.throws(()=>parseClassification('{"decision":"STORE"}'));
}));
test('missing classifier retries without falling back to a paid reply',()=>fixture(async(_root,sessions,graph)=>{
 await exchange(sessions);beginBootstrap(graph);let replies=0;
 const worker=new MemoryWorker(graph,{reply:async()=>{replies++;return {text:'unused'};}});
 await worker.tick(new Date(Date.now()+1000));assert.equal(replies,0);assert.equal(bootstrapStatus(graph).ready,false);
 assert.equal(graph.db.prepare('SELECT status FROM memory_jobs').get()!.status,'retry');await worker.stop();
}));
test('Recent integration is explicit and retains authoritative content',()=>fixture(async(root,sessions,graph)=>{
 await exchange(sessions);const knowledge=new LocalKnowledgeStore(root,'formal');
 try {const integration=new MemoryRecent(graph);assert.equal(integration.enabled(),false);
 beginBootstrap(graph);assert.equal(integration.enabled(),true);assert.deepEqual(integration.remainingDirectory(knowledge.listRecent()),[]);
 } finally {knowledge.close();}
}));
test('calendar window retains crossing-midnight exchanges and incomplete old turns',async()=>{
 const rows:any[]=[{role:'user',content:'旧问题',at:'2026-10-20T00:00:00Z'}, {role:'assistant',content:'旧答复',at:'2026-10-20T00:00:01Z'},
 {role:'user',content:'跨日问题',at:'2026-10-23T23:59:00Z'}, {role:'assistant',content:'跨日答复',at:'2026-10-24T00:01:00Z'},
 {role:'user',content:'待回答问题',at:'2026-10-26T01:00:00Z'}];
 const history=historyFromMessages(rows),now=new Date(at);const window=await memoryWindow(history,now,'UTC');
 assert.equal(window.fromSeq,2);assert.deepEqual(window.messages,rows.slice(2));
 const built=await buildMemoryRebase(history,{enabled:true,ready:true,revision:1,content:'{}'},'UTC',now);
 assert.equal(memoryWindowDue(built.metadata,'UTC',now),false);
 assert.equal(memoryWindowDue(built.metadata,'UTC',new Date('2026-10-27T00:01:00Z')),true);
 assert.equal((await memoryWindow(historyFromMessages(rows.slice(0,1)),now,'UTC')).messages.length,1);
});
test('chat compaction uses only transcript and requires an actual opaque checkpoint',async()=>{
 const history=historyFromMessages([{role:'user',content:'目录问题',at},{role:'assistant',content:'目录答复',at}]);let request:any;
 const opts={sessionId:'synthetic',model:'fixture',history,items:[{role:'developer',content:'EXCLUDED_POLICY'}],reason:'seven_days' as const,now:()=>new Date(at),send:async(r:any)=>{request=r;return {id:'result',output:[{type:'compaction',encrypted_content:'fixture-opaque'}],status:'completed'} as any;}};
 const compacted=await compactChatHistory(opts);assert.equal(compacted?.checkpoint.source,'chat');
 assert.doesNotMatch(JSON.stringify(request),/EXCLUDED_POLICY/);assert.match(JSON.stringify(request),/目录问题/);
 assert.equal(await compactChatHistory({...opts,send:async()=>({id:'r',output:[],status:'completed'} as any)}),undefined);
});

test('deleting source text invalidates graph evidence and preserves remaining transcript',()=>fixture(async(_root,sessions,graph)=>{
 await exchange(sessions);beginBootstrap(graph);
 const job=graph.claim(new Date(Date.now()+1000))!,turn=graph.collect(job.assistant_rowid);
 graph.complete(job,turn,graph.revision(),parseClassification(JSON.stringify(result)));
 assert.ok(graph.search('文档整理').length);
 const user=(await sessions.readRange('telegram',owner,0,1))[0];
 assert.equal(await sessions.deleteMessage('telegram',owner,0,messageRevision(user)),'deleted');
 assert.equal(graph.search('文档整理').length,0);
 assert.equal(graph.db.prepare('SELECT status FROM memory_nodes').get()!.status,'stale');
 assert.equal(bootstrapStatus(graph).ready,false);
 assert.equal((await sessions.view('telegram',owner)).history.count,1);
}));
