import {backup} from 'node:sqlite';
import {chmod,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readInstanceOwner,type InstanceLock} from '../service/instance-lock.js';
import {mainPath,openDatabase,integrity} from '../state/database.js';
import {validateSixSchema} from '../state/schema.js';
import {inspectMemory} from './migration.js';
import {installMemorySchema} from './schema.js';
import {MemoryStore} from './store.js';
import {bootstrapStatus,beginBootstrap} from './bootstrap.js';

/** Startup only, under the same ownership lock held through service shutdown. No model calls. */
export async function prepareStartupMemory(dataDir:string,ownerId:string,lock:InstanceLock){
 const owner=await readInstanceOwner(dataDir);
 if(!owner||owner.pid!==process.pid||owner.takeoverToken!==lock.takeoverToken)throw Error('Memory preparation requires the active instance lock.');
 if(!/^\d+$/.test(ownerId))throw Error('Memory preparation requires a configured owner.');
 const preview=await inspectMemory(dataDir),db=openDatabase(mainPath(dataDir));
 try{
  const scope='telegram:'+ownerId;
  if(preview.version===2){
   const progress=bootstrapStatus(new MemoryStore(db,scope));
   if(progress.initialized&&!progress.missingTurns&&!progress.staleTurns)return {changed:false};
  }
  if(preview.availableBytes<preview.requiredFreeBytes)throw Error('Insufficient space for the memory snapshot.');
  const archive=join(dataDir,'.memory-migration',randomUUID());await mkdir(archive,{recursive:true,mode:0o700});
  const snapshot=join(archive,'gateway.sqlite');await backup(db,snapshot);await chmod(snapshot,0o600);
  const copy=openDatabase(snapshot,true);try{validateSixSchema(copy);integrity(copy);}finally{copy.close();}
  await writeFile(join(archive,'manifest.json'),JSON.stringify({action:'startup-memory',createdAt:new Date().toISOString(),version:preview.version,databaseBytes:preview.databaseBytes})+'\n',{mode:0o600});
  installMemorySchema(db);
  // An empty owner history is valid. New delivered turns will enter the same queue.
  beginBootstrap(new MemoryStore(db,scope),new Date(),{retryFailures:false});
  validateSixSchema(db);integrity(db);
  return {changed:true,archive};
 }finally{db.close();}
}
