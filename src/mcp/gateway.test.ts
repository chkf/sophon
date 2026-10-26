import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../gateway.js';
import { SessionStore } from '../sessions/store.js';
import { LocalCoreContextProvider } from '../core/context.js';
import { initializeGateway } from '../setup.js';
import { McpTools } from './client.js';

test('formal Gateway advertises and dispatches configured MCP tools through the actual runtime request',async()=>{
 const base=await mkdtemp(join(tmpdir(),'mcp-gateway-')),root=join(base,'state');await initializeGateway(root);
 const sessions=new SessionStore(root);let calls=0;
 const mcp=new McpTools([{id:'fixture',transport:'http',url:'https://mcp.example/mcp',tools:['lookup'],timeoutMs:1000}],m=>m.senderId==='70001',async()=>({
  listTools:async()=>({tools:[{name:'lookup',inputSchema:{type:'object'}}]}),
  callTool:async(name,args)=>{assert.equal(name,'lookup');assert.deepEqual(args,{query:'synthetic'});calls++;return {content:[{type:'text',text:'Synthetic record'}]};},close:async()=>{},
 }));
 const gateway=new Gateway({reply:async request=>{
  const tool=request.tools?.find(t=>t.name.startsWith('mcp_fixture_'));assert.ok(tool);
  assert.match(request.turnInstructions!,/外部数据/);
  assert.match(JSON.stringify(await request.executeTool!(tool.name,{query:'synthetic'})),/Synthetic record/);
  return {text:'Synthetic response'};
 }},sessions,new LocalCoreContextProvider(root),1,'UTC',undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,mcp);
 try{
  assert.equal((await gateway.handle({channel:'telegram',senderId:'70001',conversationId:'70001',messageId:'fixture',text:'Read the synthetic record',attachments:[]})).kind,'model_reply');
  assert.equal(calls,1);
 }finally{await mcp.close();sessions.close();await rm(base,{recursive:true,force:true});}
});
