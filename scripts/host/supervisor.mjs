import {fork} from 'node:child_process';
import {join} from 'node:path';

export class GatewayProcess {
 child;
 expectedExit=false;
 constructor(root,{onRequest=()=>{},onUnexpectedExit=()=>{},startupMs=120_000,stopMs=120_000}={}){
  Object.assign(this,{root,onRequest,onUnexpectedExit,startupMs,stopMs});
 }
 async start(release){
  if(this.child)throw Error('A Gateway process is already running.');
  this.expectedExit=false;
  const child=fork(join(release.path,'dist','main.js'),['serve'],{cwd:this.root,env:{...process.env,SOPHON_MANAGED_HOST:'1'},stdio:['inherit','inherit','inherit','ipc']});
  this.child=child;
  child.on('message',message=>{if(message?.type==='sophon:host-request')this.onRequest(message,child);});
  child.on('exit',code=>{if(this.child===child)this.child=undefined;if(!this.expectedExit)this.onUnexpectedExit(code);});
  await new Promise((resolve,reject)=>{
   const cleanup=()=>{clearTimeout(timer);child.off('message',ready);child.off('exit',exit);child.off('error',error);};
   const ready=message=>{if(message?.type==='sophon:ready'){cleanup();resolve();}};
   const exit=()=>{cleanup();reject(Error('Gateway exited before readiness.'));};
   const error=()=>{cleanup();reject(Error('Gateway process could not start.'));};
   const timer=setTimeout(()=>{cleanup();reject(Error('Gateway readiness timed out.'));},this.startupMs);
   child.on('message',ready);child.once('exit',exit);child.once('error',error);
  });
 }
 async stop(){
  const child=this.child;if(!child)return;this.expectedExit=true;
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{child.off('exit',done);reject(Error('Graceful shutdown timed out; no second Gateway was started.'));},this.stopMs);
   const done=()=>{clearTimeout(timer);resolve();};child.once('exit',done);
   if(child.connected)child.send({type:'sophon:shutdown'},()=>{});else child.kill('SIGTERM');
  });
 }
}
