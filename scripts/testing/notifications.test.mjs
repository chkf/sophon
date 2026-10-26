import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {UpdateNotifications,updateResultText,sendOwnerNotification} from '../host/notifications.mjs';
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'update-notice-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
test('terminal update results have neutral messages and omit raw error output',()=>{
 for(const phase of ['completed','current','failed','rolled_back','interrupted','unhealthy','prepared']){
  const text=updateResultText({phase,source:'official',sha:'a'.repeat(40),message:'synthetic-internal-detail'});
  assert.match(text,/Sophon 更新通知/);assert.match(text,/official/);assert.doesNotMatch(text,/synthetic-internal-detail/);
 }
 assert.equal(updateResultText({phase:'preparing'}),null);
 assert.equal(updateResultText({phase:'switching'}),null);
});
test('failed send remains queued and a restarted notifier delivers without a Gateway child',()=>fixture(async root=>{
 const first=new UpdateNotifications(root,async()=>{throw Error('synthetic network error');});
 await first.enqueue({id:'task-a',phase:'failed'});await first.flush();
 assert.equal(JSON.parse(await readFile(join(root,'.sophon-updates/notifications.json'),'utf8')).length,1);
 const received=[],second=new UpdateNotifications(root,async text=>{received.push(text);});
 await second.flush();await second.flush();assert.equal(received.length,1);assert.match(received[0],/更新失败/);
 assert.deepEqual(JSON.parse(await readFile(join(root,'.sophon-updates/notifications.json'),'utf8')),[]);
}));
test('concurrent enqueue and flush preserve distinct results without duplicate pending IDs',()=>fixture(async root=>{
 const received=[],notifier=new UpdateNotifications(root,async text=>{received.push(text);});
 await Promise.all([notifier.enqueue({id:'a',phase:'completed'}),notifier.enqueue({id:'a',phase:'completed'}),notifier.enqueue({id:'b',phase:'current'})]);
 await Promise.all([notifier.flush(),notifier.flush()]);assert.equal(received.length,2);
 assert.match(received[0],/更新成功/);assert.match(received[1],/无需更新/);
}));

test('host delivery addresses only the configured owner and requires Telegram acknowledgement',()=>fixture(async root=>{
 await mkdir(join(root,'dist/config'),{recursive:true});
 await writeFile(join(root,'package.json'),'{"type":"module"}');
 await writeFile(join(root,'dist/config/index.js'),"export const loadConfig=()=>({telegram:{token:'synthetic-token',ownerId:'70001'}});");
 const requests=[];
 await sendOwnerNotification(root,'更新结果',async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({ok:true,result:{message_id:42}})};});
 assert.equal(requests[0].url,'https://api.telegram.org/botsynthetic-token/sendMessage');
 assert.deepEqual(JSON.parse(requests[0].options.body),{chat_id:'70001',text:'更新结果'});
 assert.ok(requests[0].options.signal);
 await assert.rejects(sendOwnerNotification(root,'更新结果',async()=>({ok:true,json:async()=>({ok:false})})),/delivery failed/);
}));
