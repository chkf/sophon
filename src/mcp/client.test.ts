import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readMcpConfig } from './config.js';
import { McpTools,connectMcp,type ToolConnection } from './client.js';
import type { McpServerConfig } from './config.js';
import type { InboundMessage } from '../channels/types.js';
const message:InboundMessage={channel:'telegram',senderId:'70001',conversationId:'70001',messageId:'test',text:'List synthetic records',attachments:[]};
const config:McpServerConfig={id:'sample',transport:'http',url:'https://mcp.example/mcp',tools:['lookup'],headers:{Authorization:'synthetic-secret'},timeoutMs:1000};
const tool={name:'lookup',description:'Synthetic lookup',inputSchema:{type:'object',properties:{query:{type:'string'}}}};
async function directory(run:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'sophon-mcp-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}

test('configuration is opt-in and credentials resolve only from named environment values',()=>directory(async root=>{
 assert.deepEqual(readMcpConfig(),[]);
 const path=join(root,'mcp.json');
 await writeFile(path,JSON.stringify({servers:[{id:'example',transport:'http',url:'https://mcp.example/mcp',headers:{Authorization:'MCP_AUTH'},tools:['lookup']}]}));
 const loaded=readMcpConfig(path,{MCP_AUTH:'Bearer synthetic-secret'});
 assert.equal(loaded[0]!.headers!.Authorization,'Bearer synthetic-secret');
 assert.throws(()=>readMcpConfig(path,{}),error=>error instanceof Error&&!error.message.includes('synthetic-secret'));
 for(const url of ['http://mcp.example/mcp','https://user:synthetic-secret@mcp.example/mcp','https://mcp.example/mcp?token=synthetic-secret']){
  await writeFile(path,JSON.stringify({servers:[{id:'example',transport:'http',url,tools:['lookup']}]}));assert.throws(()=>readMcpConfig(path));
 }
 await writeFile(path,JSON.stringify({servers:[{id:'example',transport:'stdio',command:'node',args:['server.mjs'],env:{SERVICE_TOKEN:'MCP_AUTH'},tools:['lookup']}]}));
 assert.equal(readMcpConfig(path,{MCP_AUTH:'synthetic-secret'})[0]!.cwd,root);
}));

test('owner-only tool discovery applies allowlist, pagination, namespacing and credential redaction',async()=>{
 let connects=0,closes=0,calls=0;
 const connection:ToolConnection={listTools:async cursor=>cursor?{tools:[{...tool,description:'synthetic-secret'}]}:{tools:[{...tool,name:'not_allowed'}],nextCursor:'page2'},callTool:async(name,args)=>{calls++;assert.equal(name,'lookup');assert.deepEqual(args,{query:'index'});return {content:[{type:'text',text:'synthetic-secret result'}]};},close:async()=>{closes++;}};
 const source=new McpTools([config],m=>m.senderId==='70001',async()=>{connects++;return connection;});
 assert.deepEqual(await source.tools({...message,senderId:'70002'}),[]);assert.equal(connects,0);
 const [tools,again]=await Promise.all([source.tools(message),source.tools(message)]);
 assert.equal(connects,1);assert.equal(tools.length,1);assert.deepEqual(tools,again);assert.match(tools[0]!.name,/^mcp_sample_/);
 assert.equal(tools[0]!.replaySafe,false);assert.doesNotMatch(tools[0]!.description!,/synthetic-secret/);
 assert.doesNotMatch(JSON.stringify(await source.execute(tools[0]!.name,{query:'index'},message)),/synthetic-secret/);assert.equal(calls,1);
 await assert.rejects(source.execute(tools[0]!.name,{}, {...message,senderId:'70002'}));
 await source.close();assert.equal(closes,1);assert.deepEqual(await source.tools(message),[]);
});

test('failed and oversized calls do not replay or reveal raw errors',async()=>{
 let calls=0;
 const source=new McpTools([config],()=>true,async()=>({listTools:async()=>({tools:[tool]}),callTool:async()=>{calls++;if(calls===2)throw Error('synthetic-secret');return {content:[{type:'text',text:'x'.repeat(65_000)}]};},close:async()=>{}}));
 const name=(await source.tools(message))[0]!.name;
 assert.match(JSON.stringify(await source.execute(name,{},message)),/TOO_LARGE/);assert.equal(calls,1);
 const failed=await source.execute(name,{},message);assert.match(JSON.stringify(failed),/outcome unknown/);assert.doesNotMatch(JSON.stringify(failed),/synthetic-secret/);assert.equal(calls,2);
 assert.deepEqual(await source.tools(message),[]);await assert.rejects(source.execute(name,{},message));assert.equal(calls,2);await source.close();
});

test('stdio protocol initializes, discovers, calls and closes a synthetic process',()=>directory(async root=>{
 const file=join(root,'server.mjs');
 await writeFile(file,`import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;
let result;
if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}};
if(r.method==='tools/list')result={tools:[{name:'lookup',inputSchema:{type:'object'}}]};
if(r.method==='tools/call')result={content:[{type:'text',text:'synthetic result'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`);
 const connection=await connectMcp({id:'local',transport:'stdio',command:process.execPath,args:[file],tools:['lookup'],timeoutMs:2000});
 try{assert.equal((await connection.listTools()).tools[0]!.name,'lookup');assert.match(JSON.stringify(await connection.callTool('lookup',{})),/synthetic result/);}finally{await connection.close();}
}));

test('HTTP protocol passes configured authentication and never follows redirects',async()=>{
 let auth='',calls=0;
 const server=createServer(async(req,res)=>{
  if(req.url==='/redirect'){res.writeHead(307,{location:'/mcp'}).end();return;}
  if(req.method!=='POST'){res.writeHead(405).end();return;}
  auth=String(req.headers.authorization??'');let raw='';for await(const chunk of req)raw+=chunk;
  const r=JSON.parse(raw);if(r.id===undefined){res.writeHead(202).end();return;}
  let result;
  if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}};
  if(r.method==='tools/list')result={tools:[tool]};
  if(r.method==='tools/call'){calls++;result={content:[{type:'text',text:'synthetic HTTP result'}]};}
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  const client=await connectMcp({...config,url:url+'/mcp'});
  try{assert.equal((await client.listTools()).tools[0]!.name,'lookup');await client.callTool('lookup',{});assert.equal(calls,1);assert.equal(auth,'synthetic-secret');}finally{await client.close();}
  await assert.rejects(connectMcp({...config,url:url+'/redirect'}),/MCP_CONNECT_FAILED/);assert.equal(calls,1);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('background allowlist is opt-in, validated, and cannot grant tools outside chat scope',()=>directory(async root=>{
 const path=join(root,'mcp.json');
 for(const proactiveTools of [['missing'],['lookup','lookup'],'lookup']){
  await writeFile(path,JSON.stringify({servers:[{id:'sample',transport:'http',url:'https://mcp.example/mcp',tools:['lookup'],proactiveTools}]}));
  assert.throws(()=>readMcpConfig(path));
 }
 await writeFile(path,JSON.stringify({servers:[{id:'sample',transport:'http',url:'https://mcp.example/mcp',tools:['lookup'],proactiveTools:['lookup']}]}));
 assert.deepEqual(readMcpConfig(path)[0]!.proactiveTools,['lookup']);
}));

test('background discovery skips unapproved services and shares connections without granting chat-only tools',async()=>{
 let connects=0,calls=0;
 const source=new McpTools([{...config,id:'chat_only'},{...config,id:'background',tools:['lookup','write'],proactiveTools:['lookup']}],()=>true,async()=>{
  connects++;return {listTools:async()=>({tools:[tool,{...tool,name:'write'}]}),callTool:async()=>{calls++;throw Error('synthetic failure');},close:async()=>{}};
 });
 const background=await source.proactiveTools();assert.equal(connects,1);assert.equal(background.length,1);
 const chat=await source.tools(message);assert.equal(connects,2);assert.equal(chat.length,3);
 const forbidden=chat.filter(t=>t.name!==background[0]!.name);
 for(const t of forbidden)await assert.rejects(source.executeProactive(t.name,{}));
 assert.equal(calls,0);
 assert.match(JSON.stringify(await source.executeProactive(background[0]!.name,{})),/outcome unknown/);
 await assert.rejects(source.executeProactive(background[0]!.name,{}));assert.equal(calls,1);
 assert.deepEqual(await source.proactiveTools(),[]);assert.equal(connects,2);await source.close();
});
