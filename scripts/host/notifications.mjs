import {failureHint} from './update-journal.mjs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {atomicJson,readJson,stateDirectory} from './releases.mjs';

export function updateResultText(result){
 const title={prepared:'版本已准备，本次未重启；下次启动时验证生效。',unhealthy:'版本检查或切换已完成，但当前服务健康检查未通过。请检查 /logs。',completed:result.source==='rollback'?'代码回退完成，服务已启动。':result.plan?.restart===false?'更新成功，仅文档变化，服务无需重启。':'更新成功，新版本已启动并通过健康检查。',current:'已是所选上游的最新版本，无需更新。',interrupted:'上次更新中断，未能确认完成。请用 /update status 查看状态。',failed:'更新失败，请用 /update status 查看状态。',rolled_back:'新版本启动失败，已恢复原运行版本。'}[result.phase];
 if(!title)return null;
 const source=/^[a-z][a-z0-9_-]{0,31}$/.test(result.source??'')?'\n上游：'+result.source:'';
 const valid=value=>/^[a-f0-9]{40}$/.test(value??'');
 const version=!valid(result.sha)?'\n版本：未能核验':!valid(result.beforeSha)?'\n版本：'+result.sha.slice(0,12):result.beforeSha===result.sha?'\n版本：'+result.sha.slice(0,12)+'（未变化）':'\n版本：'+result.beforeSha.slice(0,12)+' → '+result.sha.slice(0,12);
 const stages={lock:'更新锁检查',fetch:'下载上游',protocol:'更新协议检查',dependencies:'依赖安装',build:'构建',tests:'测试',schema:'数据库兼容性检查',shutdown:'停止原进程',startup:'启动服务',activation:'保存版本指针',health:'健康检查'};
 const detail=['failed','rolled_back'].includes(result.phase)?'\n失败阶段：'+(stages[result.stage]??'准备更新')+'\n'+failureHint(result.stage)+'\n本机日志：.sophon-updates/update.log':'';
 return 'Sophon 更新通知\n'+title+source+version+detail;
}

/** The host sends independently of the Gateway child, including failed starts. */
export async function sendOwnerNotification(root,text,request=fetch){
 const {loadConfig}=await import(pathToFileURL(join(root,'dist/config/index.js')).href);
 const {telegram}=loadConfig();
 if(!telegram?.token||!/^\d+$/.test(String(telegram.ownerId??'')))throw Error('Notification channel unavailable.');
 const response=await request('https://api.telegram.org/bot'+telegram.token+'/sendMessage',{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({chat_id:telegram.ownerId,text}),signal:AbortSignal.timeout(10_000),
 });
 if(!response.ok)throw Error('Notification delivery failed.');
 const payload=await response.json();
 if(!payload.ok||!Number.isSafeInteger(payload.result?.message_id)||payload.result.message_id<=0)throw Error('Notification delivery failed.');
}

/** Durable outbox. Only a confirmed send removes an item; ambiguous failures may repeat. */
export class UpdateNotifications {
 constructor(root,send=text=>sendOwnerNotification(root,text)){
  this.root=root;this.send=send;this.chain=Promise.resolve();
 }
 serial(work){
  const next=this.chain.then(work);
  this.chain=next.catch(()=>{console.error('[host] update notification pending; delivery will retry.');});
  return this.chain;
 }
 async path(){return join(await stateDirectory(this.root),'notifications.json');}
 enqueue(result){return this.serial(async()=>{
  const text=updateResultText(result);if(!text)return;
  const path=await this.path(),items=await readJson(path,[]);
  const id=result.id??result.at;
  if(!items.some(item=>item.id===id))await atomicJson(path,[...items,{id,text}]);
 });}
 flush(){return this.serial(async()=>{
  const path=await this.path(),items=await readJson(path,[]);
  for(let count=0;items.length&&count<10;count++){
   await this.send(items[0].text);items.shift();await atomicJson(path,items);
  }
 });}
}
