import { createHash, randomUUID } from 'node:crypto';
import type { ChatRuntime } from '../runtime/types.js';
import { transaction } from '../state/database.js';
import { MemoryStore } from './store.js';
import { bumpMemoryRevision } from './schema.js';
import { activation } from './weights.js';
import { MemoryError, normalizeName } from './validation.js';
import { boundedText, jsonObject, parseFusion, type Fusion } from './tasks.js';
interface Material {id:string;gist:string;summary:string;detail:string;importance:number;activation_base:number;half_life_days:number;reinforced_at:string;revision:number;kind:string;token_estimate:number;created_at:string}
interface Source {source_id:number;content:string;role:string;at:string;chars:number;offset?:number}
interface Snapshot {nodes:Material[];sources:Map<string,Source[]>;fingerprint:string}
interface Child {key:string;name:string;description:string}
interface Unit {node_ids:string[];sources:Source[]}
interface Rollup {fusion:Fusion;source_ids:number[]}
interface Progress {fingerprint:string;phase:'decide'|'assign'|'fuse'|'verify'|'commit';next:number;children?:Child[];assignments?:Record<string,string|null>;rollups:Rollup[];current?:Rollup;candidate?:Rollup}
interface Operation {id:string;topic_id:string;lease:string;attempts:number;payload:string}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Each tick makes at most one isolated call. Only the final transaction changes memberships. */
export class MemoryOrganizer {
 constructor(private readonly store:MemoryStore){}
 private snapshot(topic:string):Snapshot {
  const db=this.store.db;
  const nodes=db.prepare(`SELECT n.* FROM memory_topic_memberships x JOIN memory_nodes n ON n.id=x.node_id
   WHERE x.topic_id=? AND x.status='active' AND n.status='active' AND n.owner_scope=?
   AND NOT EXISTS(SELECT 1 FROM memory_recent_links r WHERE r.node_id=n.id) ORDER BY n.created_at,n.id`).all(topic,this.store.scope) as unknown as Material[];
  const sources=new Map<string,Source[]>(nodes.map(n=>[n.id,[]]));
  for(const row of db.prepare(`SELECT s.node_id,m.rowid AS source_id,length(m.content) AS chars,m.role,m.at FROM memory_topic_memberships x
    JOIN memory_sources s ON s.node_id=x.node_id JOIN messages m ON m.rowid=s.message_rowid
    WHERE x.topic_id=? AND x.status='active' AND m.conv_key=? ORDER BY m.seq`).iterate(topic,this.store.scope)) {
    sources.get(String(row.node_id))?.push({...row,content:''} as unknown as Source);
  }
  return {nodes,sources,fingerprint:hash([nodes,[...sources]])};
 }
 enqueue(now=new Date()):void {
  const db=this.store.db,at=now.toISOString();
  // Bound discovery per tick. Only leaves organize; a split parent retains ambiguous evidence.
  const rows=db.prepare(`SELECT t.id FROM memory_topics t JOIN memory_topic_memberships x ON x.topic_id=t.id
    JOIN memory_nodes n ON n.id=x.node_id WHERE t.owner_scope=? AND t.status='active' AND x.status='active' AND n.status='active'
    AND NOT EXISTS(SELECT 1 FROM memory_recent_links r WHERE r.node_id=n.id)
    AND NOT EXISTS(SELECT 1 FROM memory_topics c WHERE c.parent_id=t.id AND c.status='active') GROUP BY t.id
    HAVING count(*)>=64 OR sum(n.token_estimate)>=4000 ORDER BY t.updated_at LIMIT 32`).all(this.store.scope) as {id:string}[];
  for(const {id} of rows){
   if(db.prepare("SELECT 1 FROM memory_operations WHERE topic_id=? AND status IN ('pending','running','retry')").get(id))continue;
   const snap=this.snapshot(id);if(snap.nodes.length<2||!snap.nodes.some(n=>n.kind==='turn'))continue;
   const progress:Progress={fingerprint:snap.fingerprint,phase:'decide',next:0,rollups:[]};
   db.prepare(`INSERT OR IGNORE INTO memory_operations(id,owner_scope,topic_id,operation_key,status,run_after,payload,created_at,updated_at)
    VALUES(?,?,?,?,'pending',?,?,?,?)`).run(randomUUID(),this.store.scope,id,id+':'+snap.fingerprint,at,JSON.stringify(progress),at,at);
  }
 }
 private claim(now:Date):Operation|undefined {
  return transaction(this.store.db,()=>{
   const db=this.store.db,at=now.toISOString();
   db.prepare("UPDATE memory_operations SET status='retry',lease=NULL,error_code='INTERRUPTED',run_after=? WHERE owner_scope=? AND status='running' AND updated_at<?").run(at,this.store.scope,new Date(+now-15*60_000).toISOString());
   const row=db.prepare("SELECT * FROM memory_operations WHERE owner_scope=? AND status IN ('pending','retry') AND run_after<=? ORDER BY created_at,id LIMIT 1").get(this.store.scope,at) as unknown as Operation|undefined;
   if(!row)return;const lease=randomUUID();db.prepare("UPDATE memory_operations SET status='running',lease=?,attempts=attempts+1,updated_at=? WHERE id=?").run(lease,at,row.id);
   return {...row,lease,attempts:row.attempts+1};
  });
 }
 private assertCurrent(op:Operation,p:Progress):Snapshot {
  if(!this.store.db.prepare("SELECT 1 FROM memory_operations WHERE id=? AND owner_scope=? AND status='running' AND lease=?").get(op.id,this.store.scope,op.lease))throw new MemoryError('SOURCE_CHANGED');
  const snap=this.snapshot(op.topic_id);if(snap.fingerprint!==p.fingerprint)throw new MemoryError('SOURCE_CHANGED');return snap;
 }
 private save(op:Operation,p:Progress):void {
  transaction(this.store.db,()=>{
   this.assertCurrent(op,p);
   this.store.db.prepare("UPDATE memory_operations SET status='pending',lease=NULL,payload=?,attempts=0,updated_at=?,run_after=? WHERE id=?").run(JSON.stringify(p),new Date().toISOString(),new Date().toISOString(),op.id);
  });
 }
 private units(snap:Snapshot):Unit[] {
  const units:Unit[]=[];let unit:Unit={node_ids:[],sources:[]},size=0;
  for(const n of snap.nodes)for(const s of snap.sources.get(n.id)??[])for(let offset=0;offset<s.chars;offset+=6000){
   const part={...s,offset,chars:Math.min(6000,s.chars-offset)};
   if(size+part.chars>6000&&unit.sources.length){units.push(unit);unit={node_ids:[],sources:[]};size=0;}
   if(!unit.node_ids.includes(n.id))unit.node_ids.push(n.id);unit.sources.push(part);size+=part.chars;
  }
  if(unit.sources.length)units.push(unit);return units;
 }
 private materialize(unit:Unit):Unit {
  return {...unit,sources:unit.sources.map(s=>({...s,content:String(this.store.db.prepare('SELECT substr(content,?,?) AS content FROM messages WHERE rowid=? AND conv_key=?').get((s.offset??0)+1,s.chars,s.source_id,this.store.scope)?.content??'')}))};
 }
 async tick(runtime:ChatRuntime,now=new Date()):Promise<boolean> {
  this.enqueue(now);const op=this.claim(now);if(!op)return false;
  try {
   if(!runtime.runMemoryTask)throw new MemoryError('CLASSIFIER_UNAVAILABLE');
   const p=JSON.parse(op.payload) as Progress,snap=this.assertCurrent(op,p);
   const call=async(task:Parameters<NonNullable<ChatRuntime['runMemoryTask']>>[0],input:unknown)=>runtime.runMemoryTask!(task,JSON.stringify(input));
   if(p.phase==='decide'){
    const topic=this.store.topics().find(t=>t.id===op.topic_id)!;
    // Temporal, important and recent samples prevent one repetitive event from dominating the decision.
    const sample=new Map<string,Material>();
    for(const n of [...snap.nodes.slice(0,8),...snap.nodes.slice(-8),...[...snap.nodes].sort((a,b)=>b.importance-a.importance).slice(0,8),...snap.nodes.filter((_,i)=>i%Math.max(1,Math.floor(snap.nodes.length/16))===0).slice(0,16)])sample.set(n.id,n);
    const choice=jsonObject(await call('organize',{topic,total_nodes:snap.nodes.length,materials:[...sample.values()].map(n=>({id:n.id,gist:n.gist,importance:n.importance,activation:activation(n.activation_base,n.reinforced_at,n.half_life_days,+now)}))}));
    if(choice.action==='split'){
     if(!Array.isArray(choice.children)||choice.children.length<2||choice.children.length>6||choice.children.some(c=>!boundedText(c.key,60)||!boundedText(c.name,60)||!normalizeName(c.name)||!boundedText(c.description,240))||new Set(choice.children.map(c=>normalizeName(c.name))).size!==choice.children.length||new Set(choice.children.map(c=>c.key)).size!==choice.children.length)throw new MemoryError('INVALID_MEMORY_OUTPUT');
     let depth=1,cursor=topic;const topics=this.store.topics();while(cursor.parent_id){depth++;cursor=topics.find(t=>t.id===cursor.parent_id)!;}
     if(depth>=6)throw new MemoryError('TOPIC_INVALID');
     p.children=choice.children;p.assignments={};p.phase='assign';
    }else if(choice.action==='fuse'){p.phase='fuse';}
    else if(choice.action==='archive'){this.commitArchive(op,p,snap,now);return true;}
    else throw new MemoryError('INVALID_MEMORY_OUTPUT');
   }else if(p.phase==='assign'){
    // A rollup is classified from its original evidence. Large/ambiguous items stay on the parent.
    const batch=snap.nodes.slice(p.next,p.next+8),materials=batch.map(n=>({node_id:n.id,gist:n.gist,sources:snap.sources.get(n.id)!}));
    const eligible=materials.filter(n=>n.sources.reduce((sum,s)=>sum+s.chars,0)<=3000).map(n=>({...n,sources:this.materialize({node_ids:[n.node_id],sources:n.sources}).sources}));
    if(eligible.length){
     const v=jsonObject(await call('assign',{children:p.children,materials:eligible}));
     if(!Array.isArray(v.assignments)||JSON.stringify(v.assignments.map(a=>a.node_id).sort())!==JSON.stringify(eligible.map(a=>a.node_id).sort())||v.assignments.some(a=>a.child_key!==null&&!p.children!.some(c=>c.key===a.child_key)))throw new MemoryError('INVALID_MEMORY_OUTPUT');
     for(const a of v.assignments)p.assignments![a.node_id]=a.child_key;
    }
    for(const n of materials)if(!(n.node_id in p.assignments!))p.assignments![n.node_id]=null;
    p.next+=batch.length;if(p.next>=snap.nodes.length)p.phase='commit';
   }else if(p.phase==='fuse'){
    const units=this.units(snap),unit=units[p.next]?this.materialize(units[p.next]!):undefined;
    if(!unit){if(p.current)p.rollups.push(p.current);delete p.current;p.phase='commit';}
    else {
     // Preserve a saturated rollup as its own event bundle instead of silently dropping highlights.
     if(p.current&&(p.current.fusion.highlights.length>16||JSON.stringify(p.current.fusion).length>8000)){p.rollups.push(p.current);delete p.current;}
     const previous=p.current?.fusion;
     const raw=await call('fuse',{materials:{...unit,nodes:snap.nodes.filter(n=>unit.node_ids.includes(n.id)).map(n=>({id:n.id,gist:n.gist,importance:n.importance,activation:activation(n.activation_base,n.reinforced_at,n.half_life_days,+now)}))},previous});
     const sourceMap=new Map<number,string>();for(const s of unit.sources)sourceMap.set(s.source_id,(sourceMap.get(s.source_id)??'')+s.content);for(const h of previous?.highlights??[])sourceMap.set(h.source_id,(sourceMap.get(h.source_id)??'')+h.quote);
     const fusion=parseFusion(raw,sourceMap,unit.node_ids,previous);
     p.candidate={fusion,source_ids:[...new Set([...(p.current?.source_ids??[]),...unit.sources.map(s=>s.source_id)])]};p.phase='verify';
    }
   }else if(p.phase==='verify'){
    const unit=this.materialize(this.units(snap)[p.next]!);
    const v=jsonObject(await call('verify',{originals:unit.sources,previous:p.current?.fusion,candidate:p.candidate!.fusion}));
    if(v.ok!==true)throw new MemoryError('FUSION_UNVERIFIED');
    p.current=p.candidate;delete p.candidate;p.next++;p.phase='fuse';
   }else if(p.phase==='commit'){this.commit(op,p,snap,now);return true;}
   else throw new MemoryError('INVALID_MEMORY_OUTPUT');
   this.save(op,p);return true;
  }catch(error){
   const code=error instanceof MemoryError?error.code:'MODEL_UNAVAILABLE';
   const terminal=code==='SOURCE_CHANGED'||(op.attempts>=3&&['FUSION_UNVERIFIED','INVALID_JSON','INVALID_MEMORY_OUTPUT','FUSION_LOSS','TOPIC_INVALID','TASK_INPUT_LIMIT'].includes(code));
   this.store.db.prepare("UPDATE memory_operations SET status=?,lease=NULL,error_code=?,run_after=?,updated_at=? WHERE id=? AND lease=?").run(terminal?'failed':'retry',code,new Date(+now+Math.min(6*3600_000,60_000*2**Math.min(op.attempts,8))).toISOString(),now.toISOString(),op.id,op.lease);
   // Availability/quota errors also pause the shared worker, not just this operation.
   if(! (error instanceof MemoryError) ||code==='CLASSIFIER_UNAVAILABLE')throw error;
   return true;
  }
 }
 private finish(op:Operation,before:unknown,now:Date):void {
  bumpMemoryRevision(this.store.db);
  this.store.db.prepare('INSERT INTO memory_audit(id,owner_scope,kind,revision,payload,created_at) VALUES(?,?,?,?,?,?)').run(op.id,this.store.scope,'organize',this.store.revision(),JSON.stringify(before),now.toISOString());
  this.store.db.prepare("UPDATE memory_operations SET status='done',lease=NULL,payload='{}',updated_at=? WHERE id=?").run(now.toISOString(),op.id);
 }
 private commitArchive(op:Operation,p:Progress,snap:Snapshot,now:Date):void {
  transaction(this.store.db,()=>{
   this.assertCurrent(op,p);let tokens=snap.nodes.reduce((a,n)=>a+n.token_estimate,0);const removed:string[]=[];
   for(const n of [...snap.nodes].sort((a,b)=>a.importance-b.importance)){
    // Plans/corrections/important events are never selected by a capacity shortcut.
    if(tokens<=2500||n.importance>=0.4||n.half_life_days>7||activation(n.activation_base,n.reinforced_at,n.half_life_days,+now)>0.15)continue;
    this.store.db.prepare("UPDATE memory_topic_memberships SET status='archived' WHERE topic_id=? AND node_id=?").run(op.topic_id,n.id);removed.push(n.id);tokens-=n.token_estimate;
   }
   this.finish(op,{topic:op.topic_id,removed,added:[],children:[]},now);
  });
 }
 private commit(op:Operation,p:Progress,snap:Snapshot,now:Date):void {
  transaction(this.store.db,()=>{
   this.assertCurrent(op,p);const db=this.store.db,at=now.toISOString(),removed:string[]=[],added:{topic:string;node:string}[]=[],children:string[]=[];
   if(p.children){
    const assigned=p.children.filter(c=>Object.values(p.assignments!).includes(c.key));
    if(assigned.length<2)throw new MemoryError('TOPIC_INVALID');
    const childIds=new Map<string,string>();
    for(const c of assigned){const id=randomUUID();childIds.set(c.key,id);children.push(id);
     db.prepare('INSERT INTO memory_topics(id,owner_scope,parent_id,name,normalized_name,description,mass_updated_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,this.store.scope,op.topic_id,c.name,normalizeName(c.name),c.description,at,at,at);}
    for(const n of snap.nodes){const key=p.assignments![n.id];if(!key)continue;const id=childIds.get(key)!;
     db.prepare("INSERT INTO memory_topic_memberships(topic_id,node_id,score,created_at) SELECT ?,node_id,score,? FROM memory_topic_memberships WHERE topic_id=? AND node_id=?").run(id,at,op.topic_id,n.id);
     db.prepare("UPDATE memory_topic_memberships SET status='covered' WHERE topic_id=? AND node_id=?").run(op.topic_id,n.id);removed.push(n.id);added.push({topic:id,node:n.id});
    }
   }else{
    if(!p.rollups.length)throw new MemoryError('INVALID_MEMORY_OUTPUT');
    const covered=new Set(p.rollups.flatMap(r=>r.source_ids));
    if([...snap.sources.values()].flat().some(s=>!covered.has(s.source_id)))throw new MemoryError('FUSION_LOSS');
    for(const r of p.rollups){const id=randomUUID(),sourceIds=new Set(r.source_ids);
     const material=snap.nodes.filter(n=>snap.sources.get(n.id)!.some(s=>sourceIds.has(s.source_id)));
     const base=Math.max(...material.map(n=>activation(n.activation_base,n.reinforced_at,n.half_life_days,+now)));
     const eventAt=material.map(n=>n.created_at).sort().at(-1)!;
     db.prepare(`INSERT INTO memory_nodes(id,owner_scope,kind,conv_key,gist,summary,detail,importance,activation_base,half_life_days,reinforced_at,token_estimate,created_at,updated_at)
      VALUES(?,?,'rollup',?,?,?,?,?,?,?,?,?,?,?)`).run(id,this.store.scope,this.store.scope,r.fusion.gist,r.fusion.summary,JSON.stringify({highlights:r.fusion.highlights,uncertainties:r.fusion.uncertainties}),Math.max(...material.map(n=>n.importance)),base,Math.max(...material.map(n=>n.half_life_days)),at,Math.ceil(JSON.stringify(r.fusion).length/2),eventAt,at);
     for(const source of r.source_ids)db.prepare('INSERT INTO memory_sources VALUES(?,?)').run(id,source);
     db.prepare('INSERT INTO memory_topic_memberships(topic_id,node_id,score,created_at) VALUES(?,?,1,?)').run(op.topic_id,id,at);added.push({topic:op.topic_id,node:id});
    }
    for(const n of snap.nodes){db.prepare("UPDATE memory_topic_memberships SET status='covered' WHERE topic_id=? AND node_id=?").run(op.topic_id,n.id);removed.push(n.id);}
   }
   // Mass is a bounded normalized view, never a descendant sum that turns broad parents into hubs.
   for(const id of [op.topic_id,...children])db.prepare(`UPDATE memory_topics SET occurrence_mass=(SELECT COALESCE(avg(score),0) FROM
    (SELECT x.score FROM memory_topic_memberships x JOIN memory_nodes n ON n.id=x.node_id WHERE x.topic_id=? AND x.status='active' AND n.status='active' ORDER BY n.importance DESC LIMIT 8)),mass_updated_at=?,revision=revision+1,updated_at=? WHERE id=?`).run(id,at,at,id);
   this.finish(op,{topic:op.topic_id,removed,added,children},now);
  });
 }
 /** Explicit rollback is revision-fenced; a stale source or later graph edit cannot be resurrected. */
 undo(id:string,now=new Date()):void {
  transaction(this.store.db,()=>{
   const db=this.store.db,row=db.prepare("SELECT * FROM memory_audit WHERE id=? AND owner_scope=? AND kind='organize' AND undone_at IS NULL").get(id,this.store.scope);
   if(!row||Number(row.revision)!==this.store.revision())throw new MemoryError('UNDO_CONFLICT');
   const p=JSON.parse(String(row.payload)) as {topic:string;removed:string[];added:{topic:string;node:string}[];children:string[]};
   for(const node of p.removed){if(!db.prepare("SELECT 1 FROM memory_nodes WHERE id=? AND owner_scope=? AND status='active'").get(node,this.store.scope))throw new MemoryError('SOURCE_CHANGED');}
   for(const a of p.added)db.prepare("UPDATE memory_topic_memberships SET status='archived' WHERE topic_id=? AND node_id=?").run(a.topic,a.node);
   for(const node of p.removed)db.prepare("UPDATE memory_topic_memberships SET status='active' WHERE topic_id=? AND node_id=?").run(p.topic,node);
   for(const topic of p.children)db.prepare("UPDATE memory_topics SET status='archived' WHERE id=?").run(topic);
   db.prepare('UPDATE memory_audit SET undone_at=? WHERE id=?').run(now.toISOString(),id);bumpMemoryRevision(db);
  });
 }
}

