import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StatefulResponsesBridge,type StatefulResponseOptions,type StatefulResponsesSocket} from './stateful-responses.js';
import {isUnsupportedHostedWebSearch} from './responses-codec.js';
import {ToolGroups,LOAD_TOOLS_NAME} from '../tool-groups.js';

const unsupported="hosted tool 'web_search' requires authorization and metering that are not supported by rustponsesapi";
const answer=(id:string)=>({id,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Document checked'}]}]});
const call=(id:string,name:string,args:unknown={})=>({type:'function_call',call_id:id,name,namespace:'gateway',arguments:JSON.stringify(args)});
class Socket implements StatefulResponsesSocket {
 sent:any[]=[];private current:any;private listeners:Array<()=>void>=[];
 constructor(private responses:any[]){}
 send(event:Record<string,unknown>){this.sent.push(structuredClone(event));this.current=this.responses.shift();if(!this.current)throw Error('Missing synthetic response');}
 async *stream(){if(this.current instanceof Error)yield {type:'message',message:{type:'response.failed',response:{error:{message:this.current.message}}}};
  else yield {type:'message',message:{type:'response.completed',response:this.current}};}
 close(){for(const listener of this.listeners)listener();}onClose(listener:()=>void){this.listeners.push(listener);}
}
const turn=(extra:Partial<StatefulResponseOptions>={}):StatefulResponseOptions=>({sessionId:'sample',model:'sample-model',accessToken:'synthetic-token',
 messages:[{role:'user',content:'Check the sample document'}],instructions:'Follow the configured rules.',context:{controlRevision:'rules-v1',contextRevision:'rules-v1',content:'{"recent":"sample-topic"}'},...extra});
async function fixture(work:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'sophon-search-'));try{await work(root);}finally{await rm(root,{recursive:true,force:true});}}

test('explicit hosted search rejection recovers once and caches only the affected model',()=>fixture(async root=>{
 const first=new Socket([new Error(unsupported)]),next=new Socket([answer('recovered'),answer('again'),answer('other')]);
 let count=0;const bridge=new StatefulResponsesBridge(root,()=>[first,next][count++]!);
 try{
  await bridge.reply(turn());assert.equal(first.sent[0].tools.some((t:any)=>t.type==='web_search'),true);
  assert.equal((next.sent[0].tools??[]).some((t:any)=>t.type==='web_search'),false);
  assert.equal(next.sent[0].input.filter((item:any)=>item.role==='user').length,1);
  assert.match(next.sent[0].input[0].content,/当前 Gateway 规则/);
  assert.match(next.sent[0].input[1].content,/sample-topic/);
  await bridge.reply(turn({context:{controlRevision:'rules-v1',contextRevision:'rules-v1',content:'{"recent":"new-topic"}'}}));
  assert.equal((next.sent[1].tools??[]).some((t:any)=>t.type==='web_search'),false);
  assert.doesNotMatch(JSON.stringify(next.sent[1].input),/new-topic/,'ordinary continuation does not inject Recent again');
  await bridge.reply(turn({model:'another-model'}));assert.equal(next.sent[2].tools.some((t:any)=>t.type==='web_search'),true);
 }finally{await bridge.close();}
}));

test('dynamic tools survive search recovery but writes cannot run in their loading response',()=>fixture(async root=>{
 const groups=new ToolGroups([{name:'gateway_file_propose',parameters:{type:'object'}}]);let writes=0;
 const first=new Socket([{id:'load',output:[call('load',LOAD_TOOLS_NAME,{groups:['files']}),call('early','gateway_file_propose')]},new Error(unsupported)]);
 const next=new Socket([{id:'write',output:[call('safe','gateway_file_propose')]},answer('done')]);let count=0;
 const bridge=new StatefulResponsesBridge(root,()=>[first,next][count++]!);
 try{
  await bridge.reply(turn({tools:groups.tools,getTools:()=>groups.tools,executeTool:async(name,args)=>{
   if(name===LOAD_TOOLS_NAME)return groups.execute(args);writes++;return {prepared:true};
  }}));
  assert.equal(writes,1);assert.equal(count,2);
  assert.match(JSON.stringify(next.sent[0].tools),/gateway_file_propose/);
  assert.match(JSON.stringify(next.sent[0].input),/未提供该工具/);
 }finally{await bridge.close();}
}));

test('a search rejection after a write never replays the write or starts a recovery connection',()=>fixture(async root=>{
 const socket=new Socket([{id:'write',output:[call('write','sample_write')]},new Error(unsupported)]);let sockets=0,writes=0;
 const bridge=new StatefulResponsesBridge(root,()=>{sockets++;return socket;});
 try{await assert.rejects(bridge.reply(turn({tools:[{name:'sample_write',parameters:{type:'object'}}],executeTool:async()=>{writes++;return {saved:true};}})),/rustponsesapi/);
  assert.equal(writes,1);assert.equal(sockets,1);
 }finally{await bridge.close();}
}));

test('auth, quota and unrelated tool errors never masquerade as unavailable search',()=>{
 for(const message of ['Unauthorized','insufficient_quota','web_search failed','hosted tool image requires authorization'])assert.equal(isUnsupportedHostedWebSearch(new Error(message)),false);
 assert.equal(isUnsupportedHostedWebSearch(new Error(unsupported)),true);
});
