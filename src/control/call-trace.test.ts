import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeGateway} from '../setup.js';
import {TaskTraceStore} from '../observability/store.js';
import {beginCallTrace,recordContextSources} from './call-trace.js';
import {siwcContextAttribution} from '../observability/context-injection.js';

test('call scopes redact content and remain isolated from today-only tasks',async()=>{
 const base=await mkdtemp(join(tmpdir(),'sophon-trace-fixture-')),root=join(base,'data');let calls:TaskTraceStore|undefined,tasks:TaskTraceStore|undefined;
 try{
  await initializeGateway(root);calls=new TaskTraceStore(root,{scope:'calls',secrets:['synthetic-credential']});tasks=new TaskTraceStore(root,{todayOnly:true,timezone:'UTC'});
  tasks.begin({kind:'heartbeat_check',trigger:'fixture',at:new Date(Date.now()-86400000*2)});
  assert.equal(tasks.list().runs.length,0);
  const call=beginCallTrace(()=>calls,'telegram')!;
  recordContextSources(call.observer,[{id:'core',label:'Core',placement:'policy',content:'synthetic-credential '+ 'a'.repeat(4000)}]);
  call.finish();assert.equal(tasks.list().runs.length,0);
  assert.equal(calls.list().runs.length,1);assert.doesNotMatch(JSON.stringify(calls.get(call.id)),/synthetic-credential/);
  assert.match(JSON.stringify(calls.get(call.id)),/contentTruncated/);
  assert.equal(beginCallTrace(()=>{throw Error('storage unavailable');},'telegram'),undefined);
  const sources=siwcContextAttribution({sources:[{id:'core',label:'Core',placement:'policy'}],policySent:false,continues:true,replay:false,historyItems:0,historyTruncated:false,currentUserSent:true,toolResults:1,tools:2,liveContextSent:false});
  assert.equal(sources.find(s=>s.source==='core')?.delivery,'inherited');assert.equal(sources.find(s=>s.source==='tool_results')?.delivery,'sent');
 }finally{calls?.close();tasks?.close();await rm(base,{recursive:true,force:true});}
});
