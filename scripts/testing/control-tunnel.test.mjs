import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {ControlTunnel,controlProxy,controlPath,tunnelUrl,urlFromLine} from '../host/control-tunnel.mjs';
const publicUrl='https://neutral-example.trycloudflare.com/control/';
test('temporary host extraction rejects lookalikes and unsafe URLs',()=>{
 assert.equal(tunnelUrl('https://neutral-example.trycloudflare.com'),publicUrl);
 assert.equal(urlFromLine('| https://neutral-example.trycloudflare.com |'),publicUrl);
 for(const url of ['http://neutral-example.trycloudflare.com','https://neutral-example.trycloudflare.com.external.example','https://user@neutral-example.trycloudflare.com','https://neutral-example.trycloudflare.com:8443','https://neutral-example.trycloudflare.com/path'])assert.equal(tunnelUrl(url),null);
 assert.equal(urlFromLine('https://neutral-example.trycloudflare.com.external.example'),null);
 for(const path of ['/healthz','/__gateway/takeover','/control/../healthz','/control/%2e%2e/healthz','//external.example/control/','/controller/','/control/..\\healthz'])assert.equal(controlPath(path),false);
 assert.equal(controlPath('/control/app.js'),true);
});
function http(url,options={}){return new Promise((resolve,reject)=>{
 const req=request(url,options,res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>{body+=chunk;});res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));});
 req.on('error',reject);req.end(options.body);
});}
test('control proxy forwards only the allowed path and exact public Host, retaining Origin and cookies',async()=>{
 let current=publicUrl;const received=[];
 const backend=createServer((req,res)=>{received.push({url:req.url,headers:req.headers});res.setHeader('set-cookie','synthetic=value; Secure; HttpOnly');res.end('control response');});
 await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
 const proxy=await controlProxy({host:'127.0.0.1',port:backend.address().port,getUrl:()=>current});
 const host=new URL(publicUrl).host,origin=new URL(publicUrl).origin;
 try{
  for(const path of ['/healthz','/__gateway/takeover','/controller/'])assert.equal((await http(proxy.url+path,{headers:{host}})).status,404);
  assert.equal((await http(proxy.url+'/control/',{headers:{host:'wrong.example'}})).status,403);
  const response=await http(proxy.url+'/control/api/session',{method:'POST',headers:{host,origin,cookie:'synthetic=value','x-control-csrf':'synthetic-csrf','content-type':'application/json'},body:'{}'});
  assert.equal(response.status,200);assert.equal(response.body,'control response');assert.match(response.headers['set-cookie'][0],/Secure/);
  assert.equal(received.length,1);assert.equal(received[0].headers.origin,origin);assert.equal(received[0].headers.cookie,'synthetic=value');
  current=null;assert.equal((await http(proxy.url+'/control/',{headers:{host}})).status,503);assert.equal(received.length,1);
 }finally{await proxy.close();await new Promise(resolve=>{backend.close(resolve);backend.closeAllConnections();});}
});
function fakeProcess(){const child=new EventEmitter();child.pid=42;child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{queueMicrotask(()=>child.emit('close',0));return true;};return child;}
test('tunnel keeps secrets out of child env, handles chunked output, and clears its URL on exit',async()=>{
 const urls=[],children=[];let options,args;
 const tunnel=new ControlTunnel({host:'127.0.0.1',port:8790,retryMs:60_000,onUrl:url=>urls.push(url),spawnImpl:(_binary,a,o)=>{args=a;options=o;const child=fakeProcess();children.push(child);return child;}});
 try{
  await tunnel.start();assert.equal(args.includes('--no-autoupdate'),true);assert.equal(options.shell,undefined);assert.equal(options.env.TELEGRAM_BOT_TOKEN,undefined);
  children[0].stderr.write('| https://neutral-ex');children[0].stderr.write('ample.trycloudflare.com |\n');
  assert.equal(tunnel.url,publicUrl);
  children[0].emit('close',1);assert.equal(tunnel.url,null);assert.equal(urls.at(-1),null);
 }finally{await tunnel.stop();}
});
test('a missing tunnel executable leaves the URL unavailable without stopping the caller',async()=>{
 const tunnel=new ControlTunnel({host:'127.0.0.1',port:8790,retryMs:60_000,spawnImpl:()=>{throw Error('synthetic missing executable');}});
 try{await tunnel.start();assert.equal(tunnel.url,null);}finally{await tunnel.stop();}
});

test('managed Gateway restarts retain the tunnel URL and later rotations reach the child',async()=>{
 const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {GatewayProcess}=await import('../host/supervisor.mjs');
 const root=await mkdtemp(join(tmpdir(),'control-child-'));const events=new EventEmitter(),seen=[];
 await mkdir(join(root,'dist'));await writeFile(join(root,'package.json'),'{"type":"module"}');
 await writeFile(join(root,'dist/main.js'),`process.on('message',m=>{
  if(m.type==='sophon:shutdown')process.exit(0);
  if(m.type==='sophon:control-url')process.send({type:'sophon:host-request',url:m.url,initial:process.env.SOPHON_CONTROL_TUNNEL_URL});
 });process.send({type:'sophon:ready'});`);
 const gateway=new GatewayProcess(root,{startupMs:5000,stopMs:5000,onRequest:message=>{seen.push(message);events.emit('message');}});
 const wait=predicate=>new Promise((resolve,reject)=>{
  const check=()=>{if(seen.some(predicate)){clearTimeout(timer);events.off('message',check);resolve();}};
  const timer=setTimeout(()=>{events.off('message',check);reject(Error('Synthetic child response timed out'));},5000);
  events.on('message',check);check();
 });
 try{
  gateway.setControlUrl(publicUrl);await gateway.start({path:root});await wait(m=>m.url===publicUrl&&m.initial===publicUrl);
  await gateway.stop();seen.length=0;await gateway.start({path:root});await wait(m=>m.url===publicUrl&&m.initial===publicUrl);
  gateway.setControlUrl(null);await wait(m=>m.url===null);
  const next='https://next-example.trycloudflare.com/control/';gateway.setControlUrl(next);await wait(m=>m.url===next);
 }finally{await gateway.stop();await rm(root,{recursive:true,force:true});}
});

test('component acquisition is asynchronous and shutdown prevents a late tunnel launch',async()=>{
 let release;const waiting=new Promise(resolve=>{release=resolve;});
 const events=[],tunnel=new ControlTunnel({host:'127.0.0.1',port:8790,resolveBinary:async signal=>{assert.equal(signal.aborted,false);await waiting;return 'synthetic-binary';},onUrl:(url,reason)=>events.push({url,reason}),spawnImpl:()=>assert.fail('shutdown must cancel launch')});
 await tunnel.start();assert.equal(events[0].reason,'preparing');
 const stopped=tunnel.stop();release();await stopped;assert.equal(tunnel.url,null);
});

test('component failures expose a fixed diagnostic and do not stop the caller',async()=>{
 const events=[],tunnel=new ControlTunnel({host:'127.0.0.1',port:8790,retryMs:60_000,resolveBinary:async()=>{throw Object.assign(Error('synthetic internal detail'),{code:'download_failed'});},onUrl:(url,reason)=>events.push({url,reason}),spawnImpl:()=>assert.fail('unverified component must not start')});
 try{await tunnel.start();await tunnel.launching;assert.equal(events.at(-1).reason,'download_failed');assert.equal(tunnel.url,null);}finally{await tunnel.stop();}
});
