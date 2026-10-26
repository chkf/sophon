import { backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { acquireInstanceLock } from '../service/instance-lock.js';
import { integrity, mainPath, openDatabase, StateError } from '../state/database.js';
import { validateSixSchema } from '../state/schema.js';
import { installMemorySchema, memoryMarker, MEMORY_TABLES, MEMORY_V1_TABLES } from './schema.js';
export async function inspectMemory(dataDir:string) {
  const path=mainPath(resolve(dataDir)),file=await lstat(path);
  if(!file.isFile()||file.isSymbolicLink())throw new StateError('记忆图迁移主库必须为普通文件。');
  const db=openDatabase(path,true);
  try {
    validateSixSchema(db);integrity(db);
    const marker=memoryMarker(db),space=await statfs(dirname(path));
    const bytes=Number(db.prepare('PRAGMA page_count').get()!.page_count)*Number(db.prepare('PRAGMA page_size').get()!.page_size);
    return {installed:!!marker,version:marker?.version??0,databaseBytes:bytes,requiredFreeBytes:bytes*3,
      availableBytes:Number(space.bavail)*Number(space.bsize),
      counts:marker?Object.fromEntries((marker.version===1?MEMORY_V1_TABLES:MEMORY_TABLES).map(name=>[name,Number(db.prepare('SELECT count(*) AS n FROM '+name).get()!.n)])): {}};
  }finally{db.close();}
}
export async function migrateMemory(dataDir:string,stopped:boolean) {
  if(!stopped)throw new StateError('请先停止 Gateway，再用 --stopped 显式迁移记忆图。');
  const root=resolve(dataDir),lock=await acquireInstanceLock(root);
  try {
    const preview=await inspectMemory(root);if(preview.version===2)return {...preview,changed:false};
    if(preview.availableBytes<preview.requiredFreeBytes)throw new StateError('空间不足，无法保留迁移快照。');
    const archive=join(root,'.memory-migration',randomUUID());await mkdir(archive,{recursive:true,mode:0o700});
    const db=openDatabase(mainPath(root));
    try {
      const snapshot=join(archive,'gateway.sqlite');await backup(db,snapshot);await chmod(snapshot,0o600);
      const copy=openDatabase(snapshot,true);try{validateSixSchema(copy);integrity(copy);}finally{copy.close();}
      await writeFile(join(archive,'manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),...preview})+'\n',{mode:0o600});
      installMemorySchema(db);validateSixSchema(db);integrity(db);
    }finally{db.close();}
    return {...await inspectMemory(root),changed:true,archive};
  }finally{await lock.release();}
}
/** All manual graph transitions use the same stopped-host lock and full pre-change snapshot. */
export async function manageMemory(dataDir:string,scope:string,action:'recent-migrate'|'bootstrap'|'undo',stopped:boolean,id?:string) {
 if(!stopped)throw new StateError('请先停止 Gateway，再用 --stopped 显式修改记忆图。');
 const root=resolve(dataDir),lock=await acquireInstanceLock(root);
 try{
  const preview=await inspectMemory(root);if(preview.version!==2)throw new StateError('请先升级记忆图扩展。');
  if(preview.availableBytes<preview.requiredFreeBytes)throw new StateError('空间不足，无法保留迁移快照。');
  const db=openDatabase(mainPath(root));
  try{
   const {MemoryStore}=await import('./store.js'),store=new MemoryStore(db,scope);
   if(!db.prepare('SELECT 1 FROM conversations WHERE key=?').get(scope))throw new StateError('不存在该 owner 的正式会话；请核对 owner。');
   const archive=join(root,'.memory-migration',randomUUID());await mkdir(archive,{recursive:true,mode:0o700});
   const snapshot=join(archive,'gateway.sqlite');await backup(db,snapshot);await chmod(snapshot,0o600);
   const copy=openDatabase(snapshot,true);try{validateSixSchema(copy);integrity(copy);}finally{copy.close();}
   await writeFile(join(archive,'manifest.json'),JSON.stringify({action,scope,createdAt:new Date().toISOString(),...preview})+'\n',{mode:0o600});
   let bootstrap:unknown;
   if(action==='bootstrap'){const {beginBootstrap}=await import('./bootstrap.js');bootstrap=beginBootstrap(store);}
   else if(action==='recent-migrate'){const {MemoryRecent}=await import('./recent.js');new MemoryRecent(store).migrate();}
   else {if(!id)throw new StateError('撤销需要整理操作 ID。');const {MemoryOrganizer}=await import('./organizer.js');new MemoryOrganizer(store).undo(id);}
   validateSixSchema(db);integrity(db);return {changed:true,action,revision:store.revision(),archive,...(bootstrap?{bootstrap}:{})};
  }finally{db.close();}
 }finally{await lock.release();}
}

export async function inspectBootstrap(dataDir:string,scope:string) {
 await inspectMemory(dataDir);
 const db=openDatabase(mainPath(resolve(dataDir)),true);
 try{const {MemoryStore}=await import('./store.js'),{bootstrapStatus}=await import('./bootstrap.js');return bootstrapStatus(new MemoryStore(db,scope));}
 finally{db.close();}
}

