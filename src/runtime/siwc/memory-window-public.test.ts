import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StatefulResponsesBridge,type StatefulResponsesSocket} from './stateful-responses.js';
import {historyFromMessages} from '../history.js';
import {LaneStore} from './lane-store.js';
class SyntheticSocket implements StatefulResponsesSocket {
 sent:Record<string,unknown>[]=[];listeners:(()=>void)[]=[];
 send(value:Record<string,unknown>){this.sent.push(value);}
 async *stream(){yield {type:'message',message:{type:'response.completed',response:{id:'synthetic-'+this.sent.length,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'合成答复'}]}]}}};}
 close(){for(const fn of this.listeners)fn();}
 onClose(fn:()=>void){this.listeners.push(fn);}
}
test('SIWC keeps unready history and atomically adopts a ready graph window',async()=>{
 const root=await mkdtemp(join(tmpdir(),'window-runtime-')),sockets:SyntheticSocket[]=[];
 const bridge=new StatefulResponsesBridge(root,()=>{const socket=new SyntheticSocket();sockets.push(socket);return socket;},300000,async()=>{},300000,()=>new Date('2026-10-26T10:00:00Z'));
 const history=historyFromMessages([{role:'user',content:'旧目录问题',at:'2026-10-20T00:00:00Z'},{role:'assistant',content:'旧目录答复',at:'2026-10-20T00:01:00Z'},{role:'user',content:'新目录问题',at:'2026-10-25T00:00:00Z'},{role:'assistant',content:'新目录答复',at:'2026-10-25T00:01:00Z'}]);
 const request={sessionId:'telegram:70001',model:'fixture-model',accessToken:'synthetic-token',messages:[{role:'user' as const,content:'继续整理'}],history,timezone:'UTC',instructions:'中性任务助手'};
 try {
  await bridge.reply({...request,memory:{ready:false,revision:1,content:'{}'}});
  assert.match(JSON.stringify(sockets[0].sent[0]),/旧目录问题/);
  assert.equal(sockets[0].sent[0].context_management,undefined);
  const store=new LaneStore(root);assert.equal((await store.read(request.sessionId))?.memoryRebase,undefined);
  await bridge.reply({...request,memory:{ready:true,revision:2,content:'{"memories":[]}'}});
  const saved=await store.read(request.sessionId);assert.equal(saved?.memoryRebase?.fromSeq,2);
  assert.doesNotMatch(JSON.stringify(sockets.at(-1)!.sent[0]),/旧目录问题/);
  assert.match(JSON.stringify(sockets.at(-1)!.sent[0]),/新目录问题/);
 }finally{await bridge.close();await rm(root,{recursive:true,force:true});}
});
