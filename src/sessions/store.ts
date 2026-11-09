import { MemoryStore } from "../memory/store.js";
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import type { ChannelName, InboundMessageReference, PlatformMessageFragment, TelegramSticker } from '../channels/types.js';
import type { RuntimeHistory, RuntimeHistoryEntry } from '../runtime/types.js';
import { writeJsonAtomic } from '../util/atomic-json.js';
import { SerialQueue } from '../util/serial-queue.js';
import { centralEnabled, pathRoots, references, schemaVersion, getState, putState } from '../state/database.js';
import { replyState, validateMessage, type SessionMessage, type SessionRecord, type SessionMetadata, type SessionAppendResult } from './types.js';
export type { SessionMessage, SessionRecord, SessionAppendResult } from './types.js';
export { normalizeSessionMessage } from './types.js';

export interface SessionView { tail: SessionMessage[]; lastUser?: SessionMessage; lastAssistant?: SessionMessage; unansweredCount: number; unansweredStart?: number; history: RuntimeHistory }
type Conv = { key: string; channel: ChannelName; conversation_id: string; sender_id: string; updated_at: string; count: number; last_user: number|null; last_assistant: number|null; last_reply: number|null; unanswered_users: number };
type Msg = { seq: number; msg_id: string|null; role: 'user'|'assistant'; content: string; at: string; attachments: string|null; origin: 'chat'|'proactive'|null; partial: number|null; source:string|null; source_channel?:ChannelName|null };
export interface TelegramReactionEntry { sticker: TelegramSticker; note?: string; seenAt: string }
const REACTION_CATALOG_KEY = 'runtime/telegram-reactions.json';
const REACTION_BACKFILL_KEY = 'runtime/telegram-reactions-backfill-v1';
const key = (channel: ChannelName, id: string) => channel + ':' + id;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function cursor(n: number) { if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid history cursor.'); }
function instant(s?: string) { if (s === undefined) return undefined; const n = Date.parse(s); if (!Number.isFinite(n)) throw new Error('Invalid date filter.'); return n; }

/** Revision of the exact decoded record shown by the control center. */
export function messageRevision(message: SessionMessage): string { return hash(JSON.stringify(message)); }

/** SQLite is the only active session store. */
export class SessionStore {
  private readonly ops = new SerialQueue();
  private memory?: MemoryStore;
  enableMemory(ownerId:string): MemoryStore {
    return this.memory ??= new MemoryStore(this.db, 'telegram:'+ownerId);
  }
  private readonly db: DatabaseSync;
  private readonly dir: string;
  private readonly roots: string[];
  private readonly central: boolean;
  private readonly version: 0|1|2;
  constructor(private readonly rootDir: string) {
    this.roots=pathRoots(rootDir);this.central=centralEnabled(rootDir);
    this.dir = join(rootDir,'sessions'); mkdirSync(this.dir,{recursive:true});
    this.db = new DatabaseSync(join(this.dir,'gateway.sqlite'));
    this.version=schemaVersion(this.db);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    if(this.version!==2) {
      this.db.exec([
      'CREATE TABLE IF NOT EXISTS conversations (key TEXT PRIMARY KEY,channel TEXT NOT NULL,conversation_id TEXT NOT NULL,sender_id TEXT NOT NULL,updated_at TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,last_user INTEGER,last_assistant INTEGER,last_reply INTEGER,unanswered_users INTEGER NOT NULL DEFAULT 0,UNIQUE(channel,conversation_id))',
      "CREATE TABLE IF NOT EXISTS messages (rowid INTEGER PRIMARY KEY,conv_key TEXT NOT NULL REFERENCES conversations(key),seq INTEGER NOT NULL,msg_id TEXT,role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,at TEXT NOT NULL,at_ms INTEGER NOT NULL,attachments TEXT,origin TEXT CHECK(origin IN ('chat','proactive')),partial INTEGER CHECK(partial IN (0,1)),UNIQUE(conv_key,seq),UNIQUE(conv_key,msg_id))",
      'CREATE TABLE IF NOT EXISTS owner_session_routes (route TEXT PRIMARY KEY,target TEXT NOT NULL,owner TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS messages_by_time ON messages(conv_key,at_ms,seq)',
      "CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(content,content='messages',content_rowid='rowid',tokenize='trigram')",
      'CREATE TRIGGER IF NOT EXISTS message_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO message_fts(rowid,content) VALUES(new.rowid,new.content); END',
      "CREATE TRIGGER IF NOT EXISTS message_fts_ad AFTER DELETE ON messages BEGIN INSERT INTO message_fts(message_fts,rowid,content) VALUES('delete',old.rowid,old.content); END",
      "CREATE TRIGGER IF NOT EXISTS message_fts_au AFTER UPDATE OF content ON messages BEGIN INSERT INTO message_fts(message_fts,rowid,content) VALUES('delete',old.rowid,old.content); INSERT INTO message_fts(rowid,content) VALUES(new.rowid,new.content); END",
    ].join(';')+';');
      const columns=this.db.prepare('PRAGMA table_info(messages)').all() as {name:string}[];
      if(!columns.some(c=>c.name==='source'))this.db.exec('ALTER TABLE messages ADD COLUMN source TEXT');
    }
  }
  /** Only schema v2 has a durable iLink journal that can retry transcript settlement. */
  supportsDurableIlinkDelivery():boolean {return this.version===2;}
  /** Logical owner conversation, anchored to the existing TG key to preserve checkpoints. */
  sessionKey(channel:ChannelName,id:string):string {
    const route=key(channel,id);
    return this.routes().find(row=>row.route===route)?.target??route;
  }
  bindOwnerSession(telegramOwner:string,wechatOwner:string):Promise<void> {
    return this.ops.run(async()=>this.tx(()=>{
      if(!/^\d+$/.test(telegramOwner)||!wechatOwner)throw new Error('Invalid owner binding.');
      const target=key('telegram',telegramOwner),route=key('wechat',wechatOwner);
      const routes=this.routes();
      if(routes.some(existing=>existing.target!==target||existing.owner!==telegramOwner))throw new Error('Owner identity changed; explicit offline migration required.');
      const old=this.db.prepare('SELECT count FROM conversations WHERE key=?').get(route) as {count:number}|undefined;
      if(old?.count)throw new Error('Existing WeChat history retained; offline review required before binding.');
      const tg=this.db.prepare('SELECT sender_id FROM conversations WHERE key=?').get(target) as {sender_id:string}|undefined;
      if(tg&&tg.sender_id!==telegramOwner)throw new Error('TG session owner mismatch; binding refused.');
      // No transcript or checkpoint is copied, renamed, deleted or concatenated.
      if(this.version===2)putState(this.db,{key:'sessions/owner_routes',category:'runtime',value:JSON.stringify([{route:target,target,owner:telegramOwner},{route,target,owner:telegramOwner}])});
      else {
        this.db.prepare('DELETE FROM owner_session_routes WHERE route LIKE ?').run('wechat:%');
        this.db.prepare('INSERT OR REPLACE INTO owner_session_routes VALUES(?,?,?)').run(target,target,telegramOwner);
        this.db.prepare('INSERT INTO owner_session_routes VALUES(?,?,?)').run(route,target,telegramOwner);
      }
    }));
  }
  prepare(): Promise<void> { return this.ops.run(async () => {
    const rows=this.db.prepare('PRAGMA quick_check').all() as {quick_check:string}[];
    if(rows.some(row=>row.quick_check!=='ok'))throw new Error('SQLite quick_check failed.');
  }); }
  close() { this.db.close(); }
  supportsTelegramReactionNotes():boolean { return this.version !== 0; }
  private reactionCatalog(): TelegramReactionEntry[] {
    if (!this.version) return [];
    const row=getState(this.db,REACTION_CATALOG_KEY);
    if (!row) return [];
    let value:unknown;
    try { value=JSON.parse(row.value); } catch { throw new Error('Telegram 表情包目录损坏；不会覆盖原记录。'); }
    if (!Array.isArray(value) || value.some(item=>!item || typeof item!=='object' ||
      typeof item.seenAt!=='string' || !item.sticker || typeof item.sticker.fileId!=='string' ||
      typeof item.sticker.accountId!=='string' || typeof item.sticker.chatId!=='string' ||
      (item.note!==undefined && typeof item.note!=='string')))
      throw new Error('Telegram 表情包目录格式无效；不会覆盖原记录。');
    return value as TelegramReactionEntry[];
  }
  /** Import only real inbound Telegram sticker metadata already saved in message history. */
  private reactionCatalogWithHistory(): TelegramReactionEntry[] {
    const entries=this.reactionCatalog();
    if (!this.version || getState(this.db,REACTION_BACKFILL_KEY)) return entries;
    const known=new Map(entries.map(entry=>[
      entry.sticker.accountId+'\0'+entry.sticker.chatId+'\0'+entry.sticker.fileId,entry]));
    const rows=this.db.prepare("SELECT source,at FROM messages WHERE conv_key LIKE 'telegram:%' AND source LIKE '%\"sticker\"%' ORDER BY at_ms")
      .all() as {source:string;at:string}[];
    for (const row of rows) {
      let source:unknown;
      try { source=JSON.parse(row.source); } catch { continue; }
      if (!source || typeof source!=='object') continue;
      const fragments=(source as {platformMessages?:unknown}).platformMessages;
      if (!Array.isArray(fragments)) continue;
      for (const fragment of fragments) {
        if (!fragment || typeof fragment!=='object' || fragment.direction!=='inbound' ||
          typeof fragment.accountId!=='string' || typeof fragment.conversationId!=='string' || !Array.isArray(fragment.attachments)) continue;
        for (const attachment of fragment.attachments) {
          const sticker=attachment?.sticker as TelegramSticker|undefined;
          if (!sticker || !/^telegram-bot:[1-9][0-9]*$/.test(sticker.accountId) ||
            sticker.accountId!==fragment.accountId || sticker.chatId!==fragment.conversationId ||
            !/^[A-Za-z0-9_-]{1,512}$/.test(sticker.fileId) ||
            !['static','animated','video','gif','gif_document','mp4_document','image'].includes(sticker.format)) continue;
          const key=sticker.accountId+'\0'+sticker.chatId+'\0'+sticker.fileId;
          const existing=known.get(key);
          if (existing) { if (row.at>existing.seenAt) existing.seenAt=row.at; }
          else known.set(key,{sticker,seenAt:row.at});
        }
      }
    }
    const merged=[...known.values()];
    const annotated=merged.filter(entry=>entry.note);
    const unannotated=merged.filter(entry=>!entry.note).sort((a,b)=>b.seenAt.localeCompare(a.seenAt)).slice(0,1000);
    const result=[...annotated,...unannotated];
    putState(this.db,{key:REACTION_CATALOG_KEY,value:JSON.stringify(result)});
    putState(this.db,{key:REACTION_BACKFILL_KEY,value:'true'});
    return result;
  }
  /** Store only source identifiers and descriptions; original media remains in the media cache. */
  rememberTelegramReactions(stickers:TelegramSticker[], seenAt:string):Promise<void> {
    if (!this.version || !stickers.length) return Promise.resolve();
    return this.ops.run(async()=>this.tx(()=>{
      const entries=this.reactionCatalogWithHistory();
      for (const sticker of stickers) {
        const existing=entries.find(entry=>entry.sticker.accountId===sticker.accountId &&
          entry.sticker.chatId===sticker.chatId && entry.sticker.fileId===sticker.fileId);
        if (existing) { existing.sticker=sticker; existing.seenAt=seenAt; }
        else entries.push({sticker,seenAt});
      }
      // Preserve all annotated entries; bound only unannotated inventory growth.
      const annotated=entries.filter(entry=>entry.note);
      const unannotated=entries.filter(entry=>!entry.note).sort((a,b)=>b.seenAt.localeCompare(a.seenAt)).slice(0,1000);
      putState(this.db,{key:REACTION_CATALOG_KEY,value:JSON.stringify([...annotated,...unannotated])});
    }));
  }
  listTelegramReactions(accountId:string,chatId:string,query?:string,limit=50):Promise<TelegramReactionEntry[]> {
    return this.ops.run(async()=>this.tx(()=>this.reactionCatalogWithHistory())
      .filter(entry=>entry.sticker.accountId===accountId && entry.sticker.chatId===chatId)
      .filter(entry=>!query || [entry.note,entry.sticker.emoji,entry.sticker.setName,entry.sticker.format]
        .some(value=>value?.toLowerCase().includes(query.toLowerCase())))
      .sort((a,b)=>b.seenAt.localeCompare(a.seenAt)).slice(0,limit));
  }
  setTelegramReactionNote(accountId:string,chatId:string,fileId:string,note:string):Promise<TelegramReactionEntry> {
    if (!this.version) return Promise.reject(new Error('当前主库尚未迁移，无法保存表情包备注。'));
    const cleaned=note.trim();
    if (!cleaned || cleaned.length>280) return Promise.reject(new Error('备注须为 1 至 280 个字符。'));
    return this.ops.run(async()=>{
      const chosen=this.tx(()=>{
        const entries=this.reactionCatalogWithHistory();
        const entry=entries.find(item=>item.sticker.accountId===accountId && item.sticker.chatId===chatId && item.sticker.fileId===fileId);
        if (!entry) throw new Error('只能给当前私聊真实收到并已登记的表情包写备注。');
        entry.note=cleaned;
        putState(this.db,{key:REACTION_CATALOG_KEY,value:JSON.stringify(entries)});
        return entry;
      });
      const verified=this.reactionCatalog().find(item=>item.sticker.accountId===accountId && item.sticker.chatId===chatId && item.sticker.fileId===fileId);
      if (verified?.note!==cleaned) throw new Error('表情包备注写入后校验失败。');
      return chosen;
    });
  }
  private tx<T>(body: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = body(); this.db.exec('COMMIT'); return result; } catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* original failure wins */ } throw e; } }
  private routes():{route:string;target:string;owner:string}[] {
    if(this.version!==2)return this.db.prepare('SELECT route,target,owner FROM owner_session_routes').all() as {route:string;target:string;owner:string}[];
    const row=getState(this.db,'sessions/owner_routes');
    if(!row)return [];
    if(row.encoding!=='json')throw new Error('Owner route encoding invalid.');
    const routes:unknown=JSON.parse(row.value);
    if(!Array.isArray(routes)||routes.some(r=>!r||typeof r.route!=='string'||typeof r.target!=='string'||typeof r.owner!=='string'||!/^\d+$/.test(r.owner)||r.target!=='telegram:'+r.owner||!(r.route===r.target||r.route.startsWith('wechat:')&&r.route.length>7))||new Set(routes.map(r=>r.route)).size!==routes.length)throw new Error('Owner routes invalid; binding refused.');
    return routes;
  }
  private source(row:Msg):SessionMessage['source'] {
    const value=row.source?references(JSON.parse(row.source),this.rootDir,'load',this.roots):undefined;
    if(this.version!==2)return value;
    if(!value&&!row.source_channel)return undefined;
    const {channel:legacyChannel,...rest}=value??{};
    return row.source_channel ? {...rest,channel:row.source_channel} : rest;
  }
  private conv(channel:ChannelName,id:string) { return this.db.prepare('SELECT * FROM conversations WHERE key=?').get(this.sessionKey(channel,id)) as Conv|undefined; }
  private meta(row:Conv):SessionMetadata { return {channel:row.channel,conversationId:row.conversation_id,senderId:row.sender_id,updatedAt:row.updated_at}; }
  private decode(row:Msg):SessionMessage { const source=this.source(row);return {role:row.role,content:row.content,at:row.at,...(source?{source}:{}),...(row.msg_id!==null?{id:row.msg_id}:{}),...(row.origin!==null?{origin:row.origin}:{}),...(row.partial!==null?{partial:row.partial===1}:{}),...(row.attachments!==null?{attachments:references(JSON.parse(row.attachments),this.rootDir,'load',this.roots) as SessionMessage['attachments']}:{})}; }
  private range(channel:ChannelName,id:string,start:number,limit:number,before?:number):SessionMessage[] {
    cursor(start);cursor(limit); const count=before??this.conv(channel,id)?.count??0;
    if (!limit || start>=count) return [];
    const expected=Math.min(limit,count-start);
    const rows=this.db.prepare('SELECT seq,msg_id,role,content,at,attachments,origin,partial,source'+(this.version===2?',source_channel':'')+' FROM messages WHERE conv_key=? AND seq>=? AND seq<? ORDER BY seq LIMIT ?')
      .all(this.sessionKey(channel,id),start,count,expected) as Msg[];
    if(rows.length!==expected||rows.some((r,i)=>r.seq!==start+i))throw new Error('SQLite transcript sequence gap; refusing incomplete history.');
    return rows.map(r=>this.decode(r));
  }
  private add(channel:ChannelName,id:string,sender:string,messages:SessionMessage[],updatedAt?:string) {
    const k=this.sessionKey(channel,id); let row=this.conv(channel,id);
    const binding=this.routes().find(row=>row.route===key(channel,id));
    if(binding&&sender!==id)throw new Error('Bound session sender mismatch.');
    if(binding) { channel='telegram'; id=binding.owner; sender=binding.owner; }
    if(!row) {const at=updatedAt??messages.at(-1)?.at??new Date().toISOString();this.db.prepare('INSERT INTO conversations(key,channel,conversation_id,sender_id,updated_at) VALUES(?,?,?,?,?)').run(k,channel,id,sender,at);row=this.conv(channel,id)!;}
    let count=row.count,lastUser=row.last_user,lastAssistant=row.last_assistant,lastReply=row.last_reply,unanswered=row.unanswered_users,lastAt=row.updated_at;
    const seen=new Set<string>(),fresh:SessionMessage[]=[];
    const insert=this.db.prepare('INSERT INTO messages(conv_key,seq,msg_id,role,content,at,at_ms,attachments,origin,partial,source'+(this.version===2?',source_channel':'')+') VALUES(?,?,?,?,?,?,?,?,?,?,?'+(this.version===2?',?':'')+')');
    const exists=this.db.prepare('SELECT 1 FROM messages WHERE conv_key=? AND msg_id=?');
    for(const value of messages) {
      const m=validateMessage(value);
      if(m.id) {if(seen.has(m.id))continue;seen.add(m.id);if(exists.get(k,m.id)||this.deletedIds().includes(hash(k+'\0'+m.id)))continue;}
      const inserted=insert.run(k,count,m.id??null,m.role,m.content,m.at,Date.parse(m.at),m.attachments===undefined?null:JSON.stringify(this.central?references(m.attachments,this.rootDir,'store',this.roots):m.attachments),m.origin??null,m.partial===undefined?null:m.partial?1:0,m.source?JSON.stringify(this.central?references(this.version===2?(({channel:_,...source})=>source)(m.source):m.source,this.rootDir,'store',this.roots):m.source):null,...(this.version===2?[m.source?.channel??null]:[]));
      if(this.memory && k===this.memory.scope && sender===id && m.role==='assistant' && m.origin==='chat' && m.partial===false) this.memory.enqueue(Number(inserted.lastInsertRowid));
      if(m.role==='user'){lastUser=count;unanswered++;}
      else{lastAssistant=count;if(replyState([m]).lastReply!==undefined){lastReply=count;unanswered=0;}}
      count++;lastAt=m.at;fresh.push(m);
    }
    this.db.prepare('UPDATE conversations SET sender_id=?,updated_at=?,count=?,last_user=?,last_assistant=?,last_reply=?,unanswered_users=? WHERE key=?').run(sender,updatedAt??lastAt,count,lastUser,lastAssistant,lastReply,unanswered,k);
    return fresh;
  }
  append(channel:ChannelName,id:string,senderId:string,messages:SessionMessage[]):Promise<SessionAppendResult> {
    return this.ops.run(async()=>{messages.forEach(validateMessage);
      const committed=this.tx(()=>this.add(channel,id,senderId,messages)),row=this.conv(channel,id)!;
      return {...this.meta(row),count:row.count,committed};});
  }
  private deletedIds(): string[] {
    if(this.version!==2)return [];
    const row=getState(this.db,'sessions/deleted_messages');
    if(!row)return [];
    const value:unknown=JSON.parse(row.value);
    if(row.encoding!=='json'||!Array.isArray(value)||value.some(x=>typeof x!=='string'||!/^[a-f0-9]{64}$/.test(x)))throw Error('Invalid deleted message guards.');
    return value;
  }
  /** Physical row deletion. Stable dedup hashes live outside the transcript. */
  deleteMessage(channel:ChannelName,id:string,index:number,expectedRevision:string):Promise<'deleted'|'conflict'|'missing'> {
    return this.ops.run(async()=>this.tx(()=>{
      cursor(index);
      if(this.version!==2)throw Error('History deletion requires schema v2.');
      const message=this.range(channel,id,index,1)[0];
      if(!message)return 'missing';
      if(messageRevision(message)!==expectedRevision)return 'conflict';
      const k=this.sessionKey(channel,id),oldCount=this.conv(channel,id)!.count;
      if(message.id)putState(this.db,{key:'sessions/deleted_messages',category:'metadata',value:JSON.stringify([...new Set([...this.deletedIds(),hash(k+'\0'+message.id)])])});
      // Adjust coverage metadata only; encrypted compaction and contextItems
      // remain byte-for-byte intact. This commits atomically with row renumbering.
      for(const row of this.db.prepare("SELECT key,value FROM gateway_state WHERE key LIKE 'runtime/context/%.json'").all() as {key:string;value:string}[]) {
        const saved=JSON.parse(row.value);
        const laneId=saved.sessionId;
        if(!(laneId===k || typeof laneId==='string'&&laneId.startsWith(k+':provider:') || !laneId&&row.key==='runtime/context/'+hash(k)+'.json'))continue;
        if(saved.pendingDeliveryItems || saved.pendingDeliveryId)throw Error('Pending context delivery prevents history edit.');
        for(const field of ['historyCursor','attachmentCursor'])if(typeof saved[field]==='number'&&saved[field]>index)saved[field]--;
        if(saved.checkpoint?.coveredThroughSeq>index)saved.checkpoint.coveredThroughSeq--;
        if(saved.checkpoint?.replayFromSeq>index)saved.checkpoint.replayFromSeq--;
        saved.historyRebuildPending=true;
        putState(this.db,{key:row.key,category:'runtime',value:JSON.stringify(saved)});
      }
      this.db.prepare('DELETE FROM messages WHERE conv_key=? AND seq=?').run(k,index);
      // Move into a disjoint positive range first, avoiding UNIQUE(seq) collisions.
      this.db.prepare('UPDATE messages SET seq=seq+? WHERE conv_key=? AND seq>?').run(oldCount,k,index);
      this.db.prepare('UPDATE messages SET seq=seq-? WHERE conv_key=? AND seq>=?').run(oldCount+1,k,oldCount);
      this.db.prepare('UPDATE conversations SET count=count-1,recent_review_through_seq=CASE WHEN recent_review_through_seq>=? THEN recent_review_through_seq-1 ELSE recent_review_through_seq END WHERE key=?').run(index,k);
      const remaining=this.range(channel,id,0,oldCount-1),state=replyState(remaining),roles=remaining.map(m=>m.role);
      const user=roles.lastIndexOf('user'),assistant=roles.lastIndexOf('assistant');
      this.db.prepare('UPDATE conversations SET last_user=?,last_assistant=?,last_reply=?,unanswered_users=? WHERE key=?')
        .run(user<0?null:user,assistant<0?null:assistant,state.lastReply??null,state.unansweredUsers??0,k);
      return 'deleted';
    }));
  }
  get(channel:ChannelName,id:string):Promise<SessionRecord|undefined> {return this.ops.run(async()=>{const row=this.conv(channel,id);return row?{...this.meta(row),messages:this.range(channel,id,0,row.count)}:undefined;});}
  readRange(channel:ChannelName,id:string,offset:number,limit=128):Promise<SessionMessage[]> {return this.ops.run(async()=>this.range(channel,id,offset,limit));}
  readTail(channel:ChannelName,id:string,limit=6):Promise<SessionMessage[]> {return this.ops.run(async()=>{cursor(limit);const n=this.conv(channel,id)?.count??0;return this.range(channel,id,Math.max(0,n-limit),limit);});}
  /** JSON fragments retain one-to-many batches; the conversation/channel index bounds the lookup. */
  findPlatformMessage(channel:ChannelName,id:string,accountId:string,messageId:string):Promise<InboundMessageReference|undefined> {
    return this.ops.run(async()=>{
      if(!accountId||!messageId)return undefined;
      const rows=this.db.prepare("SELECT fragment.value AS value FROM messages m,json_each(CASE WHEN json_valid(m.source) THEN m.source ELSE '{}' END,'$.platformMessages') fragment WHERE m.conv_key=? AND "+
        (this.version===2?"m.source_channel":"json_extract(m.source,'$.channel')")+"=? AND json_extract(fragment.value,'$.accountId')=? AND json_extract(fragment.value,'$.conversationId')=? AND json_extract(fragment.value,'$.messageId')=? LIMIT 2")
        .all(this.sessionKey(channel,id),channel,accountId,id,messageId) as {value:string}[];
      if(rows.length!==1)return undefined; // Unknown or ambiguous direction is never guessed.
      const fragment=references(JSON.parse(rows[0]!.value),this.rootDir,'load',this.roots) as PlatformMessageFragment;
      const attachments=fragment.attachments?.map(attachment=>{
        if(!attachment.localPath)return attachment;
        try {
          const path=realpathSync(attachment.localPath),media=realpathSync(join(this.rootDir,'media'));
          const rel=relative(media,path);
          if(!existsSync(path)||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error();
          return {...attachment,localPath:path};
        }catch{const {localPath,...rest}=attachment;return {...rest,error:'引用附件已过期或不可访问。'};}
      });
      return {messageId,sender:fragment.direction==='outbound'?'assistant':'user',text:fragment.text,...(attachments?.length?{attachments}:{})};
    });
  }
  private search(channel:ChannelName,id:string,snapshot:number,query:string,offset:number,limit:number,before=snapshot,dates:{from?:string;to?:string}={}) {
    cursor(offset);cursor(limit);cursor(before);
    if(query.length>256)throw new Error('History search query exceeds 256 characters.');
    const from=instant(dates.from),to=instant(dates.to);if(from!==undefined&&to!==undefined&&from>to)throw new Error('Invalid history date interval.');
    const conditions=['m.conv_key=?','m.seq<?'],args:(number|string)[]=[this.sessionKey(channel,id),Math.min(snapshot,before)];
    if(from!==undefined){conditions.push('m.at_ms>=?');args.push(from);}
    if(to!==undefined){conditions.push('m.at_ms<=?');args.push(to);}
    let fts='';
    if([...query].length>=3){fts=' JOIN message_fts ON message_fts.rowid=m.rowid ';conditions.push('message_fts MATCH ?');args.push('"'+query.replaceAll('"','""')+'"');}
    if(query){conditions.push('instr(lower(m.content),lower(?))>0');args.push(query);}
    const where=fts+' WHERE '+conditions.join(' AND ');
    const total=(this.db.prepare('SELECT count(*) AS n FROM messages m'+where).get(...args) as {n:number}).n;
    const rows=this.db.prepare('SELECT m.seq,m.msg_id,m.role,m.content,m.at,m.attachments,m.origin,m.partial,m.source'+(this.version===2?',m.source_channel':'')+' FROM messages m'+where+' ORDER BY m.seq LIMIT ? OFFSET ?').all(...args,limit,offset) as Msg[];
    const entries:RuntimeHistoryEntry[]=rows.map(r=>({index:r.seq,role:r.role,content:r.content,at:r.at,...(r.msg_id?{id:r.msg_id}:{})}));
    return {total,entries,nextOffset:offset+limit<total?offset+limit:null};
  }
  view(channel:ChannelName,id:string):Promise<SessionView>{return this.ops.run(async()=>{
    const row=this.conv(channel,id),n=row?.count??0;
    const history:RuntimeHistory={count:n,
      readTail:limit=>{cursor(limit);return this.readRange(channel,id,Math.max(0,n-limit),Math.min(limit,n));},
      readRange:(start,limit)=>{cursor(start);cursor(limit);return this.readRange(channel,id,start,Math.min(limit,Math.max(0,n-start)));},
      search:(q,offset,limit,before,dates)=>this.ops.run(async()=>this.search(channel,id,n,q,offset,limit,before,dates))};
    return {history,tail:this.range(channel,id,Math.max(0,n-6),6),lastUser:row?.last_user==null?undefined:this.range(channel,id,row.last_user,1)[0],lastAssistant:row?.last_assistant==null?undefined:this.range(channel,id,row.last_assistant,1)[0],unansweredCount:row?.unanswered_users??0,unansweredStart:(row?.last_reply??-1)+1};
  });}
  async readUnanswered(channel:ChannelName,id:string):Promise<SessionMessage[]>{const v=await this.view(channel,id);if(!v.unansweredCount)return [];return (await v.history.readRange(v.unansweredStart??0,v.history.count)).filter(m=>m.role==='user') as SessionMessage[];}
  latestConversation(channel:ChannelName):Promise<SessionMetadata|undefined>{return this.ops.run(async()=>{const row=this.db.prepare('SELECT * FROM conversations WHERE channel=? ORDER BY updated_at DESC LIMIT 1').get(channel) as Conv|undefined;return row&&this.meta(row);});}
  latestActivityAt():Promise<string|undefined>{return this.ops.run(async()=> (this.db.prepare('SELECT max(updated_at) AS at FROM conversations').get() as {at:string|null}).at??undefined);}
  summary():Promise<{total:number;byChannel:Record<ChannelName,number>;latestActivityAt?:string}>{return this.ops.run(async()=>{const rows=this.db.prepare('SELECT channel,count(*) AS n FROM conversations GROUP BY channel').all() as {channel:ChannelName;n:number}[];const byChannel:Record<ChannelName,number>={telegram:0,wechat:0};for(const r of rows)byChannel[r.channel]=r.n;const at=(this.db.prepare('SELECT max(updated_at) AS at FROM conversations').get() as {at:string|null}).at;return {total:byChannel.telegram+byChannel.wechat,byChannel,...(at?{latestActivityAt:at}:{})};});}
  check(channel:ChannelName,id:string,repair=false):Promise<{count:number;segments:number}>{return this.ops.run(async()=>{
    const row=this.conv(channel,id);if(!row)return {count:0,segments:0};
    const messages=this.range(channel,id,0,row.count),roles=messages.map(m=>m.role),state=replyState(messages),u=roles.lastIndexOf('user'),a=roles.lastIndexOf('assistant');
    if(messages.length!==row.count||(state.lastReply??null)!==row.last_reply||(state.unansweredUsers??0)!==row.unanswered_users||(u<0?null:u)!==row.last_user||(a<0?null:a)!==row.last_assistant)throw new Error('SQLite transcript metadata inconsistent.');
    const qc=this.db.prepare('PRAGMA quick_check').all() as {quick_check:string}[];if(qc.some(q=>q.quick_check!=='ok'))throw new Error('SQLite quick_check failed.');
    if(repair)this.tx(()=>this.db.exec("INSERT INTO message_fts(message_fts) VALUES('rebuild')"));
    this.db.exec("INSERT INTO message_fts(message_fts,rank) VALUES('integrity-check',1)");
    return {count:row.count,segments:0};});}
  /** Export a complete v1-compatible snapshot for controlled rollback. Stop all writers first. */
  async exportAll(outputDir:string):Promise<{conversations:number;messages:number}>{
    return this.ops.run(async()=>{
    const destination=relative(resolve(this.dir),resolve(outputDir));
    if(destination!=='..'&&!destination.startsWith('..'+sep)&&!isAbsolute(destination))throw new Error('Rollback export must be outside sessions.');
    mkdirSync(outputDir); // Refuse overwrite of any preexisting backup.
    const rows=this.db.prepare('SELECT * FROM conversations ORDER BY channel,conversation_id').all() as Conv[];
    const index:{entries:Record<string,SessionMetadata>}={entries:{}};
    let messages=0;
    for(const row of rows){
      const record:SessionRecord={...this.meta(row),messages:this.range(row.channel,row.conversation_id,0,row.count)};
      await writeJsonAtomic(join(outputDir,hash(row.key)+'.json'),record);
      index.entries[row.key]=this.meta(row);
      messages+=row.count;
    }
    await writeJsonAtomic(join(outputDir,'index.json'),index);
    return {conversations:rows.length,messages};
    });
  }
}
