import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { CORE_KEY, PERSONA_KEY, PERSONA_META_KEY, SCHEMA_KEY, MIGRATION_KEY, ROOTS_KEY, ILINK_KEY, ILINK_RECEIPT_KEY, ROUTES_KEY,
  VOICE_STATUS_KEY, RECENT_DELETED_KEY, StateError, columnNames, getState, integrity, managedKey, putState,
  readPersonaDocument, schemaVersion, stateCategory, tableExists, transaction, validatePersonaDocument,
  writePersonaDocument } from "./database.js";

export const SIX_TABLES = ["context", "messages", "conversations", "gateway_state", "channel_events", "voice_records"];
export const RETIRED_TABLES = ["recent_entries", "knowledge_review_progress", "gateway_state_meta", "gateway_path_roots",
  "ilink_state", "ilink_events", "owner_session_routes", "voice_jobs", "voice_text", "voice_status"];
const ftsTables = ["message_fts", "message_fts_config", "message_fts_data", "message_fts_docsize", "message_fts_idx"];
const legacyColumns: Record<string, string[]> = {
  gateway_state: ["key", "value", "updated_at"], gateway_state_meta: ["id", "version", "migrated_at"],
  gateway_path_roots: ["root"], ilink_state: ["id", "payload"], ilink_events: ["id"],
  owner_session_routes: ["route", "target", "owner"],
  recent_entries: ["id", "body", "conversation_state", "state_date", "event_at", "source_id", "revision", "updated_at"],
  knowledge_review_progress: ["scope", "through_seq", "updated_at"],
  voice_jobs: ["id", "kind", "day", "result", "error"], voice_text: ["token", "chat", "message", "text", "page"],
  voice_status: ["kind", "note"],
};
export interface SchemaPreview { from: 1 | 2; to: 2; changed: boolean; counts: Record<string, number>; databaseBytes: number; requiredFreeBytes: number }
function count(db: DatabaseSync, name: string): number {
  return tableExists(db, name) ? Number(db.prepare(`SELECT count(*) AS n FROM "${name}"`).get()!.n) : 0;
}
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function json(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new StateError("数据库 JSON 内容损坏；迁移已停止。"); }
}
function validateCoreBody(text: string): void {
  if (typeof text !== "string" || !text.trim() || text.includes("\u0000") || text.includes("\ufffd") || Buffer.byteLength(text) > 256 * 1024)
    throw new StateError("Core 为空、损坏或过大；迁移已停止。");
}
function checkTableSet(db: DatabaseSync, allowed: string[]): void {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(row => row.name);
  if (names.some(name => !allowed.includes(name))) throw new StateError("主库包含未登记的表；请先明确迁移范围。");
}
function routes(db: DatabaseSync): {route:string;target:string;owner:string}[] {
  const rows = tableExists(db, "owner_session_routes") ? db.prepare("SELECT route,target,owner FROM owner_session_routes ORDER BY route").all() as {route:string;target:string;owner:string}[] : [];
  validateRoutes(db, rows);
  return rows;
}
export function validateRoutes(db: DatabaseSync, rows: unknown): asserts rows is {route:string;target:string;owner:string}[] {
  if (!Array.isArray(rows) || rows.some(row => !object(row) || ["route", "target", "owner"].some(key => typeof row[key] !== "string" || !row[key])))
    throw new StateError("会话绑定文档无效。");
  if (!rows.length) return;
  const first = rows[0] as {route:string;target:string;owner:string};
  if (!/^\d+$/.test(first.owner) || first.target !== "telegram:" + first.owner || rows.length !== 2 ||
      rows.filter(row => row.route === first.target).length !== 1 || rows.filter(row => /^wechat:[^:]+$/.test(row.route)).length !== 1 ||
      rows.some(row => row.owner !== first.owner || row.target !== first.target)) throw new StateError("历史会话绑定超出受支持的映射；迁移已停止。");
  const tg = db.prepare("SELECT sender_id FROM conversations WHERE key=?").get(first.target) as {sender_id:string}|undefined;
  if (tg && tg.sender_id !== first.owner) throw new StateError("会话绑定 owner 冲突。");
  for (const row of rows) if (row.route !== row.target) {
    const conversation = db.prepare("SELECT count FROM conversations WHERE key=?").get(row.route) as {count:number}|undefined;
    if (conversation?.count) throw new StateError("绑定路径仍有独立历史；请先离线核对。");
  }
}
function reviewRows(db: DatabaseSync): {scope:string;through_seq:number;updated_at:string}[] {
  const rows = tableExists(db, "knowledge_review_progress") ? db.prepare("SELECT scope,through_seq,updated_at FROM knowledge_review_progress ORDER BY scope").all() as {scope:string;through_seq:number;updated_at:string}[] : [];
  for (const row of rows) {
    if (!/^formal:(telegram|wechat):[^:]+$/.test(row.scope) || !Number.isSafeInteger(row.through_seq) || row.through_seq < -1)
      throw new StateError("Recent 整理 scope 或 cursor 无法映射。");
    const conv = db.prepare("SELECT count FROM conversations WHERE key=?").get(row.scope.slice(7)) as {count:number}|undefined;
    if (!conv || row.through_seq >= conv.count) throw new StateError("Recent 整理进度孤立或超出会话范围。");
  }
  return rows;
}
/** Validate data without creating tables, changing versions, decoding ciphertext or invoking services. */
export function inspectSchemaMigration(db: DatabaseSync): SchemaPreview {
  integrity(db);
  if (db.prepare("PRAGMA foreign_key_check").all().length) throw new StateError("数据库引用完整性检查失败。");
  const version = schemaVersion(db);
  if (!version) throw new StateError("请先显式完成持久状态集中迁移，再执行六表迁移。");
  const bytes = Number(db.prepare("PRAGMA page_count").get()!.page_count) * Number(db.prepare("PRAGMA page_size").get()!.page_size);
  if (version === 2) {
    validateSixSchema(db);
    return {from:2,to:2,changed:false,counts:Object.fromEntries(SIX_TABLES.map(name=>[name,count(db,name)])),databaseBytes:bytes,requiredFreeBytes:bytes*3};
  }
  checkTableSet(db, ["messages", "conversations", "gateway_state", ...RETIRED_TABLES, ...ftsTables]);
  for (const required of ["messages", "conversations", "gateway_state", "gateway_state_meta"]) if (!tableExists(db, required)) throw new StateError("必要主表缺失。");
  for (const [name, columns] of Object.entries(legacyColumns)) if (tableExists(db, name) && JSON.stringify(columnNames(db, name)) !== JSON.stringify(columns))
    throw new StateError("待合并旧表包含未知字段或不兼容结构。");
  const state = db.prepare("SELECT key,value,updated_at FROM gateway_state").all() as {key:string;value:string;updated_at:string}[];
  const core = state.find(row=>row.key===CORE_KEY), persona = state.find(row=>row.key===PERSONA_KEY);
  if (!core || !persona) throw new StateError("正式 Core 或 Persona 缺失；请先恢复完整状态。");
  validateCoreBody(core.value); validatePersonaDocument(json(persona.value));
  for (const row of state) {
    if (!managedKey(row.key)) throw new StateError("集中状态包含未登记的文档键。");
    if (typeof row.updated_at !== "string" || !row.updated_at) throw new StateError("状态更新时间缺失。");
    if (row.key !== CORE_KEY && !object(json(row.value))) throw new StateError("状态 JSON 必须为对象。");
  }
  if (tableExists(db,"recent_entries")) {
    if (db.prepare("SELECT 1 FROM recent_entries WHERE id IS NULL OR id='' OR body IS NULL OR revision<1 OR updated_at IS NULL LIMIT 1").get())
      throw new StateError("Recent 身份、修订或正文无效。");
    if (db.prepare("SELECT source_id FROM recent_entries WHERE source_id IS NOT NULL GROUP BY source_id HAVING count(*)>1 LIMIT 1").get())
      throw new StateError("Recent 来源标识冲突。");
  }
  for (const row of db.prepare("SELECT source FROM messages WHERE source IS NOT NULL").iterate()) if (!object(json(row.source as string)))
    throw new StateError("消息来源元数据无效。");
  if (tableExists(db,"voice_jobs") && db.prepare("SELECT 1 FROM voice_jobs WHERE kind NOT IN ('asr','tts') OR id IS NULL OR day IS NULL LIMIT 1").get()) throw new StateError("未知语音任务类型或身份。");
  if (tableExists(db,"voice_status") && db.prepare("SELECT 1 FROM voice_status WHERE kind NOT IN ('asr','tts') LIMIT 1").get()) throw new StateError("未知语音诊断类型。");
  routes(db); reviewRows(db);
  return {from:1,to:2,changed:true,counts:Object.fromEntries(["messages","conversations","gateway_state",...RETIRED_TABLES].map(name=>[name,count(db,name)])),databaseBytes:bytes,requiredFreeBytes:bytes*3};
}
/** Only the explicit migration calls this DDL. Runtime constructors must never migrate implicitly. */
export function createSixTableSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE context (
    kind TEXT NOT NULL CHECK(kind IN ('core','persona','recent')), id TEXT NOT NULL, body TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1), updated_at TEXT NOT NULL, selected INTEGER,
    conversation_state TEXT, state_date TEXT, event_at TEXT, source_id TEXT,
    PRIMARY KEY(kind,id), CHECK(kind<>'core' OR id='main'),
    CHECK((kind='persona' AND selected IN (0,1)) OR (kind<>'persona' AND selected IS NULL)),
    CHECK(kind='recent' OR (conversation_state IS NULL AND state_date IS NULL AND event_at IS NULL AND source_id IS NULL)));
    CREATE UNIQUE INDEX context_selected_persona ON context(selected) WHERE kind='persona' AND selected=1;
    CREATE UNIQUE INDEX context_recent_source ON context(source_id) WHERE kind='recent' AND source_id IS NOT NULL;
    CREATE INDEX context_recent_state ON context(conversation_state,state_date) WHERE kind='recent';
    CREATE TABLE channel_events(channel TEXT NOT NULL,event_key TEXT NOT NULL,PRIMARY KEY(channel,event_key));
    CREATE TABLE voice_records(id TEXT PRIMARY KEY,operation_id TEXT UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('asr','tts')),
      day TEXT,result TEXT,error TEXT,token TEXT UNIQUE,chat TEXT,message INTEGER,text TEXT,page INTEGER,
      CHECK(operation_id IS NOT NULL OR token IS NOT NULL),CHECK(operation_id IS NULL OR day IS NOT NULL),
      CHECK(token IS NULL OR (chat IS NOT NULL AND text IS NOT NULL)));
    CREATE INDEX voice_records_quota ON voice_records(kind,day) WHERE operation_id IS NOT NULL;
    ALTER TABLE gateway_state ADD COLUMN category TEXT NOT NULL DEFAULT 'runtime' CHECK(category IN ('settings','runtime','channel','metadata','diagnostic'));
    ALTER TABLE gateway_state ADD COLUMN encoding TEXT NOT NULL DEFAULT 'json' CHECK(encoding IN ('json','encrypted_json'));
    ALTER TABLE messages ADD COLUMN source_channel TEXT CHECK(source_channel IN ('telegram','wechat'));
    CREATE INDEX messages_by_source_channel ON messages(conv_key,source_channel,seq);
    ALTER TABLE conversations ADD COLUMN recent_review_through_seq INTEGER NOT NULL DEFAULT -1 CHECK(recent_review_through_seq>=-1);
    ALTER TABLE conversations ADD COLUMN recent_review_updated_at TEXT;`);
}
function fingerprint(db: DatabaseSync, sql: string): string {
  const hash = createHash("sha256");
  for (const row of db.prepare(sql).iterate()) hash.update(JSON.stringify(row)+"\n");
  return hash.digest("hex");
}
function same(db: DatabaseSync, before: string, query: string): void {
  if (fingerprint(db, query) !== before) throw new StateError("迁移映射回读校验失败；整个事务已回滚。");
}
export function migrateSchemaDatabase(db: DatabaseSync, root: string, at = new Date().toISOString()): SchemaPreview {
  return transaction(db, () => {
    const preview = inspectSchemaMigration(db);
    if (!preview.changed) return preview;
    const messageColumns = columnNames(db,"messages").map(name=>'"'+name+'"').join(",");
    const convColumns = columnNames(db,"conversations").map(name=>'"'+name+'"').join(",");
    const messageHash = fingerprint(db,`SELECT ${messageColumns} FROM messages ORDER BY rowid`);
    const conversationHash = fingerprint(db,`SELECT ${convColumns} FROM conversations ORDER BY key`);
    const checks: {before:string;after:string}[] = [];
    const capture = (table:string, before:string, after:string) => {if(tableExists(db,table)) checks.push({before:fingerprint(db,before),after});};
    capture("recent_entries","SELECT * FROM recent_entries ORDER BY id","SELECT id,body,conversation_state,state_date,event_at,source_id,revision,updated_at FROM context WHERE kind='recent' ORDER BY id");
    capture("knowledge_review_progress","SELECT * FROM knowledge_review_progress ORDER BY scope","SELECT 'formal:'||key AS scope,recent_review_through_seq AS through_seq,recent_review_updated_at AS updated_at FROM conversations WHERE recent_review_updated_at IS NOT NULL ORDER BY scope");
    capture("ilink_events","SELECT id FROM ilink_events ORDER BY id","SELECT event_key AS id FROM channel_events WHERE channel='wechat' ORDER BY id");
    capture("voice_jobs","SELECT id,kind,day,result,error FROM voice_jobs ORDER BY id","SELECT operation_id AS id,kind,day,result,error FROM voice_records WHERE operation_id IS NOT NULL ORDER BY id");
    capture("voice_text","SELECT token,chat,message,text,page FROM voice_text ORDER BY token","SELECT token,chat,message,text,page FROM voice_records WHERE token IS NOT NULL ORDER BY token");
    const state = db.prepare("SELECT key,value,updated_at FROM gateway_state ORDER BY key").all() as {key:string;value:string;updated_at:string}[];
    const previousMigratedAt = db.prepare("SELECT migrated_at FROM gateway_state_meta WHERE id=1").get()!.migrated_at;
    const rootValues = tableExists(db,"gateway_path_roots") ? (db.prepare("SELECT root FROM gateway_path_roots ORDER BY root").all() as {root:string}[]).map(row=>row.root) : [];
    if (rootValues.some(value=>typeof value!=="string"||!value)) throw new StateError("历史路径根无效。");
    const oldRoutes=routes(db), reviews=reviewRows(db);
    const ilink=tableExists(db,"ilink_state")?db.prepare("SELECT payload FROM ilink_state WHERE id=1").get() as {payload:string}|undefined:undefined;
    const statuses=tableExists(db,"voice_status")?db.prepare("SELECT kind,note FROM voice_status").all() as {kind:string;note:string}[]:[];
    createSixTableSchema(db);
    for (const row of state) {
      if(row.key===CORE_KEY) db.prepare("INSERT INTO context(kind,id,body,revision,updated_at) VALUES('core','main',?,1,?)").run(row.value,row.updated_at);
      else if(row.key===PERSONA_KEY) writePersonaDocument(db,json(row.value),row.updated_at);
      else db.prepare("UPDATE gateway_state SET category=? WHERE key=?").run(stateCategory(row.key),row.key);
    }
    db.prepare("DELETE FROM gateway_state WHERE key IN (?,?)").run(CORE_KEY,PERSONA_KEY);
    if(tableExists(db,"recent_entries")) db.exec("INSERT INTO context(kind,id,body,revision,updated_at,conversation_state,state_date,event_at,source_id) SELECT 'recent',id,body,revision,updated_at,conversation_state,state_date,event_at,source_id FROM recent_entries");
    for(const row of reviews) db.prepare("UPDATE conversations SET recent_review_through_seq=?,recent_review_updated_at=? WHERE key=?").run(row.through_seq,row.updated_at,row.scope.slice(7));
    for(const row of db.prepare("SELECT rowid,source FROM messages WHERE source IS NOT NULL").all() as {rowid:number;source:string}[]) {
      const value=json(row.source) as {channel?:unknown};
      if(value.channel==="telegram"||value.channel==="wechat") db.prepare("UPDATE messages SET source_channel=? WHERE rowid=?").run(value.channel,row.rowid);
    }
    if(tableExists(db,"ilink_events")) db.exec("INSERT INTO channel_events(channel,event_key) SELECT 'wechat',id FROM ilink_events");
    if(tableExists(db,"voice_jobs")) db.exec("INSERT INTO voice_records(id,operation_id,kind,day,result,error) SELECT 'job:'||id,id,kind,day,result,error FROM voice_jobs");
    if(tableExists(db,"voice_text")) db.exec("INSERT INTO voice_records(id,kind,token,chat,message,text,page) SELECT 'text:'||token,'tts',token,chat,message,text,page FROM voice_text");
    if(ilink) putState(db,{key:ILINK_KEY,value:ilink.payload,encoding:"encrypted_json",category:"channel",updatedAt:at});
    putState(db,{key:ROUTES_KEY,value:JSON.stringify(oldRoutes),category:"runtime",updatedAt:at});
    putState(db,{key:VOICE_STATUS_KEY,value:JSON.stringify(Object.fromEntries(statuses.map(row=>[row.kind,row.note]))),category:"diagnostic",updatedAt:at});
    putState(db,{key:ROOTS_KEY,value:JSON.stringify([...new Set([...rootValues,root])]),category:"metadata",updatedAt:at});
    putState(db,{key:MIGRATION_KEY,value:JSON.stringify({from:1,to:2,migratedAt:at,previousMigratedAt}),category:"metadata",updatedAt:at});
    putState(db,{key:SCHEMA_KEY,value:JSON.stringify({version:2}),category:"metadata",updatedAt:at});
    same(db,messageHash,`SELECT ${messageColumns} FROM messages ORDER BY rowid`);
    same(db,conversationHash,`SELECT ${convColumns} FROM conversations ORDER BY key`);
    for(const check of checks) same(db,check.before,check.after);
    for(const row of state) if(![CORE_KEY,PERSONA_KEY].includes(row.key)) {
      const current=getState(db,row.key);
      if(current?.value!==row.value||current.updated_at!==row.updated_at) throw new StateError("状态文档迁移回读不一致。");
    }
    if(ilink&&getState(db,ILINK_KEY)?.value!==ilink.payload) throw new StateError("密文迁移回读不一致。");
    const core=state.find(row=>row.key===CORE_KEY)!;
    if(db.prepare("SELECT body FROM context WHERE kind='core' AND id='main'").get()?.body!==core.value) throw new StateError("Core 迁移回读不一致。");
    const expectedPersona=validatePersonaDocument(json(state.find(row=>row.key===PERSONA_KEY)!.value));
    const actualPersona=readPersonaDocument(db)!;
    if(actualPersona.version!==expectedPersona.version||actualPersona.active!==expectedPersona.active||
      JSON.stringify(Object.keys(actualPersona.presets).sort())!==JSON.stringify(Object.keys(expectedPersona.presets).sort())||
      Object.keys(expectedPersona.presets).some(id=>JSON.stringify(actualPersona.presets[id])!==JSON.stringify(expectedPersona.presets[id])))
      throw new StateError("Persona 迁移回读不一致。");
    for(const name of RETIRED_TABLES) if(tableExists(db,name)) db.exec(`DROP TABLE "${name}"`);
    validateSixSchema(db); integrity(db);
    return preview;
  });
}
export function validateSixSchema(db: DatabaseSync): void {
  if(schemaVersion(db)!==2) throw new StateError("不是六表格式。");
  checkTableSet(db,[...SIX_TABLES,...ftsTables]);
  const core=db.prepare("SELECT body FROM context WHERE kind='core' AND id='main'").get() as {body:string}|undefined;
  if(!core||countKind(db,"core")!==1) throw new StateError("正式 Core 缺失或重复。");
  validateCoreBody(core.body);
  if(!readPersonaDocument(db)) throw new StateError("正式 Persona 缺失。");
  if(db.prepare("SELECT 1 FROM context WHERE revision<1 OR typeof(revision)<>'integer' OR id='' OR body IS NULL OR updated_at IS NULL OR (kind='persona' AND selected IS NULL) LIMIT 1").get())
    throw new StateError("上下文身份或修订信息损坏。");
  if(db.prepare("SELECT 1 FROM conversations WHERE recent_review_through_seq>=count OR recent_review_through_seq < -1 OR (recent_review_through_seq<>-1 AND recent_review_updated_at IS NULL) LIMIT 1").get())
    throw new StateError("Recent 整理进度与会话不一致。");
  for(const row of db.prepare("SELECT key,category,encoding,value FROM gateway_state").iterate()) {
    getState(db,row.key as string);
    if([CORE_KEY,PERSONA_KEY].includes(row.key as string)) throw new StateError("状态表仍有重复的权威上下文。");
    if(row.encoding==="json") json(row.value as string);
    else if(row.key!==ILINK_KEY||typeof row.value!=="string"||!row.value) throw new StateError("未知加密状态条目。");
  }
  const routeState=getState(db,ROUTES_KEY);
  if(!routeState||routeState.encoding!=="json") throw new StateError("会话绑定文档缺失。");
  validateRoutes(db,json(routeState.value));
  const roots=getState(db,ROOTS_KEY); const values=roots&&json(roots.value);
  if(!roots||roots.encoding!=="json"||!Array.isArray(values)||values.some(value=>typeof value!=="string"||!value)) throw new StateError("历史路径元数据损坏。");
  const status=getState(db,VOICE_STATUS_KEY),statusValue=status&&json(status.value);
  if(!status||status.category!=="diagnostic"||status.encoding!=="json"||!object(statusValue)||Object.entries(statusValue).some(([kind,note])=>!["asr","tts"].includes(kind)||typeof note!=="string"))
    throw new StateError("语音诊断元数据损坏。");
  const ilink=getState(db,ILINK_KEY);
  if(ilink&&(ilink.category!=="channel"||ilink.encoding!=="encrypted_json"))throw new StateError("微信状态编码错误。");
  assertIlinkReceiptMetadata(db);
  assertDeletionMetadata(db);
}
function countKind(db:DatabaseSync,kind:string):number{return Number(db.prepare("SELECT count(*) AS n FROM context WHERE kind=?").get(kind)!.n);}
/** Plain metadata signals a pending encrypted receipt without exposing message content or platform IDs. */
export function assertIlinkReceiptMetadata(db:DatabaseSync,forDowngrade=false):void {
  const row=getState(db,ILINK_RECEIPT_KEY);
  if(!row)return;
  if(row.category!=="metadata"||row.encoding!=="json"||json(row.value)!==true||!getState(db,ILINK_KEY))
    throw new StateError("微信发送确认凭据标记损坏。");
  if(forDowngrade)throw new StateError("存在待结算的微信发送历史；请先由新版完成结算，不能降级到不识别确认凭据的旧版本。");
}
/** Deletion receipts have no equivalent in unmodified v1/legacy writers. Never claim a lossy export is safe. */
export function assertDeletionMetadata(db:DatabaseSync,forDowngrade=false):void {
  const row=getState(db,RECENT_DELETED_KEY);
  if(!row)return;
  const value=json(row.value);
  if(row.category!=="metadata"||row.encoding!=="json"||!object(value)||Object.keys(value).some(key=>!["version","entries"].includes(key))||value.version!==1||!Array.isArray(value.entries)) throw new StateError("Recent 删除凭据损坏。");
  const ids=new Set<string>(),sources=new Set<string>();
  for(const entry of value.entries) {
    if(!object(entry)||Object.keys(entry).some(key=>!["id","sourceId","revision","deletedAt"].includes(key))||
      typeof entry.id!=="string"||!entry.id.trim()||ids.has(entry.id)||
      !(entry.sourceId===null||typeof entry.sourceId==="string"&&Boolean(entry.sourceId.trim())&&!sources.has(entry.sourceId))||
      !Number.isSafeInteger(entry.revision)||Number(entry.revision)<1||typeof entry.deletedAt!=="string"||!Number.isFinite(Date.parse(entry.deletedAt)))
      throw new StateError("Recent 删除凭据损坏。");
    ids.add(entry.id);if(typeof entry.sourceId==="string")sources.add(entry.sourceId);
    if(db.prepare("SELECT 1 FROM context WHERE kind='recent' AND (id=? OR (? IS NOT NULL AND source_id=?)) LIMIT 1").get(entry.id,entry.sourceId as string|null,entry.sourceId as string|null))
      throw new StateError("Recent 删除凭据与有效条目冲突。");
  }
  if(forDowngrade&&value.entries.length) throw new StateError("目标旧版本不识别 Recent 删除凭据，拒绝可能复活条目的降级。");
}

/** Convert only an isolated copy. The original v2 database remains authoritative and untouched. */
export function downgradeSchemaDatabase(db:DatabaseSync,at=new Date().toISOString()):void {
  transaction(db,()=>{
    validateSixSchema(db); assertDeletionMetadata(db,true); assertIlinkReceiptMetadata(db,true);
    if(db.prepare("SELECT 1 FROM channel_events WHERE channel<>'wechat' LIMIT 1").get()) throw new StateError("目标旧格式不能表示这些渠道事件。");
    if(db.prepare("SELECT 1 FROM context WHERE kind='recent' AND conversation_state NOT IN ('Pending','Ongoing','Done') LIMIT 1").get())
      throw new StateError("目标旧格式不能表示未知 Recent 沟通状态。");
    const reserved=[SCHEMA_KEY,MIGRATION_KEY,ROOTS_KEY,PERSONA_META_KEY,ILINK_KEY,ROUTES_KEY,VOICE_STATUS_KEY,RECENT_DELETED_KEY];
    for(const row of db.prepare("SELECT key,encoding FROM gateway_state").iterate()) if(!reserved.includes(row.key as string)&&(!managedKey(row.key as string)||row.encoding!=="json"))
      throw new StateError("目标旧格式不能表示新增状态条目。");
    const core=db.prepare("SELECT body,updated_at FROM context WHERE kind='core' AND id='main'").get() as {body:string;updated_at:string};
    const persona=readPersonaDocument(db)!;
    const personaAt=getState(db,PERSONA_META_KEY)!.updated_at;
    const ilink=getState(db,ILINK_KEY);
    const routeRows=json(getState(db,ROUTES_KEY)!.value) as {route:string;target:string;owner:string}[];
    const rootRows=json(getState(db,ROOTS_KEY)!.value) as string[];
    const statuses=json(getState(db,VOICE_STATUS_KEY)?.value??"{}");
    if(!object(statuses)||Object.entries(statuses).some(([kind,note])=>!["asr","tts"].includes(kind)||typeof note!=="string")) throw new StateError("语音诊断无法转换。");
    const migration=getState(db,MIGRATION_KEY), meta=migration?json(migration.value):undefined;
    db.exec(`CREATE TABLE gateway_state_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,migrated_at TEXT NOT NULL);
      CREATE TABLE gateway_path_roots(root TEXT PRIMARY KEY);
      CREATE TABLE recent_entries(id TEXT PRIMARY KEY,body TEXT NOT NULL,conversation_state TEXT CHECK(conversation_state IN ('Pending','Ongoing','Done')),
        state_date TEXT,event_at TEXT,source_id TEXT,revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
      CREATE INDEX recent_by_state ON recent_entries(conversation_state,state_date);
      CREATE UNIQUE INDEX recent_source_unique ON recent_entries(source_id) WHERE source_id IS NOT NULL;
      CREATE TABLE knowledge_review_progress(scope TEXT PRIMARY KEY,through_seq INTEGER NOT NULL CHECK(through_seq>=-1),updated_at TEXT NOT NULL);
      CREATE TABLE owner_session_routes(route TEXT PRIMARY KEY,target TEXT NOT NULL,owner TEXT NOT NULL);
      CREATE TABLE ilink_state(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
      CREATE TABLE ilink_events(id TEXT PRIMARY KEY);
      CREATE TABLE voice_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,day TEXT NOT NULL,result TEXT,error TEXT);
      CREATE TABLE voice_text(token TEXT PRIMARY KEY,chat TEXT NOT NULL,message INTEGER,text TEXT NOT NULL,page INTEGER);
      CREATE TABLE voice_status(kind TEXT PRIMARY KEY,note TEXT NOT NULL);
      INSERT INTO recent_entries SELECT id,body,conversation_state,state_date,event_at,source_id,revision,updated_at FROM context WHERE kind='recent';
      INSERT INTO knowledge_review_progress SELECT 'formal:'||key,recent_review_through_seq,recent_review_updated_at FROM conversations WHERE recent_review_updated_at IS NOT NULL;
      INSERT INTO ilink_events SELECT event_key FROM channel_events WHERE channel='wechat';
      INSERT INTO voice_jobs SELECT operation_id,kind,day,result,error FROM voice_records WHERE operation_id IS NOT NULL;
      INSERT INTO voice_text SELECT token,chat,message,text,page FROM voice_records WHERE token IS NOT NULL;`);
    if(ilink)db.prepare("INSERT INTO ilink_state(id,payload) VALUES(1,?)").run(ilink.value);
    for(const row of routeRows)db.prepare("INSERT INTO owner_session_routes(route,target,owner) VALUES(?,?,?)").run(row.route,row.target,row.owner);
    for(const root of rootRows)db.prepare("INSERT INTO gateway_path_roots(root) VALUES(?)").run(root);
    for(const [kind,note] of Object.entries(statuses))db.prepare("INSERT INTO voice_status(kind,note) VALUES(?,?)").run(kind,note as string);
    for(const row of db.prepare("SELECT rowid,source,source_channel FROM messages").all() as {rowid:number;source:string|null;source_channel:string|null}[]) {
      const old=row.source?json(row.source):{};
      if(!object(old))throw new StateError("消息来源元数据无法转换。");
      const {channel:_oldChannel,...rest}=old;
      const source=row.source_channel?{...rest,channel:row.source_channel}:rest;
      const text=Object.keys(source).length?JSON.stringify(source):row.source===null?null:"{}";
      db.prepare("UPDATE messages SET source=? WHERE rowid=?").run(text,row.rowid);
    }
    for(const key of reserved)db.prepare("DELETE FROM gateway_state WHERE key=?").run(key);
    // Remove only the newly introduced columns; message rowids and FTS ownership never change.
    db.exec(`DROP INDEX messages_by_source_channel;
      ALTER TABLE messages DROP COLUMN source_channel;
      ALTER TABLE conversations DROP COLUMN recent_review_through_seq;
      ALTER TABLE conversations DROP COLUMN recent_review_updated_at;
      ALTER TABLE gateway_state DROP COLUMN category;
      ALTER TABLE gateway_state DROP COLUMN encoding;
      DROP TABLE context; DROP TABLE channel_events; DROP TABLE voice_records;`);
    db.prepare("INSERT INTO gateway_state(key,value,updated_at) VALUES(?,?,?)").run(CORE_KEY,core.body,core.updated_at);
    db.prepare("INSERT INTO gateway_state(key,value,updated_at) VALUES(?,?,?)").run(PERSONA_KEY,JSON.stringify(persona),personaAt);
    db.prepare("INSERT INTO gateway_state_meta(id,version,migrated_at) VALUES(1,1,?)").run(object(meta)&&typeof meta.previousMigratedAt==="string"?meta.previousMigratedAt:at);
    integrity(db);
    if(schemaVersion(db)!==1)throw new StateError("旧格式转换校验失败。");
    inspectSchemaMigration(db);
  });
}
