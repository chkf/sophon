import { DatabaseSync } from 'node:sqlite';
import { StateError, getState, putState, tableExists, transaction } from '../state/database.js';

export const MEMORY_KEY = 'system/memory_graph_extension';
export const MEMORY_V1_TABLES = ['memory_topics', 'memory_nodes', 'memory_topic_memberships', 'memory_topic_edges', 'memory_sources', 'memory_jobs'];
export const MEMORY_V1_DDL = `
CREATE TABLE memory_topics (
 id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, parent_id TEXT REFERENCES memory_topics(id),
 name TEXT NOT NULL, normalized_name TEXT NOT NULL, description TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]',
 occurrence_mass REAL NOT NULL DEFAULT 0 CHECK(occurrence_mass>=0), mass_updated_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')), revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX memory_topic_name ON memory_topics(owner_scope,COALESCE(parent_id,''),normalized_name) WHERE status='active';
CREATE INDEX memory_topic_parent ON memory_topics(owner_scope,parent_id,status);
CREATE TABLE memory_nodes (
 id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('turn','rollup')),
 conv_key TEXT NOT NULL REFERENCES conversations(key), assistant_rowid INTEGER REFERENCES messages(rowid) ON DELETE SET NULL,
 gist TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
 importance REAL NOT NULL CHECK(importance BETWEEN 0 AND 1), activation_base REAL NOT NULL DEFAULT 1 CHECK(activation_base BETWEEN 0 AND 1),
 half_life_days REAL NOT NULL CHECK(half_life_days>0), reinforced_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','stale','archived')),
 token_estimate INTEGER NOT NULL CHECK(token_estimate>=0), revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX memory_turn_identity ON memory_nodes(conv_key,assistant_rowid) WHERE kind='turn' AND assistant_rowid IS NOT NULL;
CREATE INDEX memory_node_scope ON memory_nodes(owner_scope,status);
CREATE TABLE memory_topic_memberships (
 topic_id TEXT NOT NULL REFERENCES memory_topics(id), node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
 score REAL NOT NULL CHECK(score BETWEEN 0 AND 1), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','covered','archived')),
 created_at TEXT NOT NULL, PRIMARY KEY(topic_id,node_id));
CREATE INDEX memory_membership_node ON memory_topic_memberships(node_id,status);
CREATE TABLE memory_topic_edges (
 topic_a TEXT NOT NULL REFERENCES memory_topics(id), topic_b TEXT NOT NULL REFERENCES memory_topics(id),
 pair_mass REAL NOT NULL CHECK(pair_mass>=0), evidence REAL NOT NULL CHECK(evidence BETWEEN 0 AND 1),
 strength REAL NOT NULL CHECK(strength BETWEEN 0 AND 1), updated_at TEXT NOT NULL,
 PRIMARY KEY(topic_a,topic_b), CHECK(topic_a<topic_b));
CREATE INDEX memory_edge_reverse ON memory_topic_edges(topic_b,topic_a);
CREATE TABLE memory_sources (
 node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
 message_rowid INTEGER NOT NULL REFERENCES messages(rowid) ON DELETE CASCADE, PRIMARY KEY(node_id,message_rowid));
CREATE INDEX memory_source_message ON memory_sources(message_rowid);
CREATE TABLE memory_jobs (
 id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind='classify'), operation_key TEXT NOT NULL,
 assistant_rowid INTEGER NOT NULL REFERENCES messages(rowid) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('pending','running','done','retry','failed')),
 attempts INTEGER NOT NULL DEFAULT 0, run_after TEXT NOT NULL, lease TEXT, error_code TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_scope,kind,operation_key));
CREATE INDEX memory_jobs_ready ON memory_jobs(owner_scope,status,run_after);
CREATE TRIGGER memory_source_delete BEFORE DELETE ON messages BEGIN
 UPDATE memory_nodes SET status='stale',gist='',summary='',detail='',revision=revision+1
 WHERE id IN (SELECT node_id FROM memory_sources WHERE message_rowid=old.rowid);
END;
CREATE TRIGGER memory_source_edit BEFORE UPDATE OF content,role,origin,partial,conv_key,at ON messages BEGIN
 UPDATE memory_nodes SET status='stale',gist='',summary='',detail='',revision=revision+1
 WHERE id IN (SELECT node_id FROM memory_sources WHERE message_rowid=old.rowid);
END;`;
export const MEMORY_TABLES = [...MEMORY_V1_TABLES, 'memory_progress', 'memory_operations', 'memory_recent_links', 'memory_audit'];
const EXTRA_DDL = `
CREATE TABLE memory_progress (
 job_id TEXT PRIMARY KEY REFERENCES memory_jobs(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE memory_operations (
 id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, topic_id TEXT NOT NULL REFERENCES memory_topics(id), operation_key TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','running','retry','done','failed')), attempts INTEGER NOT NULL DEFAULT 0,
 run_after TEXT NOT NULL, lease TEXT, error_code TEXT, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(owner_scope,operation_key));
CREATE INDEX memory_operations_ready ON memory_operations(owner_scope,status,run_after);
CREATE TABLE memory_recent_links (
 node_id TEXT PRIMARY KEY REFERENCES memory_nodes(id) ON DELETE CASCADE, recent_id TEXT NOT NULL,
 owner_scope TEXT NOT NULL, recent_revision INTEGER NOT NULL, UNIQUE(owner_scope,recent_id));
CREATE TABLE memory_audit (
 id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
 created_at TEXT NOT NULL, undone_at TEXT);
CREATE TRIGGER memory_progress_delete BEFORE DELETE ON messages BEGIN
 DELETE FROM memory_progress WHERE job_id IN (SELECT id FROM memory_jobs WHERE owner_scope=old.conv_key);
 UPDATE memory_operations SET status='failed',payload='{}',lease=NULL,error_code='SOURCE_CHANGED' WHERE owner_scope=old.conv_key AND status<>'done';
END;
CREATE TRIGGER memory_progress_edit BEFORE UPDATE OF content,role,origin,partial,conv_key,at ON messages BEGIN
 DELETE FROM memory_progress WHERE job_id IN (SELECT id FROM memory_jobs WHERE owner_scope=old.conv_key);
 UPDATE memory_operations SET status='failed',payload='{}',lease=NULL,error_code='SOURCE_CHANGED' WHERE owner_scope=old.conv_key AND status<>'done';
END;
CREATE TRIGGER memory_recent_delete BEFORE DELETE ON context WHEN old.kind='recent' BEGIN
 UPDATE memory_nodes SET status='stale',gist='',summary='',detail='',revision=revision+1 WHERE id IN (SELECT node_id FROM memory_recent_links WHERE recent_id=old.id);
END;
CREATE TRIGGER memory_recent_edit BEFORE UPDATE ON context WHEN old.kind='recent' BEGIN
 UPDATE memory_nodes SET status='stale',gist='',summary='',detail='',revision=revision+1 WHERE id IN (SELECT node_id FROM memory_recent_links WHERE recent_id=old.id);
END;`;
export const MEMORY_DDL = MEMORY_V1_DDL + EXTRA_DDL;
export interface MemoryMarker { version: 1|2; revision: number; installedAt: string; recentScopes?: string[] }
export function memoryMarker(db: DatabaseSync): MemoryMarker | undefined {
  if (!tableExists(db, 'gateway_state')) return undefined;
  const row = getState(db, MEMORY_KEY);
  if (!row) return undefined;
  let value: MemoryMarker;
  try { value = JSON.parse(row.value); } catch { throw new StateError('记忆图版本标记损坏。'); }
  if (row.category !== 'metadata' || row.encoding !== 'json' || ![1,2].includes(value?.version) ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isFinite(Date.parse(value.installedAt)) || (value.recentScopes!==undefined&&(!Array.isArray(value.recentScopes)||new Set(value.recentScopes).size!==value.recentScopes.length||value.recentScopes.some(scope=>typeof scope!=='string'||!/^telegram:\d+$/.test(scope)))))
    throw new StateError('记忆图版本不兼容或损坏。');
  return value;
}
const definition = (db: DatabaseSync) => db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name GLOB 'memory_*' ORDER BY name").all();
const expected = new Map<number,string>();
/** No implicit DDL: constructors only validate the registered extension. */
export function validateMemorySchema(db: DatabaseSync): boolean {
  const marker = memoryMarker(db), objects = definition(db);
  if (!marker) {
    if (objects.length) throw new StateError('记忆图表未登记，拒绝读取。');
    return false;
  }
  if (!expected.has(marker.version)) {
    const reference = new DatabaseSync(':memory:');
    try { reference.exec("CREATE TABLE messages(rowid INTEGER PRIMARY KEY, content TEXT, role TEXT, origin TEXT, partial INTEGER, conv_key TEXT, at TEXT);CREATE TABLE context(kind TEXT,id TEXT);"+(marker.version===1?MEMORY_V1_DDL:MEMORY_DDL)); expected.set(marker.version,JSON.stringify(definition(reference))); } finally { reference.close(); }
  }
  if (JSON.stringify(objects) !== expected.get(marker.version)) throw new StateError('记忆图结构不完整或不兼容。');
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new StateError('记忆图引用完整性检查失败。');
  if (db.prepare(`SELECT 1 FROM memory_sources s JOIN memory_nodes n ON n.id=s.node_id
    JOIN messages m ON m.rowid=s.message_rowid WHERE n.owner_scope<>m.conv_key LIMIT 1`).get() ||
    db.prepare(`SELECT 1 FROM memory_topic_memberships x JOIN memory_topics t ON t.id=x.topic_id
      JOIN memory_nodes n ON n.id=x.node_id WHERE t.owner_scope<>n.owner_scope LIMIT 1`).get() ||
    db.prepare(`SELECT 1 FROM memory_topics t JOIN memory_topics p ON p.id=t.parent_id WHERE t.owner_scope<>p.owner_scope LIMIT 1`).get() ||
    db.prepare(`SELECT 1 FROM memory_topic_edges e JOIN memory_topics a ON a.id=e.topic_a JOIN memory_topics b ON b.id=e.topic_b
      WHERE a.owner_scope<>b.owner_scope LIMIT 1`).get() ||
    db.prepare(`SELECT 1 FROM memory_jobs j JOIN messages m ON m.rowid=j.assistant_rowid WHERE j.owner_scope<>m.conv_key LIMIT 1`).get())
    throw new StateError('记忆图来源范围冲突。');
  if(marker.version===2&&(db.prepare(`SELECT 1 FROM memory_recent_links r JOIN memory_nodes n ON n.id=r.node_id WHERE r.owner_scope<>n.owner_scope LIMIT 1`).get()||
    db.prepare(`SELECT 1 FROM memory_operations o JOIN memory_topics t ON t.id=o.topic_id WHERE o.owner_scope<>t.owner_scope LIMIT 1`).get()))throw new StateError('记忆图任务范围冲突。');
  const rows = db.prepare('SELECT id,parent_id FROM memory_topics').all() as {id:string;parent_id:string|null}[];
  const parents = new Map(rows.map(t=>[t.id,t.parent_id]));
  for (const topic of rows) {
    const seen = new Set<string>(); let id: string|null|undefined = topic.id;
    while (id) { if (seen.has(id)) throw new StateError('记忆主题存在环。'); seen.add(id); id=parents.get(id); }
  }
  return true;
}
/** Called only by explicit stopped-host migration, after taking a complete snapshot. */
export function installMemorySchema(db: DatabaseSync, at = new Date().toISOString()): boolean {
  return transaction(db, () => {
    const installed=validateMemorySchema(db), old=memoryMarker(db);
    if(old?.version===2)return false;
    db.exec(installed?EXTRA_DDL:MEMORY_DDL);
    putState(db, {key:MEMORY_KEY,category:'metadata',value:JSON.stringify({...old,version:2,revision:(old?.revision??0)+1,installedAt:old?.installedAt??at})});
    validateMemorySchema(db);
    return true;
  });
}
export function bumpMemoryRevision(db: DatabaseSync): void {
  const marker = memoryMarker(db)!;
  putState(db, {key:MEMORY_KEY,category:'metadata',value:JSON.stringify({...marker,revision:marker.revision+1})});
}

