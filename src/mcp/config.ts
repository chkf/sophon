import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
export interface McpServerConfig {
 id:string; transport:'stdio'|'http'; command?:string; args?:string[]; cwd?:string;
 url?:string; env?:Record<string,string>; headers?:Record<string,string>; tools:string[]; proactiveTools?:string[]; timeoutMs:number;
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const bad=()=>{throw Error('MCP 配置无效：请检查 docs/mcp.md；不输出配置正文。');};
/** Credentials are referenced by environment name, never embedded in examples or diagnostics. */
export function readMcpConfig(path?:string,env:NodeJS.ProcessEnv=process.env):McpServerConfig[]{
 if(!path)return [];
 try{
  if(statSync(path).size>64*1024)return bad();
  const root:unknown=JSON.parse(readFileSync(path,'utf8'));
  if(!object(root)||Object.keys(root).some(k=>k!=='servers')||!Array.isArray(root.servers)||root.servers.length>8)return bad();
  const ids=new Set<string>();
  return root.servers.map(raw=>{
   if(!object(raw)||Object.keys(raw).some(k=>!['id','transport','command','args','cwd','url','env','headers','tools','proactiveTools','timeoutMs'].includes(k)))return bad();
   const {id,transport}=raw;
   if(typeof id!=='string'||! /^[a-z][a-z0-9_]{0,19}$/.test(id)||ids.has(id))return bad();ids.add(id);
   if(transport!=='stdio'&&transport!=='http')return bad();
   if(!Array.isArray(raw.tools)||!raw.tools.length||raw.tools.length>32||raw.tools.some(t=>typeof t!=='string'||!t.trim()||t.length>128)||new Set(raw.tools).size!==raw.tools.length)return bad();
   if(raw.proactiveTools!==undefined&&(!Array.isArray(raw.proactiveTools)||raw.proactiveTools.some(t=>typeof t!=='string'||!(raw.tools as string[]).includes(t))||new Set(raw.proactiveTools).size!==raw.proactiveTools.length))return bad();
   const timeoutMs=raw.timeoutMs??30_000;
   if(!Number.isInteger(timeoutMs)||Number(timeoutMs)<1000||Number(timeoutMs)>120_000)return bad();
   const refs=(value:unknown,headers=false):Record<string,string>=>{
    if(value===undefined)return {};
    if(!object(value)||Object.keys(value).length>32)return bad();
    const entries=Object.entries(value).map(([key,name])=>{
     if(!(headers?/^[A-Za-z][A-Za-z0-9-]*$/:/^[A-Za-z_][A-Za-z0-9_]*$/).test(key)||typeof name!=='string'||! /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))return bad();
     if(headers&&['host','connection','content-length','content-type','accept','mcp-session-id','mcp-protocol-version'].includes(key.toLowerCase()))return bad();
     const value=env[name];if(!value||value.length>8192||/[\r\n\0]/.test(value))return bad();
     return [key,value];
    });return Object.fromEntries(entries);
   };
   const base={id,transport,tools:raw.tools as string[],proactiveTools:(raw.proactiveTools??[]) as string[],timeoutMs:Number(timeoutMs)};
   if(transport==='http'){
    if(typeof raw.url!=='string'||raw.command!==undefined||raw.args!==undefined||raw.cwd!==undefined||raw.env!==undefined)return bad();
    const url=new URL(raw.url);
    if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))return bad();
    return {...base,transport,url:url.href,headers:refs(raw.headers,true)};
   }
   if(typeof raw.command!=='string'||!raw.command.trim()||raw.command.length>1024||raw.url!==undefined||raw.headers!==undefined)return bad();
   if(raw.args!==undefined&&(!Array.isArray(raw.args)||raw.args.length>64||raw.args.some(a=>typeof a!=='string'||a.length>4096)))return bad();
   if(raw.cwd!==undefined&&typeof raw.cwd!=='string')return bad();
   return {...base,transport,command:raw.command,args:raw.args as string[]|undefined,cwd:resolve(dirname(path),raw.cwd as string??'.'),env:refs(raw.env)};
  });
 }catch{return bad();}
}
