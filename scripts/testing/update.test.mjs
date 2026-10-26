import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateSources,readSources,selectSource,buildEnvironment,prepareRelease,currentRelease,saveRelease,acquireLock,stateDirectory,switchRelease,releaseFromPointer} from '../host/releases.mjs';
import {GatewayProcess} from '../host/supervisor.mjs';
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'public-updater-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
const sources={default:'official',sources:{official:{repository:'chkf/sophon',branch:'main'},custom:{repository:'example-account/sophon',branch:'feature/updates'}}};
test('default public upstream works without local settings; configured aliases choose only listed repositories',()=>fixture(async root=>{
 assert.equal((await readSources(root)).sources.official.repository,'chkf/sophon');
 await writeFile(join(root,'update-sources.json'),JSON.stringify(sources));
 assert.deepEqual(selectSource(await readSources(root),'custom'),{name:'custom',...sources.sources.custom});
 assert.throws(()=>selectSource(sources,'https://external.example/repo'));
}));
for(const repository of ['-c','https://github.com/example/repo','account/repo;command','account/repo.git','../repo','token@github.com/repo'])test('reject unsafe repository coordinate '+repository,()=>{
 assert.throws(()=>validateSources({default:'a',sources:{a:{repository,branch:'main'}}}));
});
for(const branch of ['-main','main;command','a..b','a//b','a.lock','a$(command)'])test('reject unsafe branch '+branch,()=>{
 assert.throws(()=>validateSources({default:'a',sources:{a:{repository:'example/repo',branch}}}));
});
test('build environment drops application secrets and arbitrary Node preload options',()=>{
 const env=buildEnvironment({PATH:'/synthetic/bin',HOME:'/synthetic/home',GATEWAY_API_KEY:'synthetic-secret',NODE_OPTIONS:'--import=synthetic',TELEGRAM_BOT_TOKEN:'synthetic-token'});
 assert.equal(env.PATH,'/synthetic/bin');assert.equal(env.GATEWAY_API_KEY,undefined);assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.GIT_TERMINAL_PROMPT,'0');
});
async function fakeBuild(command,args,cwd){
 if(command==='git'&&args[0]==='clone'){
  assert.equal(args.at(-2),'https://github.com/chkf/sophon.git');
  await writeFile(join(cwd,'update-protocol.json'),JSON.stringify({version:1,stateChanges:'explicit-only'}));
 }
 if(command==='git'&&args[0]==='rev-parse')return 'a'.repeat(40);
 return '';
}
test('preparation validates in isolation and never rewrites deployment settings or active pointer',()=>fixture(async root=>{
 await writeFile(join(root,'.env'),'SYNTHETIC_SETTING=preserve');const calls=[];
 const candidate=await prepareRelease(root,selectSource(sources),async(...args)=>{calls.push(args);return fakeBuild(...args);});
 assert.equal((await currentRelease(root)).pointer,null);
 assert.equal(await readFile(join(root,'.env'),'utf8'),'SYNTHETIC_SETTING=preserve');
 assert.deepEqual(calls.filter(c=>c[0]==='npm').map(c=>c[1]),[['ci','--no-audit','--no-fund'],['run','build'],['test']]);
 assert.ok(calls.every(c=>c[2]!==root));
 await saveRelease(root,candidate.pointer);assert.equal((await currentRelease(root)).path,candidate.path);
 const same=await prepareRelease(root,selectSource(sources),fakeBuild);assert.equal(same.unchanged,true);
}));
test('failed candidate tests preserve old release and remove staging files',()=>fixture(async root=>{
 await assert.rejects(prepareRelease(root,selectSource(sources),async(command,args,cwd)=>{
  if(command==='npm'&&args[0]==='test')throw Error('Synthetic validation failure');return fakeBuild(command,args,cwd);
 }));
 assert.equal((await currentRelease(root)).pointer,null);
 assert.deepEqual(await readdir(join(await stateDirectory(root),'releases')),[]);
}));
test('unknown update protocol stops before dependency installation',()=>fixture(async root=>{
 let installed=false;await assert.rejects(prepareRelease(root,selectSource(sources),async(command,args)=>{
  if(command==='npm')installed=true;return args[0]==='rev-parse'?'b'.repeat(40):'';
 }),/protocol/);assert.equal(installed,false);
}));
test('update lock excludes parallel mutation and is reusable after release',()=>fixture(async root=>{
 const unlock=await acquireLock(root,'update');await assert.rejects(acquireLock(root,'update'),/lock exists/);await unlock();await (await acquireLock(root,'update'))();
}));
test('invalid pointer cannot escape the release directory',()=>fixture(async root=>{
 await assert.rejects(releaseFromPointer(root,{version:1,sha:'a'.repeat(40),directory:'../elsewhere'}),/pointer/);
}));
test('candidate validation happens before shutdown; successful readiness precedes pointer commit',async()=>{
 const events=[],previous={path:'previous',pointer:null},candidate={path:'candidate',pointer:{sha:'a'}};
 await switchRelease(previous,candidate,{validate:async()=>events.push('validate'),stop:async()=>events.push('stop'),start:async r=>events.push(r.path),save:async()=>events.push('save')});
 assert.deepEqual(events,['validate','stop','candidate','save']);
});
test('startup failure restarts old code, without restoring user data',async()=>{
 const events=[],previous={path:'previous',pointer:null},candidate={path:'candidate',pointer:{sha:'a'}};
 await assert.rejects(switchRelease(previous,candidate,{validate:async()=>{},stop:async()=>events.push('stop'),start:async r=>{events.push(r.path);if(r===candidate)throw Error('Synthetic failure');},save:async p=>events.push(p)}),/previous code restarted/);
 assert.deepEqual(events,['stop','candidate','stop','previous',null]);
});
test('failed shutdown never starts another writer',async()=>{
 let started=false;await assert.rejects(switchRelease({}, {},{validate:async()=>{},stop:async()=>{throw Error('Synthetic timeout');},start:async()=>{started=true;},save:async()=>{}}));assert.equal(started,false);
});
test('real managed child readiness and graceful IPC shutdown',()=>fixture(async root=>{
 await mkdir(join(root,'dist'));await writeFile(join(root,'package.json'),' {"type":"module"}');
 await writeFile(join(root,'dist/main.js'),"process.on('message',m=>{if(m.type==='sophon:shutdown')process.exit(0)});process.send({type:'sophon:ready'});");
 const gateway=new GatewayProcess(root,{startupMs:3000,stopMs:3000});
 try{await gateway.start({path:root});assert.ok(gateway.child);await assert.rejects(gateway.start({path:root}),/already/);await gateway.stop();assert.equal(gateway.child,undefined);}
 finally{await gateway.stop();}
}));
test('linked updater state directory is refused',t=>fixture(async root=>{
 const other=join(root,'other');await mkdir(other);try{await symlink(other,join(root,'.sophon-updates'),'dir');}catch(error){if(process.platform==='win32'&&error.code==='EPERM'){t.skip('Symbolic-link privilege unavailable');return;}throw error;}await assert.rejects(stateDirectory(root),/symbolic/);
}));

test('build environment preserves Windows system key casing and command extensions',()=>{
 const env=buildEnvironment({Path:'C:\\fixture\\bin',SystemRoot:'C:\\Windows',ComSpec:'C:\\Windows\\System32\\cmd.exe',PATHEXT:'.COM;.EXE;.BAT;.CMD',SystemDrive:'C:',NODE_OPTIONS:'--import=synthetic',GATEWAY_API_KEY:'synthetic-secret'});
 assert.equal(env.Path,'C:\\fixture\\bin');assert.equal(env.SystemRoot,'C:\\Windows');
 assert.equal(env.ComSpec,'C:\\Windows\\System32\\cmd.exe');assert.equal(env.PATHEXT,'.COM;.EXE;.BAT;.CMD');assert.equal(env.SystemDrive,'C:');
 assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.GATEWAY_API_KEY,undefined);
});
