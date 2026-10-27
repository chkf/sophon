import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {launchHost,managerModule} from '../host/launcher.mjs';
import {stateDirectory,atomicJson,readJson,currentRelease,saveRelease,runCommand,prepareRelease} from '../host/releases.mjs';
import {updatePlan,changedTreeFiles,runtimeIdentity} from '../host/update-plan.mjs';
import {createUpdateJournal,statusText,saveUpdateStatus} from '../host/update-journal.mjs';
import {waitForUpdate} from '../host/update-cli.mjs';
import {runManager} from '../host/manager.mjs';

async function fixture(work){const root=await mkdtemp(join(tmpdir(),'updater-parity-'));try{await work(root);}finally{await rm(root,{recursive:true,force:true});}}
async function release(root,letter){
 const dir=await stateDirectory(root),sha=letter.repeat(40),directory=sha+'-'+randomUUID(),path=join(dir,'releases',directory);
 await mkdir(join(path,'scripts/host'),{recursive:true});
 await writeFile(join(path,'update-protocol.json'),JSON.stringify({version:1,stateChanges:'explicit-only',host:1}));
 return {path,pointer:{version:1,sha,directory,runtime:runtimeIdentity()}};
}
test('plans distinguish docs, source, host scripts, build changes and missing dependencies',()=>{
 assert.deepEqual(updatePlan(['docs/updating.md'],{reusable:true}),{dependencies:false,build:false,tests:false,restart:false});
 assert.deepEqual(updatePlan(['scripts/host/manager.mjs'],{reusable:true}),{dependencies:false,build:false,tests:true,restart:true});
 assert.equal(updatePlan(['src/service.ts'],{reusable:true}).build,true);
 assert.equal(updatePlan(['scripts/build.mjs'],{reusable:true}).build,true);
 assert.equal(updatePlan(['package-lock.json'],{reusable:true}).dependencies,true);
 assert.equal(updatePlan(['docs/updating.md']).tests,true);
 assert.equal(updatePlan(['unknown.config'],{reusable:true}).tests,true);
 assert.deepEqual(changedTreeFiles('100644 blob aaa\tsrc/a.ts\0','100644 blob bbb\tdocs/a b.md\0'),['src/a.ts','docs/a b.md']);
});
test('launcher loads the next manager and commits only after its readiness',()=>fixture(async root=>{
 const a=await release(root,'a'),b=await release(root,'b'),dir=await stateDirectory(root),events=[];
 await saveRelease(root,a.pointer);
 await launchHost(root,{notify:async text=>events.push(text),load:async(_root,current)=>({runManager:async({onReady})=>{
  events.push(current.pointer.sha[0]);
  assert.equal((await currentRelease(root)).pointer.sha,a.pointer.sha);
  await onReady();
  if(current.pointer.sha===a.pointer.sha){
   await atomicJson(join(dir,'activation.json'),{id:'synthetic-job',source:'official',previous:a.pointer,candidate:b.pointer,beforeSha:a.pointer.sha});
   return {reload:true};
  }
  assert.equal((await currentRelease(root)).pointer.sha,b.pointer.sha);
 }})});
 assert.deepEqual(events.slice(0,2),['a','b']);assert.match(events[2],/更新成功/);
 assert.equal(await readJson(join(dir,'activation.json'),null),null);
 assert.equal((await readJson(join(dir,'previous.json'))).sha,a.pointer.sha);
 assert.equal(await readJson(join(dir,'host.lock/owner.json'),null),null);
}));
test('launcher resumes after a stopped supervisor leaves its host lock',()=>fixture(async root=>{
 const dir=await stateDirectory(root),lock=join(dir,'host.lock');
 await mkdir(lock);
 await atomicJson(join(lock,'owner.json'),{role:'supervisor',pid:2_147_483_647,startedAt:new Date(0).toISOString()});
 let started=false;
 await launchHost(root,{load:async()=>({runManager:async({onReady})=>{started=true;await onReady();}})});
 assert.equal(started,true);
 assert.equal(await readJson(join(lock,'owner.json'),null),null);
}));
test('module load failure and health failure restore the previous complete manager',()=>fixture(async root=>{
 for(const stage of ['import','health']){
  const a=await release(root,'a'),b=await release(root,'b'),dir=await stateDirectory(root),loaded=[];
  await saveRelease(root,a.pointer);
  await atomicJson(join(dir,'activation.json'),{id:'synthetic-'+stage,source:'official',previous:a.pointer,candidate:b.pointer});
  await launchHost(root,{notify:async()=>{},load:async(_root,current)=>{
   loaded.push(current.pointer.sha[0]);
   if(current.path===b.path&&stage==='import')throw Error('Synthetic import failure');
   return {runManager:async({onReady,verify})=>{
    assert.equal(verify,true);
    if(current.path===b.path)throw Object.assign(Error('Synthetic health failure'),{stage:'health'});
    await onReady();
   }};
  }});
  assert.deepEqual(loaded,['b','a']);assert.equal((await currentRelease(root)).pointer.sha,a.pointer.sha);
  const status=await readJson(join(dir,'status.json'));assert.equal(status.phase,'rolled_back');assert.equal(status.stage,stage==='import'?'startup':'health');
 }
}));
test('unconfirmed shutdown preserves ownership and never starts another manager',()=>fixture(async root=>{
 const a=await release(root,'a'),b=await release(root,'b'),dir=await stateDirectory(root);let calls=0;
 await saveRelease(root,a.pointer);await atomicJson(join(dir,'activation.json'),{id:'synthetic-stop',previous:a.pointer,candidate:b.pointer});
 await assert.rejects(launchHost(root,{notify:async()=>{},load:async()=>({runManager:async()=>{calls++;throw Object.assign(Error('Synthetic stop timeout'),{unsafeToRestart:true});}})}));
 assert.equal(calls,1);assert.ok(await readJson(join(dir,'host.lock/owner.json')));assert.equal((await currentRelease(root)).pointer.sha,a.pointer.sha);
 assert.equal((await readJson(join(dir,'status.json'))).stage,'shutdown');
}));
test('manager selection imports actual release code, with a legacy fallback',()=>fixture(async root=>{
 const candidate=await release(root,'a');
 await mkdir(join(root,'scripts/host'),{recursive:true});
 await writeFile(join(root,'scripts/host/manager.mjs'),'export const marker="installed-adapter";');
 await writeFile(join(candidate.path,'scripts/host/manager.mjs'),'export const marker="release-manager";');
 assert.equal((await managerModule(root,candidate)).marker,'release-manager');
 assert.equal((await managerModule(root,{path:root})).marker,'installed-adapter');
}));
test('command failure streams output to a local journal but status never includes raw output',()=>fixture(async root=>{
 const journal=await createUpdateJournal(root,{id:'synthetic-output',source:'official'});
 await journal.stage('tests');
 await assert.rejects(runCommand(process.execPath,['-e','process.stdout.write("synthetic failing case\\n");process.exit(7)'],root,{}, {onOutput:journal.output}),error=>error.exitCode===7&&!error.message.includes('synthetic failing case'));
 await journal.flush();
 assert.match(await readFile(join(root,'.sophon-updates/update.log'),'utf8'),/synthetic failing case/);
 assert.doesNotMatch(statusText({phase:'failed',stage:'tests',message:'synthetic private output'}),/synthetic private output/);
}));
test('CLI waits for its own job and prints changing stages then a terminal outcome',async()=>{
 const values=[{id:'other',phase:'completed'},{id:'job',phase:'preparing',stage:'fetch'},{id:'job',phase:'preparing',stage:'tests'},{id:'job',phase:'failed',stage:'tests'}],printed=[];
 const result=await waitForUpdate(async()=>values.shift(),{id:'job',sleep:async()=>{},log:text=>printed.push(text)});
 assert.equal(result.phase,'failed');assert.equal(printed.length,3);assert.match(printed[2],/失败用例/);
});
test('docs-only candidate copies isolated artifacts and skips installs, build and tests',()=>fixture(async root=>{
 const active=await release(root,'a');await saveRelease(root,active.pointer);
 await mkdir(join(active.path,'node_modules'),{recursive:true});await mkdir(join(active.path,'dist/config'),{recursive:true});
 await writeFile(join(active.path,'node_modules/.package-lock.json'),'{}');await writeFile(join(active.path,'dist/main.js'),'synthetic build');await writeFile(join(active.path,'dist/config/index.js'),'synthetic config');
 const commands=[];
 const candidate=await prepareRelease(root,{name:'official',repository:'example/project',branch:'main'},async(cmd,args,cwd)=>{
  commands.push([cmd,...args]);
  if(args[0]==='clone')await writeFile(join(cwd,'update-protocol.json'),JSON.stringify({version:1,stateChanges:'explicit-only',host:1}));
  if(args[0]==='rev-parse')return 'b'.repeat(40);
  if(args[0]==='ls-tree')return '100644 blob '+(cwd===active.path?'aaa':'bbb')+'\tdocs/guide.md\0';
  return '';
 });
 assert.equal(candidate.plan.restart,false);assert.equal(commands.some(c=>c[0]==='npm'),false);
 await writeFile(join(candidate.path,'dist/main.js'),'replacement');
 assert.equal(await readFile(join(active.path,'dist/main.js'),'utf8'),'synthetic build');
}));

