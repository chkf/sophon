import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {prepareControlDependency} from './cloudflared-install.mjs';
import {readSources,selectSource,stateDirectory,readJson,acquireLock,prepareRelease,currentRelease,atomicJson,runCommand,releaseFromPointer} from './releases.mjs';
import {releaseRevision} from './health.mjs';
import {createUpdateJournal,statusText,saveUpdateStatus} from './update-journal.mjs';

export async function waitForUpdate(read,{id,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now,log=console.log,timeout=70*60_000}={}){
 const deadline=now()+timeout;let shown;
 while(now()<deadline){
  const status=await read();
  if(status?.id===id){
   const key=status.phase+':'+status.stage;
   if(key!==shown){log(statusText(status));shown=key;}
   if(['completed','current','failed','rolled_back','interrupted','unhealthy','prepared'].includes(status.phase))return status;
  }
  await sleep(1000);
 }
 throw Error('Update is still pending; inspect npm run update -- status.');
}

export async function runUpdateCLI(root,args=process.argv.slice(2)){
 if(args.length>1)throw Error('Usage: npm run update -- [source-name|sources|status|rollback]');
 const config=await readSources(root),dir=await stateDirectory(root),action=args[0];
 if(action==='sources'){console.log(JSON.stringify(config,null,2));return;}
 if(action==='status'){console.log(statusText(await readJson(join(dir,'status.json'),{phase:'idle'})));return;}
 const source=action==='rollback'?{name:'rollback'}:selectSource(config,action),owner=await readJson(join(dir,'host.lock','owner.json'),null);
 let running=false;if(owner?.pid)try{process.kill(owner.pid,0);running=true;}catch(error){if(error.code==='EPERM')running=true;}
 if(running&&owner.role!=='supervisor')throw Error('Another offline update is running.');
 if(running){
  const id=randomUUID();
  await writeFile(join(dir,'request.json'),JSON.stringify({id,source:source.name}),{mode:0o600,flag:'wx'});
  console.log('已提交更新，正在等待结果。Ctrl+C 只退出等待，不会取消更新。');
  const result=await waitForUpdate(async()=>{
   const completed=(await readJson(join(dir,'results.json'),[])).find(item=>item.id===id);
   return completed??readJson(join(dir,'status.json'),null);
  },{id});
  if(!['completed','current'].includes(result.phase))process.exitCode=1;
  return;
 }
 const hostUnlock=await acquireLock(root,'host',{role:'offline-update'});
 let unlock,journal,stage='lock',beforeSha;
 const id=randomUUID();
 try{
  unlock=await acquireLock(root,'update');
  const previous=await currentRelease(root);beforeSha=await releaseRevision(previous);
  journal=await createUpdateJournal(root,{id,source:source.name,beforeSha});
  const progress=async(name,details)=>{stage=name;await journal.stage(name,details);};
  const command=(cmd,args,cwd,env)=>runCommand(cmd,args,cwd,env,{onOutput:journal.output});
  const prior=action==='rollback'?await readJson(join(dir,'previous.json'),undefined):undefined;
  if(action==='rollback'&&prior===undefined)throw Error('No previous release available.');
  const candidate=action==='rollback'?{...await releaseFromPointer(root,prior),unchanged:false}:await prepareRelease(root,source,command,progress);
  await progress('components');await prepareControlDependency(root,{codeRoot:candidate.path});
  if(candidate.unchanged){
   const result={id,phase:'current',source:source.name,beforeSha,sha:beforeSha,at:new Date().toISOString()};
   await saveUpdateStatus(root,result);console.log('代码已是最新；当前没有管理进程，启动服务请使用 npm start。');return;
  }
  await progress('schema');
  await command(process.execPath,[fileURLToPath(new URL('./check-release.mjs',import.meta.url)),candidate.path],root,process.env);
  await atomicJson(join(dir,'activation.json'),{id,source:source.name,beforeSha,previous:previous.pointer,candidate:candidate.pointer,plan:candidate.plan});
  await saveUpdateStatus(root,{id,phase:'prepared',source:source.name,beforeSha,sha:candidate.pointer?.sha,plan:candidate.plan,at:new Date().toISOString()});
  console.log('版本已准备。使用 npm start 启动，健康验证通过后才确认生效。');
 }catch(error){
  const result={id,phase:'failed',source:source.name,stage,beforeSha,exitCode:error.exitCode,at:new Date().toISOString()};
  await saveUpdateStatus(root,result);console.error(statusText(result));process.exitCode=1;
 }finally{await journal?.flush();await unlock?.();await hostUnlock();}
}
