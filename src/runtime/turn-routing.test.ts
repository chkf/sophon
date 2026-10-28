import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TurnDecisionState,DECISION_TOOL_NAME} from './turn-decision.js';
import {ToolGroups,LOAD_TOOLS_NAME} from './tool-groups.js';
import {ApiRuntime} from './api.js';
import {historyFromMessages} from './history.js';
import type {RuntimeTool} from './types.js';

const base={stage_direction:'查看文档后稍作思考',reply_mode:'text',sticker:'skip',quote:'skip',image:'skip'};
const tool=(name:string):RuntimeTool=>({name,parameters:{type:'object',properties:{},additionalProperties:false}});
test('tool groups start empty, validate selection, retain loaded tools only for this message and preserve MCP flags',()=>{
 const mcp=tool('mcp_sample_'+ 'a'.repeat(24));
 const all=[tool('gateway_recent_read'),tool('gateway_file_read'),mcp];
 const groups=new ToolGroups(all);
 assert.deepEqual(groups.tools.map(t=>t.name),['gateway_recent_read',LOAD_TOOLS_NAME]);
 assert.throws(()=>groups.load(['files','files']));assert.throws(()=>groups.load(['unknown']));
 groups.load(['files','mcp_sample']);assert.equal(groups.tools.length,4);
 assert.equal(groups.tools.at(-1)?.readOnly,undefined);
 assert.equal(new ToolGroups(all).tools.some(t=>t.name===mcp.name),false);
 assert.equal(new ToolGroups([tool('gateway_recent_read')]).groups.length,0);
});

test('preparation precedes decision, recall has no score gate and output remains authorized',()=>{
 const queries:unknown[][]=[];
 const memory={search:(...args:unknown[])=>{queries.push(args);return [];}};
 const state=new TurnDecisionState({voice:false,sticker:true,quote:true,image:false},memory as any);
 state.allow('gateway_recent_read');state.allow('gateway_sticker',{action:'list'});
 assert.throws(()=>state.allow('gateway_sticker',{action:'select'}));
 assert.throws(()=>state.allow('gateway_reply_native'));
 state.search({query:'sample document'});
 assert.throws(()=>state.select({...base,reply_mode:'voice'}));
 state.select(base);state.search({query:'sample checklist'});
 assert.deepEqual(queries,[['sample document',1,8],['sample checklist',1,8]]);
 assert.throws(()=>state.search({query:'third query'}));
 assert.throws(()=>state.allow('send_voice'));assert.throws(()=>state.allow('gateway_generate_image'));
 state.allow('gateway_memory_read');state.allow('gateway_sticker',{action:'select'});state.allow('gateway_reply_native');
 assert.equal((state.tool.parameters.properties as any).memory,undefined);
 assert.equal((state.tool.parameters.properties as any).tool_groups,undefined);
 assert.throws(()=>state.select({...base,stage_direction:'Changed decision'}));
});

test('API snapshots offered tools per response, rejects early writes and preserves dynamic tools through the history wrapper',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sophon-routing-'));
 const groups=new ToolGroups([tool('gateway_file_propose')]);
 const decision=new TurnDecisionState({voice:false,sticker:false,quote:false,image:false},undefined);
 groups.tools.push(decision.tool);let writes=0;
 const sent:any[]=[];
 const call=(name:string,args:unknown,id:string)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
 const replies=[
  [call(DECISION_TOOL_NAME,base,'decision'),call('gateway_file_propose',{},'early-one')],
  [call(LOAD_TOOLS_NAME,{groups:['files']},'load'),call('gateway_file_propose',{},'early-two')],
  [call('gateway_file_propose',{},'allowed')],
  [],
 ];
 const runtime=new ApiRuntime({dataDir:root,baseUrl:'https://tools.example/v1',defaultModel:'sample-model',stream:false,
  fetch:async(_url,init)=>{sent.push(JSON.parse(String(init!.body)));const calls=replies.shift()!;
   return new Response(JSON.stringify({choices:[{finish_reason:calls.length?'tool_calls':'stop',message:{role:'assistant',content:calls.length?'':'操作已完成',...(calls.length?{tool_calls:calls}:{})}}]}),{headers:{'content-type':'application/json'}});}});
 try {
  await runtime.reply({purpose:'chat',sessionId:'sample-session',text:'Prepare a document change.',history:historyFromMessages([{role:'user',content:'Sample history'}]),
   tools:groups.tools,getTools:()=>groups.tools,requiredTool:()=>decision.current?undefined:DECISION_TOOL_NAME,
   authorizeTool:name=>{if(name!==DECISION_TOOL_NAME)decision.allow(name);},executeTool:async(name,args)=>{
    if(name===DECISION_TOOL_NAME)return decision.select(args);if(name===LOAD_TOOLS_NAME)return groups.execute(args);writes++;return {prepared:true};
   }});
  assert.equal(writes,1);assert.equal(sent.length,4);
  assert.deepEqual(sent[0].tools.map((t:any)=>t.function.name),[DECISION_TOOL_NAME]);
  assert.equal(sent[0].tool_choice,'required');
  assert.equal(sent[1].tools.some((t:any)=>t.function.name==='gateway_file_propose'),false);
  assert.equal(sent[2].tools.some((t:any)=>t.function.name==='gateway_file_propose'),true);
  assert.ok(sent[1].tools.some((t:any)=>t.function.name==='gateway_read_history'));
 }finally{await runtime.close();await rm(root,{recursive:true,force:true});}
});

test('API refuses a final answer before its required decision without executing any operation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sophon-required-'));
 const runtime=new ApiRuntime({dataDir:root,baseUrl:'https://tools.example/v1',defaultModel:'sample-model',stream:false,
  fetch:async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'Premature answer'}}]}),{headers:{'content-type':'application/json'}})});
 try{await assert.rejects(runtime.reply({purpose:'chat',sessionId:'sample',text:'Read a document',tools:[tool('sample_decision')],requiredTool:()=> 'sample_decision'}),/必需/);}
 finally{await runtime.close();await rm(root,{recursive:true,force:true});}
});
