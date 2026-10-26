import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {checkGatewayHealth,releaseRevision} from './health.mjs';
import {UpdateNotifications} from './notifications.mjs';
import {GatewayProcess} from './supervisor.mjs';
import {acquireLock,stateDirectory,readSources,selectSource,currentRelease,saveRelease,prepareRelease,runCommand,readJson,atomicJson,switchRelease,releaseFromPointer} from './releases.mjs';

const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const dir=await stateDirectory(root);
let busy=false,closing=false,pending,active,started=false;
const unlock=await acquireLock(root,'host',{role:'supervisor'});
let finish;const finished=new Promise(resolve=>{finish=resolve;});
const validate=release=>runCommand(process.execPath,[fileURLToPath(new URL('./check-release.mjs',import.meta.url)),release.path],root,process.env);
const notifications=new UpdateNotifications(root);
const status=async(value)=>{
 const result={...value,at:new Date().toISOString()};
 await atomicJson(join(dir,'status.json'),result);
 await notifications.enqueue(result);
 void notifications.flush();
};
const gateway=new GatewayProcess(root,{
 onUnexpectedExit:code=>{if(started&&!busy){console.error('[host] Gateway exited; host is stopping.');process.exitCode=code||1;finish();}},
 onRequest:(message,child)=>{void (async()=>{
  let text;
  if(message.action==='sources'){
   const config=await readSources(root);text=Object.entries(config.sources).map(([name,s])=>(name===config.default?'* ':'')+name+' → '+s.repository+' / '+s.branch).join('\n');
  }else if(message.action==='status'){
   const value=await readJson(join(dir,'status.json'),{phase:'idle'});text=JSON.stringify(value);
  }else if(message.action==='update')text=await queue(message.source);
  else text='未知更新操作。';
  if(child.connected)child.send({type:'sophon:host-response',id:message.id,text},()=>{});
 })().catch(()=>{if(child.connected)child.send({type:'sophon:host-response',id:message.id,text:'更新请求失败，请检查本地上游配置。'},()=>{});});},
});
async function queue(name,id=randomUUID()){
 if(closing||busy)return '已有更新任务或正在关闭，请用 /update status 查看。';
 const rollback=name==='rollback';
 const source=rollback?{name:'rollback'}:selectSource(await readSources(root),name);busy=true;
 pending=(async()=>{
  let releaseLock,stage='lock',failureStage;
  const step=async(name,work)=>{stage=name;try{return await work();}catch(error){failureStage??=name;throw error;}};
  const beforeSha=await releaseRevision(active);
  const progress=async value=>{stage=value;await status({id,phase:'preparing',stage,source:source.name,beforeSha});};
  try{
   releaseLock=await acquireLock(root,'update');await status({id,phase:'preparing',source:source.name});
   const prior=rollback?await readJson(join(dir,'previous.json'),undefined):undefined;
   if(rollback&&prior===undefined)throw Error('No previous release.');
   const candidate=rollback?{...await releaseFromPointer(root,prior),unchanged:false}:await prepareRelease(root,source,runCommand,progress);
   if(closing){await status({id,phase:'interrupted',source:source.name});return;}
   if(candidate.unchanged){
    const healthy=await checkGatewayHealth(root,gateway.child);
    await status({id,phase:healthy?'current':'unhealthy',source:source.name,beforeSha,sha:await releaseRevision(active)});return;
   }
   await status({id,phase:'switching',source:source.name,sha:candidate.pointer?.sha??"initial"});
   await switchRelease(active,candidate,{validate:r=>step('schema',()=>validate(r)),stop:()=>step('shutdown',()=>gateway.stop()),start:r=>step('startup',()=>gateway.start(r)),save:pointer=>step('activation',async()=>{
    if(pointer===candidate.pointer)await atomicJson(join(dir,'previous.json'),active.pointer);
    await saveRelease(root,pointer);
   })});
   active=candidate;stage='health';
   const healthy=await checkGatewayHealth(root,gateway.child);
   await status({id,phase:healthy?'completed':'unhealthy',source:source.name,beforeSha,sha:await releaseRevision(active)});
  }catch(error){
   // Command output and configuration values never enter status or channel replies.
   await status({id,phase:error.rolledBack?'rolled_back':'failed',stage:failureStage??stage,source:source.name,beforeSha,sha:await releaseRevision(active),serviceRunning:Boolean(gateway.child),message:'更新未完成，请检查所示阶段；原始命令输出不回传聊天。'});
   console.error('[host] update failed; inspect npm run update -- status.');
   if(!gateway.child){process.exitCode=1;finish();}
  }finally{await releaseLock?.();busy=false;if(started&&!gateway.child){process.exitCode=1;finish();}}
 })();
 return '已开始更新：'+source.name+'。验证通过后自动重启，成功或失败会主动通知。也可使用 /update status 查看进度。';
}
let timer,notificationTimer;
const shutdown=()=>{closing=true;finish();};process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
try{
 void notifications.flush();
 notificationTimer=setInterval(()=>{void notifications.flush();},30_000);
 active=await currentRelease(root);
 try {await gateway.start(active);} catch {
  await gateway.stop();
  const previous=await readJson(join(dir,'previous.json'),undefined);
  if(previous===undefined)throw Error('Gateway could not start; no previous release available.');
  const fallback=await releaseFromPointer(root,previous);await validate(fallback);await gateway.start(fallback);
  await saveRelease(root,fallback.pointer);active=fallback;
  await status({phase:'rolled_back',message:'新版本启动失败，已恢复原运行版本。'});
 }
 started=true;
 const lastStatus=await readJson(join(dir,'status.json'),null);
 if(['preparing','switching'].includes(lastStatus?.phase))await status({id:lastStatus.id,phase:'interrupted',source:lastStatus.source});
 timer=setInterval(()=>{if(closing)return;void (async()=>{
  const path=join(dir,'request.json'),request=await readJson(path,null);if(!request)return;
  await rm(path,{force:true});await queue(request.source,request.id);
 })().catch(()=>console.error('[host] local update request rejected.'));},1000);
 await finished;
}finally{
 closing=true;clearInterval(timer);clearInterval(notificationTimer);
 // Candidate validation may still be running; it must not publish after shutdown.
 try{await pending;}finally{await gateway.stop();await notifications.chain;await unlock();}
}
