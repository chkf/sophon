import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {rm} from 'node:fs/promises';
import {acquireLock,atomicJson,currentRelease,readJson,releaseFromPointer,saveRelease,stateDirectory} from './releases.mjs';
import {UpdateNotifications,sendOwnerNotification} from './notifications.mjs';
import {releaseRevision} from './health.mjs';
import {saveUpdateStatus} from './update-journal.mjs';

export async function managerModule(root,release){
 const protocol=await readJson(join(release.path,'update-protocol.json'),null);
 if(protocol?.host!==undefined&&protocol.host!==1)throw Error('Unsupported manager protocol.');
 // Legacy releases can be rolled back using the installed manager adapter.
 const directory=protocol?.host===1?release.path:root;
 return import(pathToFileURL(join(directory,'scripts/host/manager.mjs')).href);
}

/** A small stable launcher keeps ownership while operational code follows the release. */
export async function launchHost(root,{signal,load=managerModule,notify}={}){
 const dir=await stateDirectory(root),unlock=await acquireLock(root,'host',{role:'supervisor'},{reclaimStale:true});
 let unsafe=false;
 try{
  let release=await currentRelease(root),transaction=await readJson(join(dir,'activation.json'),null);
  if(transaction)release=await releaseFromPointer(root,transaction.candidate);
  let recovering=false;
  while(!signal?.aborted){
   let ready=false;
   try{
    const {runManager}=await load(root,release);
    if(typeof runManager!=='function')throw Error('Manager entry unavailable.');
    const next=await runManager({root,release,signal,verify:Boolean(transaction),onReady:async()=>{
     if(transaction){
      if(!recovering)await atomicJson(join(dir,'previous.json'),transaction.previous);
      await saveRelease(root,release.pointer);
      const result={id:transaction.id,at:new Date().toISOString(),phase:recovering?'rolled_back':'completed',source:transaction.source,beforeSha:transaction.beforeSha,sha:await releaseRevision(release),stage:transaction.stage,plan:transaction.plan};
      await saveUpdateStatus(root,result);
      const notices=new UpdateNotifications(root,notify??(text=>sendOwnerNotification(release.path,text)));
      await notices.enqueue(result);
      await rm(join(dir,'activation.json'),{force:true});
      await notices.flush();
      transaction=null;recovering=false;
     }
     ready=true;
    }});
    if(!next?.reload||signal?.aborted)return;
    transaction=await readJson(join(dir,'activation.json'),null);
    if(!transaction)throw Error('Missing activation checkpoint.');
    release=await releaseFromPointer(root,transaction.candidate);
   }catch(error){
    if(error.unsafeToRestart)unsafe=true;
    if(unsafe||ready||signal?.aborted||recovering){
     if(transaction){
      const result={id:transaction.id,at:new Date().toISOString(),phase:'failed',source:transaction.source,beforeSha:transaction.beforeSha,stage:unsafe?'shutdown':error.stage??'startup'};
      await saveUpdateStatus(root,result);
      const notices=new UpdateNotifications(root,notify??(text=>sendOwnerNotification(root,text)));
      await notices.enqueue(result);await notices.flush();
     }
     throw error;
    }
    const previous=transaction?transaction.previous:await readJson(join(dir,'previous.json'),undefined);
    if(previous===undefined||JSON.stringify(previous)===JSON.stringify(release.pointer))throw error;
    transaction={...transaction,previous,candidate:release.pointer,stage:error.stage??'startup'};
    release=await releaseFromPointer(root,previous);recovering=true;
   }
  }
 }finally{
  if(!unsafe)await unlock();
 }
}
