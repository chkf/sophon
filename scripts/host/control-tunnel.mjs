import {createServer,request} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildEnvironment} from './releases.mjs';

export function tunnelUrl(value){
 try{const url=new URL(value);
  if(url.protocol==='https:'&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com$/.test(url.hostname)&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/')return url.origin+'/control/';
 }catch{}
 return null;
}
export function urlFromLine(line){
 for(const match of line.matchAll(/https:\/\/[^\s"'<>|]+/g)){const url=tunnelUrl(match[0]);if(url)return url;}
 return null;
}
export function controlPath(raw){
 if(!raw?.startsWith('/')||raw.startsWith('//')||/[\\%\x00-\x20]/.test(raw))return false;
 const path=raw.split('?')[0],normalized=new URL(raw,'http://localhost').pathname;
 return path===normalized&&(path==='/control'||path.startsWith('/control/'));
}

/** Exposes only control routes; never forward the operational HTTP listener wholesale. */
export async function controlProxy({host,port,getUrl}){
 if(!['127.0.0.1','::1','localhost'].includes(host)||!Number.isInteger(port)||port<1||port>65535)throw Error('Control tunnel requires a loopback Gateway.');
 const server=createServer((req,res)=>{
  const current=getUrl();
  if(!current){res.writeHead(503);res.end('Control tunnel unavailable.');return;}
  if(!controlPath(req.url)||!['GET','POST'].includes(req.method)){res.writeHead(404);res.end();return;}
  if(req.headers.host!==new URL(current).host){res.writeHead(403);res.end();return;}
  const headers={};
  for(const key of ['host','origin','cookie','content-type','content-length','x-control-csrf','sec-fetch-site','accept','user-agent'])if(req.headers[key]!==undefined)headers[key]=req.headers[key];
  const upstream=request({host,port,method:req.method,path:req.url,headers},incoming=>{
   res.writeHead(incoming.statusCode??502,incoming.headers);incoming.pipe(res);
  });
  upstream.on('error',()=>{if(!res.headersSent){res.writeHead(502);res.end('Control service unavailable.');}else res.destroy();});
  upstream.setTimeout(30_000,()=>upstream.destroy());
  req.setTimeout(30_000,()=>req.destroy());
  req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
 });
 server.on('upgrade',(_req,socket)=>socket.destroy());
 server.headersTimeout=10_000;server.requestTimeout=30_000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}

/** Stable across Gateway restarts. A new tunnel invalidates the old browser session. */
export class ControlTunnel {
 constructor({host,port,binary='cloudflared',onUrl=()=>{},spawnImpl=spawn,retryMs=30_000,startupMs=45_000}){
  Object.assign(this,{host,port,binary,onUrl,spawnImpl,retryMs,startupMs});this.url=null;this.stopped=false;
 }
 publish(url){this.url=url;this.onUrl(url);}
 async start(){
  this.directory=await mkdtemp(join(tmpdir(),'sophon-tunnel-'));
  this.config=join(this.directory,'config.yml');await writeFile(this.config,'{}\n',{mode:0o600});
  this.proxy=await controlProxy({host:this.host,port:this.port,getUrl:()=>this.url});
  this.launch();
 }
 launch(){
  if(this.stopped)return;
  // Never inherit tunnel tokens or application secrets. Use an isolated empty config.
  let child;
  try{child=this.spawnImpl(this.binary,['tunnel','--config',this.config,'--no-autoupdate','--url',this.proxy.url],{env:buildEnvironment(),stdio:['ignore','pipe','pipe'],windowsHide:true});}
  catch{this.retry();return;}
  this.child=child;let finished=false;
  const finish=()=>{
   if(finished)return;finished=true;clearTimeout(this.deadline);
   if(this.child===child)this.child=undefined;
   this.publish(null);if(!this.stopped)this.retry();
  };
  child.once('error',()=>{if(!child.pid)finish();else child.kill();});child.once('close',finish);
  for(const stream of [child.stdout,child.stderr]){
   let buffer='';stream?.setEncoding('utf8');stream?.on('data',chunk=>{
    buffer=(buffer+chunk).slice(-16384);let end;
    while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
     const url=urlFromLine(line);if(url&&!this.stopped&&!finished){clearTimeout(this.deadline);this.publish(url);}
    }
   });
  }
  this.deadline=setTimeout(()=>{if(this.child===child){this.publish(null);child.kill();}},this.startupMs);
 }
 retry(){
  this.publish(null);console.error('[host] control tunnel unavailable; install/check cloudflared and network. Retrying.');
  this.retryTimer=setTimeout(()=>this.launch(),this.retryMs);
 }
 async stop(){
  this.stopped=true;clearTimeout(this.retryTimer);clearTimeout(this.deadline);this.publish(null);
  const child=this.child;
  if(child)await new Promise(resolve=>{
   const force=setTimeout(()=>child.kill('SIGKILL'),3000);
   child.once('close',()=>{clearTimeout(force);resolve();});child.kill();
  });
  await this.proxy?.close();if(this.directory)await rm(this.directory,{recursive:true,force:true});
 }
}