test('completed receipts remain available after another job changes live status',()=>fixture(async root=>{
 await saveUpdateStatus(root,{id:'first',phase:'completed'});
 await saveUpdateStatus(root,{id:'second',phase:'preparing',stage:'fetch'});
 const dir=await stateDirectory(root);
 assert.equal((await readJson(join(dir,'status.json'))).id,'second');
 assert.equal((await readJson(join(dir,'results.json')))[0].id,'first');
}));
test('local update logs redact synthetic secrets split across output chunks',()=>fixture(async root=>{
 const key='SYNTHETIC_TEST_API_KEY',previous=process.env[key];process.env[key]='synthetic-split-secret';
 try{
  const journal=await createUpdateJournal(root,{id:'synthetic-redaction'});
  journal.output('value=synthetic-spl');journal.output('it-secret\n');await journal.flush();
  const log=await readFile(join(root,'.sophon-updates/update.log'),'utf8');
  assert.match(log,/\[redacted\]/);assert.doesNotMatch(log,/synthetic-split-secret/);
 }finally{if(previous===undefined)delete process.env[key];else process.env[key]=previous;}
}));
test('real manager starts and drains a synthetic IPC child under the launcher lock',()=>fixture(async root=>{
 await mkdir(join(root,'dist/config'),{recursive:true});
 await writeFile(join(root,'package.json'),'{"type":"module"}');
 await writeFile(join(root,'dist/config/index.js'),'export const loadConfig=()=>({server:{host:"127.0.0.1",port:8790}});export const validateServeConfig=()=>{};');
 await writeFile(join(root,'dist/main.js'),'import {writeFileSync} from "node:fs";writeFileSync("child.pid",String(process.pid));process.on("message",m=>{if(m.type==="sophon:shutdown")process.exit(0)});process.send({type:"sophon:ready"});');
 const controller=new AbortController();
 await launchHost(root,{signal:controller.signal,load:async()=>({runManager:options=>runManager({...options,onReady:async()=>{await options.onReady();controller.abort();}})})});
 const pid=Number(await readFile(join(root,'child.pid'),'utf8'));
 assert.throws(()=>process.kill(pid,0));
 assert.equal(await readJson(join(root,'.sophon-updates/host.lock/owner.json'),null),null);
}));
