import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RuntimeTool } from '../runtime/types.js';
import type { InboundMessage } from '../channels/types.js';
import type { McpServerConfig } from './config.js';

export interface ToolConnection {
 listTools(cursor?:string):Promise<{tools:{name:string;description?:string;inputSchema:Record<string,unknown>}[];nextCursor?:string}>;
 callTool(name:string,args:Record<string,unknown>):Promise<unknown>;
 close():Promise<void>;
}
export async function connectMcp(config:McpServerConfig):Promise<ToolConnection>{
 const client=new Client({name:'sophon',version:'0.1.0'},{capabilities:{}});
 const options={timeout:config.timeoutMs,maxTotalTimeout:config.timeoutMs};
 const env:Record<string,string>={};
 for(const key of ['PATH','PATHEXT','SYSTEMROOT','WINDIR','HOME','USERPROFILE','TEMP','TMP','LANG'])if(process.env[key])env[key]=process.env[key]!;
 const transport=config.transport==='stdio'
  ?new StdioClientTransport({command:config.command!,args:config.args,cwd:config.cwd,env:{...env,...config.env},stderr:'ignore',maxBufferSize:1024*1024})
  :new StreamableHTTPClientTransport(new URL(config.url!),{fetch:(url,init)=>fetch(url,{...init,redirect:'error'}),requestInit:{headers:config.headers},reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
 client.onerror=()=>{};
 try{await client.connect(transport,options);}catch{await transport.close().catch(()=>{});throw Error('MCP_CONNECT_FAILED');}
 return {
  listTools:cursor=>client.listTools(cursor?{cursor}:undefined,options),
  callTool:(name,args)=>client.callTool({name,arguments:args},undefined,options),
  close:()=>client.close(),
 };
}
export interface McpToolSource {
 tools(message:InboundMessage):Promise<RuntimeTool[]>;
 execute(name:string,args:Record<string,unknown>,message:InboundMessage):Promise<unknown>;
}
/** Only explicitly configured tools reach formal owner chat; no background task or replay opt-in. */
export class McpTools implements McpToolSource {
 private entries=new Map<string,{connection:ToolConnection;remote:string}>();
 private catalog:RuntimeTool[]=[];
 private connections:ToolConnection[]=[];
 private loading?:Promise<void>;
 private loaded=false;
 private closed=false;
 constructor(private readonly configs:McpServerConfig[],private readonly allowed:(message:InboundMessage)=>boolean,
  private readonly connect:(config:McpServerConfig)=>Promise<ToolConnection>=connectMcp){}
 private redact(text:string):string {
  for(const config of this.configs)for(const value of Object.values({...config.env,...config.headers}))if(value)text=text.split(value).join('[redacted]');
  return text;
 }
 private async load():Promise<void>{
  for(const config of this.configs){
   let connection:ToolConnection|undefined;
   try{
    connection=await this.connect(config);
    const found:RuntimeTool[]=[],routes=new Map<string,string>(),cursors=new Set<string>();let cursor:string|undefined;
    do{
     const page=await connection.listTools(cursor);
     for(const tool of page.tools){
      if(!config.tools.includes(tool.name))continue;
      const name='mcp_'+config.id+'_'+createHash('sha256').update(tool.name).digest('hex').slice(0,24);
      if(routes.has(name)||tool.inputSchema.type!=='object'||JSON.stringify(tool.inputSchema).length>16_000)throw Error('MCP_CATALOG_INVALID');
      routes.set(name,tool.name);
      found.push({name,description:this.redact(`[MCP ${config.id} / ${tool.name}] ${tool.description??''}`).slice(0,2000),parameters:JSON.parse(this.redact(JSON.stringify(tool.inputSchema))),readOnly:false,replaySafe:false});
     }
     cursor=page.nextCursor;
     if(cursor){if(cursors.has(cursor)||cursors.size>=20)throw Error('MCP_CATALOG_LIMIT');cursors.add(cursor);}
    }while(cursor);
    if(this.closed){await connection.close();return;}
    this.connections.push(connection);
    for(const [name,remote] of routes)this.entries.set(name,{connection,remote});
    this.catalog.push(...found);
   }catch{
    await connection?.close().catch(()=>{});
    console.error('[mcp] server='+config.id+' unavailable; check configuration and restart');
   }
  }
  this.loaded=true;
 }
 async tools(message:InboundMessage):Promise<RuntimeTool[]>{
  if(this.closed||!this.allowed(message))return [];
  if(!this.loaded){this.loading??=this.load();await this.loading;}
  return this.closed?[]:structuredClone(this.catalog);
 }
 async execute(name:string,args:Record<string,unknown>,message:InboundMessage):Promise<unknown>{
  if(this.closed||!this.allowed(message)||!this.entries.has(name))throw Error('MCP_TOOL_UNAVAILABLE');
  if(JSON.stringify(args).length>64_000)throw Error('MCP_ARGUMENT_LIMIT');
  const entry=this.entries.get(name)!;
  try{
   const result=await entry.connection.callTool(entry.remote,args);
   const text=this.redact(JSON.stringify(result));
   if(text.length>64_000)return {isError:true,error:'MCP_RESULT_TOO_LARGE',execution:'completed; do not repeat automatically'};
   return JSON.parse(text);
  }catch{
   // Abort timed-out streams and remove stale tools without replaying a possibly completed operation.
   await entry.connection.close().catch(()=>{});
   for(const [key,value] of this.entries)if(value.connection===entry.connection)this.entries.delete(key);
   this.catalog=this.catalog.filter(tool=>this.entries.has(tool.name));
   this.connections=this.connections.filter(connection=>connection!==entry.connection);
   return {isError:true,error:'MCP_CALL_FAILED',execution:'outcome unknown; do not repeat automatically'};
  }
 }
 async close():Promise<void>{
  this.closed=true;await this.loading;
  await Promise.allSettled(this.connections.map(c=>c.close()));this.connections=[];this.catalog=[];this.entries.clear();
 }
}
