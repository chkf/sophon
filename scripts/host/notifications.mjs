import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {atomicJson,readJson,stateDirectory} from './releases.mjs';

export function updateResultText(result){
 const title={completed:result.source==='rollback'?'代码回退完成，服务已启动。':'更新成功，新版本已启动。',current:'已是所选上游的最新版本，无需更新。',interrupted:'上次更新中断，未能确认完成。请用 /update status 查看状态。',failed:'更新失败，请用 /update status 查看状态。',rolled_back:'新版本启动失败，已恢复原运行版本。'}[result.phase];
 if(!title)return null;
 const source=/^[a-z][a-z0-9_-]{0,31}$/.test(result.source??'')?'\n上游：'+result.source:'';
 const version=/^[a-f0-9]{40}$/.test(result.sha??'')?'\n版本：'+result.sha.slice(0,12):'';
 return 'Sophon 更新通知\n'+title+source+version;
}

/** The host sends independently of the Gateway child, including failed starts. */
export async function sendOwnerNotification(root,text,request=fetch){
 const {loadConfig}=await import(pathToFileURL(join(root,'dist/config/index.js')).href);
 const {telegram}=loadConfig();
 if(!telegram?.token||!telegram.ownerId)throw Error('Notification channel unavailable.');
 const response=await request('https://api.telegram.org/bot'+telegram.token+'/sendMessage',{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({chat_id:telegram.ownerId,text}),signal:AbortSignal.timeout(10_000),
 });
 if(!response.ok||!(await response.json()).ok)throw Error('Notification delivery failed.');
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
