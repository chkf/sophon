import { randomUUID } from 'node:crypto';
import type { RecentEntry } from '../knowledge/store.js';
import { putState, transaction } from '../state/database.js';
import { MemoryStore } from './store.js';
import { bumpMemoryRevision, MEMORY_KEY, memoryMarker } from './schema.js';
import { normalizeName } from './validation.js';
/** Explicitly migrated Recent stays authoritative in context; the graph holds protected references only. */
export class MemoryRecent {
 constructor(private readonly store:MemoryStore){}
 enabled():boolean{return memoryMarker(this.store.db)?.recentScopes?.includes(this.store.scope)===true;}
 migrate():number {
  return transaction(this.store.db,()=>{
   const marker=memoryMarker(this.store.db)!;
   if(!this.enabled())putState(this.store.db,{key:MEMORY_KEY,category:'metadata',value:JSON.stringify({...marker,recentScopes:[...(marker.recentScopes??[]),this.store.scope]})});
   return this.sync();
  });
 }
 sync():number {
  if(!this.enabled())return 0;
  return transaction(this.store.db,()=>{
   const db=this.store.db,at=new Date().toISOString();let changed=0;
   const rows=db.prepare("SELECT * FROM context WHERE kind='recent' AND (source_id IS NULL OR source_id NOT LIKE 'media:%')").all() as {id:string;body:string;conversation_state:string|null;revision:number;updated_at:string}[];
   if(rows.length&&!db.prepare('SELECT 1 FROM conversations WHERE key=?').get(this.store.scope))return 0;
   let root=db.prepare("SELECT id FROM memory_topics WHERE owner_scope=? AND parent_id IS NULL AND normalized_name=? AND status='active'").get(this.store.scope,normalizeName('持续事项'))?.id as string|undefined;
   for(const row of rows){
    let link=db.prepare('SELECT * FROM memory_recent_links WHERE owner_scope=? AND recent_id=?').get(this.store.scope,row.id);
    if(link&&link.recent_revision===row.revision)continue;
    if(!root){root=randomUUID();db.prepare('INSERT INTO memory_topics(id,owner_scope,name,normalized_name,description,mass_updated_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(root,this.store.scope,'持续事项',normalizeName('持续事项'),'由 SQLite Recent 明确迁入的持续事项；正文与状态以 Recent 为准。',at,at,at);}
    const id=link?String(link.node_id):randomUUID(),active=row.conversation_state!=='Done';
    if(!link){
     db.prepare(`INSERT INTO memory_nodes(id,owner_scope,kind,conv_key,gist,importance,half_life_days,reinforced_at,token_estimate,created_at,updated_at)
      VALUES(?,?,'rollup',?,'',1,180,?,0,?,?)`).run(id,this.store.scope,this.store.scope,at,at,at);
     db.prepare('INSERT INTO memory_recent_links VALUES(?,?,?,?)').run(id,row.id,this.store.scope,row.revision);
     db.prepare('INSERT INTO memory_topic_memberships(topic_id,node_id,score,created_at) VALUES(?,?,1,?)').run(root,id,at);
    }
    // No Recent body, plan or private text is duplicated in the graph.
    db.prepare('UPDATE memory_nodes SET status=?,gist=?,revision=revision+1,updated_at=? WHERE id=?').run(active?'active':'archived','Recent 事项 '+row.id,at,id);
    db.prepare('UPDATE memory_recent_links SET recent_revision=? WHERE node_id=?').run(row.revision,id);
    db.prepare('UPDATE memory_topic_memberships SET status=? WHERE node_id=?').run(active?'active':'archived',id);changed++;
   }
   if(changed)bumpMemoryRevision(db);return changed;
  });
 }
 remainingDirectory(entries:readonly RecentEntry[]):RecentEntry[] {
  if(!this.enabled())return [...entries];this.sync();
  const mapped=new Map((this.store.db.prepare('SELECT recent_id,recent_revision FROM memory_recent_links WHERE owner_scope=?').all(this.store.scope) as {recent_id:string;recent_revision:number}[]).map(r=>[r.recent_id,r.recent_revision]));
  return entries.filter(e=>e.sourceId?.startsWith('media:')||mapped.get(e.id)!==e.revision);
 }
}

