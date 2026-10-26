import { getState, putState, transaction } from '../state/database.js';
import type { Job, MemoryStore } from './store.js';
import { MemoryError } from './validation.js';
import { MemoryRecent } from './recent.js';
import { bumpMemoryRevision } from './schema.js';
interface BootstrapState {version:1;scope:string;startedAt:string;throughRowid:number;enqueued:number}
const key=(scope:string)=>'system/memory_bootstrap/'+scope;
export function bootstrapState(store:MemoryStore):BootstrapState|undefined {
 const row=getState(store.db,key(store.scope));if(!row)return;
 let state:BootstrapState;try{state=JSON.parse(row.value);}catch{throw new MemoryError('INVALID_BOOTSTRAP_STATE');}
 if(row.category!=='metadata'||row.encoding!=='json'||state.version!==1||state.scope!==store.scope||!Number.isFinite(Date.parse(state.startedAt))||!Number.isSafeInteger(state.throughRowid)||state.throughRowid<0||!Number.isSafeInteger(state.enqueued)||state.enqueued<0)throw new MemoryError('INVALID_BOOTSTRAP_STATE');
 return state;
}
export function isBackfillJob(store:MemoryStore,job:Job):boolean {
 const state=bootstrapState(store);return !!state&&job.assistant_rowid<=state.throughRowid&&typeof job.created_at==='string'&&job.created_at<=state.startedAt;
}
/** Read-only live readiness. An earlier successful bootstrap cannot hide later unindexed history. */
export function bootstrapStatus(store:MemoryStore) {
 const state=bootstrapState(store),db=store.db,scope=store.scope;
 const jobs=store.stats();
 const missing=Number(db.prepare(`SELECT count(*) n FROM messages m WHERE m.conv_key=? AND m.role='assistant'
   AND COALESCE(m.origin,'chat')='chat' AND COALESCE(m.partial,0)=0 AND NOT EXISTS
   (SELECT 1 FROM memory_jobs j WHERE j.owner_scope=? AND j.kind='classify' AND j.operation_key='classify:'||m.rowid)`).get(scope,scope)!.n);
 const stale=Number(db.prepare(`SELECT count(*) n FROM memory_nodes n JOIN messages m ON m.rowid=n.assistant_rowid
   WHERE n.owner_scope=? AND n.kind='turn' AND n.status='stale'`).get(scope)!.n);
 const outstanding=(jobs.pending??0)+(jobs.running??0)+(jobs.retry??0),failed=jobs.failed??0;
 return {initialized:!!state,ready:!!state&&!missing&&!stale&&!outstanding&&!failed,startedAt:state?.startedAt,
   throughRowid:state?.throughRowid,queuedAtBootstrap:state?.enqueued??0,jobs,missingTurns:missing,staleTurns:stale,
   needsBootstrap:!state||missing>0||stale>0||failed>0,
   operations:Object.fromEntries((db.prepare('SELECT status,count(*) n FROM memory_operations WHERE owner_scope=? GROUP BY status').all(scope) as {status:string;n:number}[]).map(r=>[r.status,r.n]))};
}
/** Explicit stopped-host command: queue original owner exchanges; never call models while holding the lock. */
export function beginBootstrap(store:MemoryStore,now=new Date()) {
 return transaction(store.db,()=>{
  const db=store.db,at=now.toISOString(),previous=bootstrapState(store);
  if(previous&&bootstrapStatus(store).ready){new MemoryRecent(store).migrate();return {...bootstrapStatus(store),enqueuedNow:0};}
  const anchors=db.prepare(`SELECT rowid FROM messages WHERE conv_key=? AND role='assistant'
    AND COALESCE(origin,'chat')='chat' AND COALESCE(partial,0)=0 ORDER BY seq`).all(store.scope) as {rowid:number}[];
  let enqueued=0;
  for(const {rowid} of anchors){
   // Explicit rebuild discards invalid derived turn nodes only. Original messages and stale rollup evidence remain untouched.
   const removed=db.prepare("DELETE FROM memory_nodes WHERE owner_scope=? AND kind='turn' AND assistant_rowid=? AND status='stale'").run(store.scope,rowid).changes;
   if(removed)db.prepare("UPDATE memory_jobs SET status='pending',lease=NULL,attempts=0,error_code=NULL,run_after=?,updated_at=? WHERE owner_scope=? AND operation_key=?").run(at,at,store.scope,'classify:'+rowid);
   const existed=db.prepare('SELECT 1 FROM memory_jobs WHERE owner_scope=? AND operation_key=?').get(store.scope,'classify:'+rowid);
   store.enqueue(rowid,at,true);if(!existed)enqueued++;
  }
  db.prepare("UPDATE memory_jobs SET status='pending',lease=NULL,attempts=0,error_code=NULL,run_after=?,updated_at=? WHERE owner_scope=? AND status IN ('failed','running')").run(at,at,store.scope);
  const throughRowid=Number(db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM messages WHERE conv_key=?').get(store.scope)!.n);
  putState(db,{key:key(store.scope),category:'metadata',value:JSON.stringify({version:1,scope:store.scope,startedAt:at,throughRowid,enqueued:anchors.length} satisfies BootstrapState)});
  new MemoryRecent(store).migrate();bumpMemoryRevision(db);
  return {...bootstrapStatus(store),enqueuedNow:enqueued};
 });
}

