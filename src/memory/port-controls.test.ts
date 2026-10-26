import {SiwcRuntime} from "../runtime/siwc/index.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeGateway} from '../setup.js';
import {migrateMemory} from './migration.js';
import {mainPath,openDatabase} from '../state/database.js';
import {MemoryStore} from './store.js';
import {SessionStore} from '../sessions/store.js';
import {ControlMemory} from '../control/memory.js';
import {beginBootstrap} from './bootstrap.js';
import {MemoryWorker} from './worker.js';
import {parseClassification} from './validation.js';
import {defaultMemoryPrompt,listMemoryPrompts,saveMemoryPrompt} from './prompts.js';

test('root-only output is valid only for routing; first-person instructions preserve evidence',()=>{
 const roots={schema_version:1,decision:'STORE',labels:[{topic_id:'documents',score:0.8}]};
 assert.equal(parseClassification(JSON.stringify(roots),'roots').gist,undefined);
 assert.throws(()=>parseClassification(JSON.stringify(roots)),/INVALID_CLASSIFICATION/);
 assert.throws(()=>parseClassification(JSON.stringify({...roots,importance:2}),'roots'),/INVALID_CLASSIFICATION/);
 for(const id of ['classify','digest','fuse','verify'] as const){
   const prompt=defaultMemoryPrompt(id);assert.match(prompt,/“我”仅指 assistant/);assert.match(prompt,/“你”仅指 user/);assert.match(prompt,/不改写引用中的人称/);
 }
});

test('routing restart, graph edits, prompt revisions and reset preserve original evidence',async()=>{
 const base=await mkdtemp(join(tmpdir(),'sophon-edit-fixture-')),root=join(base,'data');let sessions:SessionStore|undefined,db:ReturnType<typeof openDatabase>|undefined;
 try{
  await initializeGateway(root);await migrateMemory(root,true);sessions=new SessionStore(root);db=openDatabase(mainPath(root));
  await sessions.append('telegram','80001','80001',[
   {role:'user',content:'我计划在周日整理文档目录。',at:'2026-01-01T10:00:00Z',id:'user-fixture',origin:'chat'},
   {role:'assistant',content:'我建议先检查目录结构。',at:'2026-01-01T10:00:01Z',id:'assistant-fixture',origin:'chat',partial:false}]);
  const graph=new MemoryStore(db,'telegram:80001');beginBootstrap(graph);
  const result={schema_version:1,decision:'STORE',labels:[{topic_id:'root-docs',score:0.9}],proposed_topics:[{client_temp_id:'root-docs',parent_id:null,name:'文档',description:'文档处理',aliases:[]}],relation_hints:[]};
  const runtime={reply:async()=>{throw Error('unexpected ordinary call');},classifyMemory:async(input:string)=>JSON.stringify(JSON.parse(input).stage==='roots'?result:{...result,proposed_topics:[],kind:'plan',importance:0.7,gist:'你计划在周日整理文档；我建议先检查结构。'})};
  const worker=new MemoryWorker(graph,runtime);await worker.tick(new Date(Date.now()+1000));await worker.stop();
  assert.equal(graph.topics().length,0);
  const resumed=new MemoryWorker(graph,runtime);await resumed.tick(new Date(Date.now()+1000));await resumed.stop();
  const ui=new ControlMemory(db,{ownerId:'80001',enabled:true},sessions);
  const topic=graph.topics()[0]!;const original=await sessions.readRange('telegram','80001',0,2);
  const row=ui.topics({parentId:topic.id}).selectedTopic!;ui.saveTopic({id:topic.id,name:'文档管理',description:'目录与索引',expectedRevision:row.revision});
  assert.throws(()=>ui.saveTopic({id:topic.id,name:'旧版本',description:'目录',expectedRevision:row.revision}),/重新读取/);
  const node=db.prepare('SELECT id,revision FROM memory_nodes WHERE kind<>\'rollup\'').get()!;
  ui.saveNode({id:node.id,expectedRevision:node.revision,gist:'你计划整理目录。',summary:'我建议先检查目录结构。'});
  assert.throws(()=>ui.saveNode({id:node.id,expectedRevision:node.revision,gist:'旧版本',summary:''}),/重新读取/);
  assert.deepEqual(await sessions.readRange('telegram','80001',0,2),original);
  const before=listMemoryPrompts(db);assert.equal(before.items.length,7);
  saveMemoryPrompt(db,{id:'digest',expectedRevision:before.revision,content:'输出带引用的 JSON 摘要。'});
  assert.equal(listMemoryPrompts(db).items.find(i=>i.id==='digest')?.customized,true);
  const model=new SiwcRuntime({} as never,join(root,'unused'),root,{} as never);
  let sent='';model.reply=async request=>{sent=request.instructions??'';return {text:'{}'};};
  try{await model.runMemoryTask('digest','{}');assert.equal(sent,'输出带引用的 JSON 摘要。');await model.classifyMemory('{}');assert.match(sent,/“我”仅指 assistant/);}finally{await model.close();}
  assert.throws(()=>saveMemoryPrompt(db!,{id:'digest',expectedRevision:before.revision,content:'过期修改'}),/重新读取/);
  saveMemoryPrompt(db,{id:'digest',expectedRevision:before.revision+1,reset:true});
  assert.equal(listMemoryPrompts(db).items.find(i=>i.id==='digest')?.content,defaultMemoryPrompt('digest'));
 }finally{db?.close();sessions?.close();await rm(base,{recursive:true,force:true});}
});
