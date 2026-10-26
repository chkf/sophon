import { bootstrapState, bootstrapStatus } from './bootstrap.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../state/database.js';
import { bumpMemoryRevision, memoryMarker, validateMemorySchema } from './schema.js';
import { MemoryError, normalizeName, type Classification } from './validation.js';
import { validateEvidence } from './tasks.js';
import { activation, decayedMass, halfLife } from './weights.js';
export interface Topic { id:string;parent_id:string|null;name:string;description:string;aliases:string;occurrence_mass:number;mass_updated_at:string }
export interface Source { rowid:number;seq:number;role:'user'|'assistant';content:string;at:string;origin:string|null;partial:number|null }
export interface Turn { assistant:number; sources:Source[]; context:Source[]; fingerprint:string }
export interface Job { id:string;assistant_rowid:number;attempts:number;lease:string;created_at?:string }
export interface MemoryHit { id:string;gist:string;activation:number;importance:number;score:number;paths:string[] }
export const MAX_TURN_CHARS=24_000;
export class MemoryStore {
  constructor(readonly db:DatabaseSync, readonly scope:string) {
    if(!/^telegram:\d+$/.test(scope)||!validateMemorySchema(db)||memoryMarker(db)?.version!==2)throw new MemoryError('MEMORY_NOT_MIGRATED');
  }
  revision():number { return memoryMarker(this.db)!.revision; }
  topics():Topic[] { return this.db.prepare("SELECT * FROM memory_topics WHERE owner_scope=? AND status='active' ORDER BY created_at,id").all(this.scope) as unknown as Topic[]; }
  enqueue(assistant:number, now=new Date().toISOString(), allowLegacy=false):void {
    const row=this.db.prepare('SELECT conv_key,role,origin,partial FROM messages WHERE rowid=?').get(assistant);
    if(!row||row.conv_key!==this.scope||row.role!=='assistant'||(row.origin!=='chat'&&!(allowLegacy&&row.origin===null))||(row.partial!==0&&!(allowLegacy&&row.partial===null)))return;
    this.db.prepare(`INSERT OR IGNORE INTO memory_jobs(id,owner_scope,kind,operation_key,assistant_rowid,status,run_after,created_at,updated_at)
      VALUES(?,?,'classify',?,?,'pending',?,?,?)`).run(randomUUID(),this.scope,'classify:'+assistant,assistant,now,now,now);
  }
  collect(assistant:number):Turn {
    const anchor=this.db.prepare("SELECT seq,conv_key,role,origin,partial FROM messages WHERE rowid=?").get(assistant);
    if(!anchor||anchor.conv_key!==this.scope||anchor.role!=='assistant'||(anchor.origin!==null&&anchor.origin!=='chat')||(anchor.partial!==null&&anchor.partial!==0))throw new MemoryError('SOURCE_CHANGED');
    const previous=this.db.prepare(`SELECT MAX(seq) AS seq FROM messages WHERE conv_key=? AND seq<?
      AND role='assistant' AND COALESCE(origin,'chat')='chat' AND COALESCE(partial,0)=0`).get(this.scope,anchor.seq!)?.seq;
    const start=typeof previous==='number'?previous+1:0;
    const sources=this.db.prepare(`SELECT rowid,seq,role,content,at,origin,partial FROM messages WHERE conv_key=? AND seq>=? AND seq<=?
      AND COALESCE(origin,'chat')='chat' ORDER BY seq`).all(this.scope,start,anchor.seq!) as unknown as Source[];
    if(!sources.some(x=>x.role==='user'))throw new MemoryError('NO_USER_TURN');
    const context=this.db.prepare(`SELECT rowid,seq,role,content,at,origin,partial FROM messages WHERE conv_key=? AND seq<?
      AND COALESCE(origin,'chat')='chat' ORDER BY seq DESC LIMIT 4`).all(this.scope,start).reverse() as unknown as Source[];
    // The fingerprint includes the entire source boundary; seq changes during deletion are detected too.
    return {assistant,sources,context,fingerprint:createHash('sha256').update(JSON.stringify(sources)).digest('hex')};
  }
  claim(now=new Date()):Job|undefined {
    return transaction(this.db,()=>{
      const at=now.toISOString(),bootstrap=bootstrapState(this);
      this.db.prepare(`UPDATE memory_jobs SET status='retry',lease=NULL,error_code='INTERRUPTED',run_after=?
        WHERE owner_scope=? AND status='running' AND updated_at<?`).run(at,this.scope,new Date(+now-15*60_000).toISOString());
      const job=this.db.prepare(`SELECT id,assistant_rowid,attempts,created_at FROM memory_jobs WHERE owner_scope=? AND status IN ('pending','retry')
        AND run_after<=? ORDER BY CASE WHEN assistant_rowid>? OR created_at>? THEN 0 ELSE 1 END,assistant_rowid,id LIMIT 1`).get(this.scope,at,bootstrap?.throughRowid??0,bootstrap?.startedAt??'0000') as unknown as Job|undefined;
      if(!job)return;
      const lease=randomUUID();this.db.prepare("UPDATE memory_jobs SET status='running',attempts=attempts+1,lease=?,updated_at=? WHERE id=?").run(lease,at,job.id);
      return {...job,lease,attempts:job.attempts+1};
    });
  }
  retry(job:Job,code:string,now=new Date()):number {
    const terminal=['NO_USER_TURN','SOURCE_CHANGED','INVALID_CLASSIFICATION','INVALID_JSON','TOPIC_INVALID','INVALID_MEMORY_OUTPUT','INVALID_REINFORCEMENT'].includes(code)&&job.attempts>=3;
    const delay=Math.min(6*60*60_000,60_000*2**Math.min(8,job.attempts-1));
    this.db.prepare(`UPDATE memory_jobs SET status=?,lease=NULL,error_code=?,run_after=?,updated_at=?
      WHERE id=? AND owner_scope=? AND lease=? AND status='running'`).run(terminal?'failed':'retry',code,new Date(+now+delay).toISOString(),now.toISOString(),job.id,this.scope,job.lease);
    return delay;
  }
  complete(job:Job,turn:Turn,revision:number,classification:Classification,now=new Date()):void {
    transaction(this.db,()=>{
      const current=this.db.prepare("SELECT 1 FROM memory_jobs WHERE id=? AND owner_scope=? AND status='running' AND lease=?").get(job.id,this.scope,job.lease);
      if(!current)throw new MemoryError('SOURCE_CHANGED');
      if(this.revision()!==revision)throw new MemoryError('TREE_CHANGED');
      if(this.collect(turn.assistant).fingerprint!==turn.fingerprint)throw new MemoryError('SOURCE_CHANGED');
      const at=now.toISOString(),eventAt=turn.sources.at(-1)!.at;
      if(!Number.isFinite(Date.parse(eventAt)))throw new MemoryError('SOURCE_CHANGED');
      const occurrence=decayedMass(1,eventAt,+now);
      if(classification.decision==='STORE') {
        const all=new Map(this.topics().map(t=>[t.id,t]));
        const ids=new Map<string,string>();
        const pending=[...classification.proposed_topics];
        if(pending.some(p=>all.has(p.client_temp_id)))throw new MemoryError('TOPIC_INVALID');
        while(pending.length) {
          const index=pending.findIndex(p=>p.parent_id===null||all.has(p.parent_id)||ids.has(p.parent_id));
          if(index<0)throw new MemoryError('TOPIC_INVALID');
          const [p]=pending.splice(index,1);const parent=p!.parent_id===null?null:ids.get(p!.parent_id)??p!.parent_id;
          const names=[p!.name,...p!.aliases].map(normalizeName);
          const duplicates=[...all.values()].filter(t=>t.parent_id===parent&&[t.name,...JSON.parse(t.aliases) as string[]].some(n=>names.includes(normalizeName(n))));
          if(duplicates.length>1)throw new MemoryError('TOPIC_INVALID');
          const existing=duplicates[0];
          if(existing){ids.set(p!.client_temp_id,existing.id);continue;}
          let depth=1,cursor=parent;
          while(cursor){if(++depth>6)throw new MemoryError('TOPIC_INVALID');cursor=all.get(cursor)?.parent_id??null;}
          const id=randomUUID();
          this.db.prepare(`INSERT INTO memory_topics(id,owner_scope,parent_id,name,normalized_name,description,aliases,mass_updated_at,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,this.scope,parent,p!.name.trim(),normalizeName(p!.name),p!.description,JSON.stringify(p!.aliases),at,at,at);
          all.set(id,{id,parent_id:parent,name:p!.name,description:p!.description,aliases:JSON.stringify(p!.aliases),occurrence_mass:0,mass_updated_at:at});ids.set(p!.client_temp_id,id);
        }
        const labels=classification.labels.map(l=>({...l,topic_id:ids.get(l.topic_id)??l.topic_id}));
        const roots=new Set<string>(),used=new Set<string>();
        for(const label of labels) {
          let topic=all.get(label.topic_id);if(!topic)throw new MemoryError('TOPIC_INVALID');
          used.add(topic.id);
          while(topic.parent_id){topic=all.get(topic.parent_id);if(!topic)throw new MemoryError('TOPIC_INVALID');used.add(topic.id);}
          if(roots.has(topic.id))throw new MemoryError('TOPIC_INVALID');roots.add(topic.id);
        }
        // Disallow unrelated model-created taxonomy: every new proposal must be on a selected path.
        if([...ids.values()].some(id=>!used.has(id)))throw new MemoryError('TOPIC_INVALID');
        const hints=classification.relation_hints.map(h=>({...h,a:ids.get(h.a)??h.a,b:ids.get(h.b)??h.b}));
        if(hints.some(h=>h.a===h.b||![h.a,h.b].every(id=>labels.some(l=>l.topic_id===id))))throw new MemoryError('TOPIC_INVALID');
        const id=randomUUID();
        this.db.prepare(`INSERT INTO memory_nodes(id,owner_scope,kind,conv_key,assistant_rowid,gist,importance,half_life_days,reinforced_at,token_estimate,created_at,updated_at)
          VALUES(?,?,'turn',?,?,?,?,?,?,?,?,?)`).run(id,this.scope,this.scope,turn.assistant,classification.gist!,classification.importance!,halfLife(classification.kind!,classification.importance!),eventAt,Math.ceil(turn.sources.reduce((n,s)=>n+s.content.length,0)/2),eventAt,at);
        for(const source of turn.sources)this.db.prepare('INSERT INTO memory_sources VALUES(?,?)').run(id,source.rowid);
        for(const label of labels) {
          this.db.prepare("INSERT INTO memory_topic_memberships(topic_id,node_id,score,created_at) VALUES(?,?,?,?)").run(label.topic_id,id,label.score,at);
          const t=all.get(label.topic_id)!,mass=decayedMass(t.occurrence_mass,t.mass_updated_at,+now)+occurrence;
          this.db.prepare('UPDATE memory_topics SET occurrence_mass=?,mass_updated_at=?,updated_at=? WHERE id=?').run(mass,at,at,t.id);
          t.occurrence_mass=mass;t.mass_updated_at=at;
        }
        if(labels.length===2){
          const [a,b]=labels.map(l=>l.topic_id).sort() as [string,string];
          const old=this.db.prepare('SELECT * FROM memory_topic_edges WHERE topic_a=? AND topic_b=?').get(a,b) as {pair_mass:number;evidence:number;updated_at:string}|undefined;
          const pair=old?decayedMass(old.pair_mass,old.updated_at,+now)+occurrence:occurrence;
          const hint=hints[0]?.strength??0;
          const evidence=old?old.evidence*0.8+hint*0.2:hint;
          const strength=Math.min(1,0.7*pair/Math.max(Number.MIN_VALUE,Math.sqrt(all.get(a)!.occurrence_mass*all.get(b)!.occurrence_mass))+0.3*evidence);
          this.db.prepare(`INSERT INTO memory_topic_edges VALUES(?,?,?,?,?,?) ON CONFLICT(topic_a,topic_b) DO UPDATE SET
            pair_mass=excluded.pair_mass,evidence=excluded.evidence,strength=excluded.strength,updated_at=excluded.updated_at`).run(a,b,pair,evidence,strength,at);
        }
        bumpMemoryRevision(this.db);
      }
      this.db.prepare('DELETE FROM memory_progress WHERE job_id=?').run(job.id);
      this.db.prepare("UPDATE memory_jobs SET status='done',lease=NULL,error_code=NULL,updated_at=? WHERE id=? AND lease=?").run(at,job.id,job.lease);
    });
  }
  finishEmpty(job:Job):void {
    transaction(this.db,()=>{
      if(!this.db.prepare("SELECT 1 FROM memory_jobs WHERE id=? AND owner_scope=? AND lease=? AND status='running'").get(job.id,this.scope,job.lease))throw new MemoryError('SOURCE_CHANGED');
      try {this.collect(job.assistant_rowid);throw new MemoryError('SOURCE_CHANGED');}
      catch(error){if(!(error instanceof MemoryError)||error.code!=='NO_USER_TURN')throw error;}
      this.db.prepare("UPDATE memory_jobs SET status='done',lease=NULL,error_code='NO_USER_TURN',updated_at=? WHERE id=? AND owner_scope=? AND status='running' AND lease=?").run(new Date().toISOString(),job.id,this.scope,job.lease);
      this.db.prepare('DELETE FROM memory_progress WHERE job_id=?').run(job.id);
    });
  }
  progress(job:Job,fingerprint:string):unknown {
    const row=this.db.prepare('SELECT payload FROM memory_progress WHERE job_id=? AND fingerprint=?').get(job.id,fingerprint);
    return row?JSON.parse(String(row.payload)):undefined;
  }
  saveProgress(job:Job,fingerprint:string,payload:unknown):void {
    transaction(this.db,()=>{
      const current=this.db.prepare("SELECT 1 FROM memory_jobs WHERE id=? AND owner_scope=? AND lease=? AND status='running'").get(job.id,this.scope,job.lease);
      if(!current||this.collect(job.assistant_rowid).fingerprint!==fingerprint)throw new MemoryError('SOURCE_CHANGED');
      this.db.prepare('INSERT INTO memory_progress VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET fingerprint=excluded.fingerprint,payload=excluded.payload').run(job.id,fingerprint,JSON.stringify(payload));
    });
  }
  yield(job:Job):void {
    this.db.prepare("UPDATE memory_jobs SET status='pending',lease=NULL,attempts=MAX(0,attempts-1),run_after=?,updated_at=? WHERE id=? AND lease=?").run(new Date().toISOString(),new Date().toISOString(),job.id,job.lease);
  }
  reinforce(turn:Turn,evidence:unknown,now=new Date()):number {
    if(!Array.isArray(evidence)||evidence.length>4)throw new MemoryError('INVALID_REINFORCEMENT');
    return transaction(this.db,()=>{
      if(this.collect(turn.assistant).fingerprint!==turn.fingerprint)throw new MemoryError('SOURCE_CHANGED');
      const current=new Map(turn.sources.map(s=>[s.rowid,s.content]));let changed=0;
      for(const e of evidence){
        if(!e||typeof e.node_id!=='string')throw new MemoryError('INVALID_REINFORCEMENT');
        const node=this.db.prepare("SELECT * FROM memory_nodes WHERE id=? AND owner_scope=? AND status='active'").get(e.node_id,this.scope);
        if(!node)throw new MemoryError('INVALID_REINFORCEMENT');
        const sources=this.db.prepare('SELECT m.rowid,m.content FROM memory_sources s JOIN messages m ON m.rowid=s.message_rowid WHERE s.node_id=? AND m.conv_key=?').all(e.node_id,this.scope) as {rowid:number;content:string}[];
        if(!validateEvidence(e,new Map(sources.filter(s=>!current.has(s.rowid)).map(s=>[s.rowid,s.content])))||!validateEvidence({source_id:e.turn_source_id,quote:e.turn_quote},current))throw new MemoryError('INVALID_REINFORCEMENT');
        if(+now-Date.parse(String(node.reinforced_at))<86_400_000)continue;
        const act=activation(Number(node.activation_base),String(node.reinforced_at),Number(node.half_life_days),+now);
        this.db.prepare('UPDATE memory_nodes SET activation_base=?,reinforced_at=?,revision=revision+1,updated_at=? WHERE id=?').run(Math.min(1,act+0.15),now.toISOString(),now.toISOString(),e.node_id);changed++;
        this.db.prepare('INSERT INTO memory_audit(id,owner_scope,kind,revision,payload,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),this.scope,'reinforce',this.revision()+1,JSON.stringify({node_id:e.node_id,source_id:e.source_id,turn_source_id:e.turn_source_id}),now.toISOString());
      }
      if(changed)bumpMemoryRevision(this.db);return changed;
    });
  }
  reinforcementInput(turn:Turn):unknown|undefined {
    const query=turn.sources.filter(s=>s.role==='user').map(s=>s.content).join(' ').slice(0,300);
    const candidates=this.search(query,0,4).filter(h=>h.score>=0.55).map(h=>({node_id:h.id,sources:this.db.prepare('SELECT m.rowid AS source_id,m.content FROM memory_sources s JOIN messages m ON m.rowid=s.message_rowid WHERE s.node_id=? ORDER BY m.seq DESC LIMIT 4').all(h.id).map(s=>({...s,content:String(s.content).slice(0,1600)}))}));
    return candidates.length?{candidates,turn:turn.sources.map(s=>({source_id:s.rowid,content:s.content.slice(0,3000)})).slice(-6)}:undefined;
  }
  resumeAfterModelChange(now=new Date()):void {
    this.db.prepare(`UPDATE memory_jobs SET run_after=?,error_code=NULL WHERE owner_scope=? AND status='retry'
      AND error_code IN ('CLASSIFIER_UNAVAILABLE','MODEL_UNAVAILABLE')`).run(now.toISOString(),this.scope);
    this.db.prepare("UPDATE memory_operations SET run_after=?,error_code=NULL WHERE owner_scope=? AND status='retry' AND error_code IN ('CLASSIFIER_UNAVAILABLE','MODEL_UNAVAILABLE')").run(now.toISOString(),this.scope);
  }
  stats():Record<string,number> {
    return Object.fromEntries((this.db.prepare('SELECT status,count(*) AS n FROM memory_jobs WHERE owner_scope=? GROUP BY status').all(this.scope) as {status:string;n:number}[]).map(r=>[r.status,r.n]));
  }
  context():import('../runtime/types.js').MemoryRuntimeContext {
    const rows=this.db.prepare(`SELECT n.id,n.gist,n.summary,n.importance,n.activation_base,n.reinforced_at,n.half_life_days,
      EXISTS(SELECT 1 FROM memory_recent_links r WHERE r.node_id=n.id) AS protected FROM memory_nodes n
      WHERE n.owner_scope=? AND n.status='active' AND EXISTS(SELECT 1 FROM memory_topic_memberships x WHERE x.node_id=n.id AND x.status='active')
      ORDER BY protected DESC,n.importance DESC,n.updated_at DESC LIMIT 200`).all(this.scope) as unknown as {id:string;gist:string;summary:string;importance:number;activation_base:number;reinforced_at:string;half_life_days:number;protected:number}[];
    const ranked=rows.map(n=>({...n,activation:n.protected?1:activation(n.activation_base,n.reinforced_at,n.half_life_days,Date.now())})).sort((a,b)=>b.protected-a.protected||(b.importance+b.activation)-(a.importance+a.activation));
    const memories:unknown[]=[];let bytes=0;
    for(const n of ranked){
      const item=n.protected?this.read([n.id],'gist')[0]:{id:n.id,gist:n.gist,activation:n.activation,...(n.activation>=0.35&&n.summary?{summary:n.summary.slice(0,n.activation>=0.7?1600:700)}:{})};
      const size=JSON.stringify(item).length;if(bytes+size>10_000)continue;memories.push(item);bytes+=size;if(memories.length>=32)break;
    }
    return {revision:this.revision(),ready:bootstrapStatus(this).ready,content:JSON.stringify({memories,notice:'有限的活跃记忆视图，原始对话未删除。来源、状态和不确定性以工具读取为准。'})};
  }
  search(query:string,depth=1,limit=8,now=new Date()):MemoryHit[] {
    if(typeof query!=='string'||!query.trim()||query.length>500||!Number.isInteger(depth)||depth<0||depth>2||!Number.isInteger(limit)||limit<1||limit>16)throw new MemoryError('INVALID_QUERY');
    const topics=this.topics(),byId=new Map(topics.map(t=>[t.id,t]));
    const paths=(id:string):string=>{const parts:string[]=[];let t=byId.get(id);while(t){parts.unshift(t.name);t=t.parent_id?byId.get(t.parent_id):undefined;}return parts.join('/');};
    const tokens=[...new Set([normalizeName(query),...query.split(/[\s，。！？、,!?]+/).map(normalizeName)].filter(x=>x.length>=1))].slice(0,12);
    const routing=new Map<string,number>();
    for(const t of topics)if(tokens.some(q=>[t.name,...JSON.parse(t.aliases)].some((n:string)=>normalizeName(n).includes(q)||q.includes(normalizeName(n)))))routing.set(t.id,1);
    // FTS trigram is fast for >=3 characters; short Chinese queries need a bounded LIKE path.
    const direct=new Map<string,number>();
    const escaped=query.replace(/[\\%_]/g,'\\$&');
    let rows:{id:string}[];
    if(Array.from(query.trim()).length>=3) {
      rows=this.db.prepare(`SELECT DISTINCT n.id FROM message_fts JOIN memory_sources s ON s.message_rowid=message_fts.rowid
        JOIN memory_nodes n ON n.id=s.node_id WHERE message_fts MATCH ? AND n.owner_scope=? AND n.status='active' LIMIT 100`).all('"'+query.replaceAll('"','""')+'"',this.scope) as {id:string}[];
    } else {
      rows=this.db.prepare(`SELECT DISTINCT n.id FROM messages m JOIN memory_sources s ON s.message_rowid=m.rowid JOIN memory_nodes n ON n.id=s.node_id
        WHERE n.owner_scope=? AND n.status='active' AND m.content LIKE ? ESCAPE '\\' LIMIT 100`).all(this.scope,'%'+escaped+'%') as {id:string}[];
    }
    for(const row of rows)direct.set(row.id,1);
    for(const r of this.db.prepare(`SELECT n.id FROM memory_recent_links r JOIN memory_nodes n ON n.id=r.node_id JOIN context c ON c.kind='recent' AND c.id=r.recent_id AND c.revision=r.recent_revision
      WHERE r.owner_scope=? AND n.status='active' AND c.body LIKE ? ESCAPE '\\' LIMIT 100`).all(this.scope,'%'+escaped+'%') as {id:string}[])direct.set(r.id,1);
    for(const row of this.db.prepare("SELECT id FROM memory_nodes WHERE owner_scope=? AND status='active' AND gist LIKE ? ESCAPE '\\' LIMIT 100").all(this.scope,'%'+escaped+'%') as {id:string}[])direct.set(row.id,1);
    if(!routing.size)for(const id of direct.keys())for(const row of this.db.prepare("SELECT topic_id FROM memory_topic_memberships WHERE node_id=? AND status='active'").all(id) as {topic_id:string}[])routing.set(row.topic_id,Math.max(routing.get(row.topic_id)??0,0.9));
    // Bounded tree paths + up to two lateral hops; generic hubs receive a degree penalty.
    for(let hop=0;hop<depth;hop++) {
      const frontier=[...routing.entries()].sort((a,b)=>b[1]-a[1]).slice(0,24);
      for(const [id,score] of frontier) {
        const adjacent=this.db.prepare(`SELECT CASE WHEN topic_a=? THEN topic_b ELSE topic_a END AS id,strength FROM memory_topic_edges
          WHERE topic_a=? OR topic_b=? ORDER BY strength DESC LIMIT 16`).all(id,id,id) as {id:string;strength:number}[];
        const degree=Number(this.db.prepare('SELECT count(*) AS n FROM memory_topic_edges WHERE topic_a=? OR topic_b=?').get(id,id)!.n);
        for(const e of adjacent){if(!byId.has(e.id))continue;const s=score*e.strength*0.7/Math.sqrt(Math.max(1,degree/4));if(s>=0.1)routing.set(e.id,Math.max(s,routing.get(e.id)??0));}
        const parent=byId.get(id)?.parent_id;
        for(const t of topics.filter(t=>t.parent_id===id||t.id===parent).slice(0,16)){const s=score*0.6;routing.set(t.id,Math.max(s,routing.get(t.id)??0));}
      }
    }
    const candidates=new Set(direct.keys());
    for(const [topic] of [...routing].sort((a,b)=>b[1]-a[1]).slice(0,32))for(const r of this.db.prepare(`SELECT n.id FROM memory_topic_memberships x JOIN memory_nodes n ON n.id=x.node_id
      WHERE x.topic_id=? AND x.status='active' AND n.status='active' AND n.owner_scope=? ORDER BY n.importance DESC,n.created_at DESC LIMIT 32`).all(topic,this.scope) as {id:string}[])candidates.add(r.id);
    const activityCache=new Map<string,number>();
    const topicActivity=(topic:string)=>{
      if(activityCache.has(topic))return activityCache.get(topic)!;
      const material=this.db.prepare(`SELECT n.activation_base,n.reinforced_at,n.half_life_days FROM memory_topic_memberships x JOIN memory_nodes n ON n.id=x.node_id
        WHERE x.topic_id=? AND x.status='active' AND n.status='active' ORDER BY n.importance DESC,n.updated_at DESC LIMIT 32`).all(topic) as {activation_base:number;reinforced_at:string;half_life_days:number}[];
      const top=material.map(n=>activation(n.activation_base,n.reinforced_at,n.half_life_days,+now)).sort((a,b)=>b-a).slice(0,8);
      const value=top.length?top.reduce((a,b)=>a+b,0)/top.length:0;activityCache.set(topic,value);return value;
    };
    const hits:MemoryHit[]=[];
    for(const id of candidates) {
      const n=this.db.prepare("SELECT * FROM memory_nodes WHERE id=? AND owner_scope=? AND status='active'").get(id,this.scope) as unknown as {gist:string;importance:number;activation_base:number;reinforced_at:string;half_life_days:number;created_at:string}|undefined;
      if(!n)continue;
      const memberships=this.db.prepare("SELECT topic_id,score FROM memory_topic_memberships WHERE node_id=? AND status='active'").all(id) as {topic_id:string;score:number}[];
      if(!memberships.length)continue;
      const path=Math.max(0,...memberships.map(m=>(routing.get(m.topic_id)??0)*m.score*(0.8+0.2*topicActivity(m.topic_id))));
      const act=activation(n.activation_base,n.reinforced_at,n.half_life_days,+now);
      const recency=2**(-Math.max(0,+now-Date.parse(n.created_at))/(30*86_400_000));
      const match=direct.get(id)??(memberships.some(m=>(routing.get(m.topic_id)??0)>=0.99)?1:0);
      hits.push({id,gist:n.gist,importance:n.importance,activation:act,score:0.45*match+0.2*path+0.15*n.importance+0.1*act+0.1*recency,paths:memberships.map(m=>paths(m.topic_id))});
    }
    for(const hit of hits){const r=this.db.prepare("SELECT c.body FROM memory_recent_links l JOIN context c ON c.kind='recent' AND c.id=l.recent_id AND c.revision=l.recent_revision WHERE l.node_id=?").get(hit.id);if(r){hit.gist=String(r.body).slice(0,200);hit.activation=1;}}
    return hits.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,limit);
  }
  read(ids:string[],detail:'auto'|'gist'|'summary'|'detail'='auto'):unknown[] {
    if(!Array.isArray(ids)||!ids.length||ids.length>8||ids.some(x=>typeof x!=='string'||x.length>100)||!['auto','gist','summary','detail'].includes(detail))throw new MemoryError('INVALID_QUERY');
    return ids.map(id=>{
      const node=this.db.prepare("SELECT id,kind,gist,summary,detail,activation_base,reinforced_at,half_life_days FROM memory_nodes WHERE id=? AND owner_scope=? AND status='active'").get(id,this.scope);
      if(!node)throw new MemoryError('MEMORY_NOT_FOUND');
      const act=activation(Number(node.activation_base),String(node.reinforced_at),Number(node.half_life_days),Date.now());
      const level=detail==='auto'?(act>=0.65?'detail':act>=0.25?'summary':'gist'):detail;
      const recent=this.db.prepare("SELECT c.id,c.body,c.conversation_state,c.revision FROM memory_recent_links r JOIN context c ON c.kind='recent' AND c.id=r.recent_id AND c.revision=r.recent_revision WHERE r.node_id=? AND r.owner_scope=?").get(id,this.scope);
      if(recent)return {id,kind:'recent',protected:recent.conversation_state!=='Done',recent_id:recent.id,state:recent.conversation_state,revision:recent.revision,body:String(recent.body).slice(0,level==='detail'?6000:level==='summary'?1600:200)};
      if(level==='gist')return {id,gist:node.gist};
      const sources=this.db.prepare(`SELECT m.rowid AS source_id,m.seq AS history_index,m.role,m.at,m.content FROM memory_sources s JOIN messages m ON m.rowid=s.message_rowid
        WHERE s.node_id=? AND m.conv_key=? ORDER BY m.seq`).all(id,this.scope) as {history_index:number;role:string;at:string;content:string}[];
      let remaining=level==='detail'?4000:1000;
      return {id,kind:node.kind,gist:node.gist,summary:node.summary,...(level==='detail'&&node.detail?{detail:JSON.parse(String(node.detail))}:{}),detail_level:level,notice:node.kind==='rollup'?'融合摘要含来源与不确定性；内容足以回答时自然回应。核对原话、准确时间、冲突或补足缺漏时可回查原文，未显示全文不表示不存在。':'线索未经事实提炼；以下为原始历史节选，足以回答时无需重复查原文。核对原话、准确时间、冲突或补足缺漏时，可用 gateway_read_history 的 index 读取完整原文。',sources:sources.map(s=>{
        const content=s.content.slice(0,Math.max(0,remaining));remaining-=content.length;
        return {...s,content,truncated:content.length<s.content.length};
      }).slice(0,24)};
    });
  }
}

