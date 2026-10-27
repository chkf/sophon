import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ensureCloudflared,prepareControlDependency} from './cloudflared-install.mjs';
import {ControlTunnel} from './control-tunnel.mjs';
import {checkGatewayHealth,releaseRevision} from './health.mjs';
import {UpdateNotifications,sendOwnerNotification,deleteOwnerNotification} from './notifications.mjs';
import {GatewayProcess} from './supervisor.mjs';
import {createUpdateJournal,statusText,saveUpdateStatus} from './update-journal.mjs';
import {acquireLock,stateDirectory,readSources,selectSource,saveRelease,prepareRelease,runCommand,readJson,atomicJson,releaseFromPointer} from './releases.mjs';

/** Operational imports follow the release; cwd continues to own user data. */
export async function runManager({root,release,signal,verify=false,onReady=async()=>{}}){
 const dir=await stateDirectory(root);
 let busy=false,closing=false,pending,started=false,reload=false,active=release,tunnel,timer,notificationTimer;
 let finish;const finished=new Promise(resolve=>{finish=resolve;});
 const stop=()=>{closing=true;finish();};signal?.addEventListener('abort',stop,{once:true});
 const notices=new UpdateNotifications(root,text=>sendOwnerNotification(active.path,text),{remove:receipt=>deleteOwnerNotification(active.path,receipt)});
 const status=async value=>{
  const result={...value,at:new Date().toISOString()};
  await saveUpdateStatus(root,result);await notices.enqueue(result);void notices.flush();
 };
 const gateway=new GatewayProcess(root,{
  onUnexpectedExit:()=>{if(started&&!busy){process.exitCode=1;finish();}},
  onRequest:(message,child)=>{void (async()=>{
   let text;
   if(message.action==='sources'){
    const config=await readSources(root);text=Object.entries(config.sources).map(([name,s])=>(name===config.default?'* ':'')+name+' → '+s.repository+' / '+s.branch).join('\n');
   }else if(message.action==='status')text=statusText(await readJson(join(dir,'status.json'),{phase:'idle'}));
   else if(message.action==='update')text=await queue(message.source);
   else text='未知更新操作。';
   if(child.connected)child.send({type:'sophon:host-response',id:message.id,text},()=>{});
  })().catch(()=>{if(child.connected)child.send({type:'sophon:host-response',id:message.id,text:'更新请求失败，请检查本地上游配置。'},()=>{});});},
 });
 async function queue(name,id=randomUUID()){
  if(closing||busy)return '已有更新任务或正在关闭，请用 /update status 查看。';
  busy=true;
  let source;const rollback=name==='rollback';
  try{source=rollback?{name:'rollback'}:selectSource(await readSources(root),name);}catch(error){busy=false;throw error;}
  pending=(async()=>{
   let unlock,journal,stage='lock',beforeSha;
   try{
    unlock=await acquireLock(root,'update');beforeSha=await releaseRevision(active);
    journal=await createUpdateJournal(root,{id,source:source.name,beforeSha});
    const progress=async(name,details)=>{stage=name;await journal.stage(name,details);};
    const command=(cmd,args,cwd,env)=>runCommand(cmd,args,cwd,env,{onOutput:journal.output});
    const prior=rollback?await readJson(join(dir,'previous.json'),undefined):undefined;
    if(rollback&&prior===undefined)throw Error('No previous release.');
    const candidate=rollback?{...await releaseFromPointer(root,prior),unchanged:false}:await prepareRelease(root,source,command,progress);
    await progress('components');
    const component=await readJson(join(candidate.path,'update-protocol.json'),null);
    const prepare=component?.host===1?(await import(pathToFileURL(join(candidate.path,'scripts/host/cloudflared-install.mjs')).href)).prepareControlDependency:prepareControlDependency;
    await prepare(root,{codeRoot:candidate.path});
    if(closing){await status({id,phase:'interrupted',source:source.name,beforeSha});return;}
    if(candidate.unchanged){
     await progress('health');const healthy=await checkGatewayHealth(active.path,gateway.child);
     await status({id,phase:healthy?'current':'unhealthy',source:source.name,beforeSha,sha:await releaseRevision(active)});return;
    }
    await progress('schema');
    await command(process.execPath,[fileURLToPath(new URL('./check-release.mjs',import.meta.url)),candidate.path],root,process.env);
    if(closing)return;
    if(candidate.plan?.restart===false){
     await atomicJson(join(dir,'previous.json'),active.pointer);await saveRelease(root,candidate.pointer);active=candidate;
     const healthy=await checkGatewayHealth(active.path,gateway.child);
     await status({id,phase:healthy?'completed':'unhealthy',source:source.name,beforeSha,sha:await releaseRevision(active),plan:candidate.plan});return;
    }
    await status({id,phase:'switching',stage:'shutdown',source:source.name,beforeSha,sha:candidate.pointer?.sha,plan:candidate.plan});
    await atomicJson(join(dir,'activation.json'),{id,source:source.name,beforeSha,previous:active.pointer,candidate:candidate.pointer,plan:candidate.plan});
    reload=true;closing=true;finish();
   }catch(error){
    await status({id,phase:'failed',stage,source:source.name,beforeSha,sha:await releaseRevision(active),exitCode:error.exitCode,plan:journal?.value.plan,serviceRunning:Boolean(gateway.child)});
    console.error('[host] update failed; inspect .sophon-updates/update.log.');
   }finally{await journal?.flush();await unlock?.();busy=false;if(started&&!gateway.child){process.exitCode=1;finish();}}
  })().catch(()=>console.error('[host] update status could not be saved; inspect local storage.'));
  return '已开始更新：'+source.name+'。按变更验证后自动生效，成功或失败会主动通知。进度可用 /update status 查看。';
 }
 try{
  if(verify){
   try{await runCommand(process.execPath,[fileURLToPath(new URL('./check-release.mjs',import.meta.url)),active.path],root,process.env);}
   catch{throw Object.assign(Error('Candidate schema validation failed.'),{stage:'schema'});}
  }
  const {loadConfig,validateServeConfig}=await import(pathToFileURL(join(active.path,'dist/config/index.js')).href);
  const config=loadConfig();validateServeConfig(config);
  if(config.control?.tunnel==='cloudflare'){
   tunnel=new ControlTunnel({...config.server,resolveBinary:signal=>ensureCloudflared(root,{binary:process.env.GATEWAY_CLOUDFLARED_BIN?.trim()||undefined,signal}),onUrl:(url,reason)=>gateway.setControlUrl(url,reason)});
   try{await tunnel.start();}catch{await tunnel.stop();tunnel=undefined;console.error('[host] control tunnel unavailable; Gateway will continue.');}
  }
  if(closing||signal?.aborted)return;
  await gateway.start(active);
  if(verify&&!await checkGatewayHealth(active.path,gateway.child))throw Object.assign(Error('Candidate health check failed.'),{stage:'health'});
  await onReady();started=true;
  void notices.flush();notificationTimer=setInterval(()=>{void notices.flush();},30_000);
  const last=await readJson(join(dir,'status.json'),null);
  if(['preparing','switching'].includes(last?.phase))await status({id:last.id,phase:'interrupted',source:last.source});
  timer=setInterval(()=>{if(closing||busy)return;void (async()=>{
   const path=join(dir,'request.json'),request=await readJson(path,null);if(!request)return;
   if(closing||busy)return;
   try{await queue(request.source,request.id);}
   catch{await status({id:request.id,phase:'failed',stage:'protocol'});}
   await rm(path,{force:true});
  })().catch(()=>console.error('[host] local update request rejected.'));},1000);
  await finished;
  return {reload};
 }finally{
  closing=true;clearInterval(timer);clearInterval(notificationTimer);signal?.removeEventListener('abort',stop);
  try{await pending;}finally{
   let unsafe=false;
   try{await gateway.stop();}catch{unsafe=true;}
   try{await tunnel?.stop();}catch{unsafe=true;}
   await notices.chain;
   if(unsafe)throw Object.assign(Error('Service shutdown unconfirmed; no replacement started.'),{unsafeToRestart:true});
  }
 }
}
