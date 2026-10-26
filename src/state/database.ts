import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const STATE_VERSION = 2;
export const LEGACY_STATE_VERSION = 1;
export const SCHEMA_KEY = "system/schema";
export const MIGRATION_KEY = "system/migration";
export const ROOTS_KEY = "system/data_roots";
export const PERSONA_META_KEY = "system/persona";
export const ILINK_KEY = "channels/ilink";
export const ILINK_RECEIPT_KEY = "channels/ilink_delivery_receipt_pending";
export const ROUTES_KEY = "sessions/owner_routes";
export const VOICE_STATUS_KEY = "voice/status";
export const RECENT_DELETED_KEY = "context/recent_deleted";
export const PERSONA_KEY = "runtime/persona.json";
export type SchemaVersion = 0 | 1 | 2;
export type StateCategory = "settings" | "runtime" | "channel" | "metadata" | "diagnostic";
export type StateEncoding = "json" | "encrypted_json";
export interface StateRow { key: string; category: StateCategory; encoding: StateEncoding; value: string; updated_at: string }
export interface PersonaDocument { version: 1 | 2; showStageDirections?: boolean; active: string; presets: Record<string, string[]> }
const categories = new Set<StateCategory>(["settings", "runtime", "channel", "metadata", "diagnostic"]);
/** Only fixed operator messages belong here; never wrap raw JSON/SQL/credential errors. */
export class StateError extends Error {
  constructor(message: string) { super(message); this.name = "StateError"; }
}
export const CORE_KEY = "core/core.md";
export const MAIN_DATABASE = "sessions/gateway.sqlite";
export const DOCUMENTS = [CORE_KEY, "runtime/persona.json", "runtime/expression.json", "runtime/provider.json", "runtime/model.json",
  "runtime/api-model.json", "runtime/memory-model.json", "runtime/openrouter-model.json", "runtime/openrouter-images.json", "voice/settings.json",
  "channels/active.json", "channels/telegram.json", "heartbeat/state.json",
  "runtime/media-exploration-v3-state.json"];
const dynamicDocument = /^(?:runtime\/(?:context|provider\.json\.deliveries|api-turns|openrouter-turns|openrouter-image-turns)|media\/exploration-drafts)\/[a-f0-9]{64}\.json(?:\.[a-f0-9-]+\.legacy-recovery)?$/;
export function managedKey(key: string): boolean { return DOCUMENTS.includes(key) || dynamicDocument.test(key); }
export function address(file: string): { root: string; key: string } | undefined {
  const normalized = resolve(file).replaceAll("\\", "/");
  for (const part of ["/core/", "/runtime/", "/channels/", "/heartbeat/", "/voice/", "/media/"]) {
    const i = normalized.lastIndexOf(part);
    if (i >= 0 && managedKey(normalized.slice(i + 1))) return { root: normalized.slice(0, i), key: normalized.slice(i + 1) };
  }
  return undefined;
}
export function mainPath(root: string): string { return join(root, MAIN_DATABASE); }
function databasePresent(root: string): boolean {
  if (existsSync(mainPath(root))) return true;
  // Existing migration recovery evidence prevents accidental re-initialization after losing the authority DB.
  if ([".schema-migration", ".state-migration"].some(name => existsSync(join(root, name))))
    throw new StateError("已迁移的主数据库缺失；请恢复完整数据，不会读取遗留文件或新建空库。");
  return false;
}
export function openDatabase(path: string, readOnly = false): DatabaseSync {
  if (!readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { readOnly });
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  if (!readOnly) { db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;"); chmodSync(path, 0o600); }
  return db;
}
export function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
export function columnNames(db: DatabaseSync, table: string): string[] {
  if (!/^[a-z_]+$/.test(table)) throw new StateError("数据库对象名称无效。");
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(row => row.name);
}
/** 0 is genuine file authority. A partial/new/unknown schema never falls back to old files. */
export function schemaVersion(db: DatabaseSync): SchemaVersion {
  const columns = columnNames(db, "gateway_state");
  const modern = columns.includes("encoding") || columns.includes("category") ||
    ["context", "channel_events", "voice_records"].some(name => tableExists(db, name));
  if (modern) {
    if (!["key", "category", "encoding", "value", "updated_at"].every(name => columns.includes(name)))
      throw new StateError("持久状态版本标记缺失或结构损坏。");
    const row = db.prepare("SELECT category,encoding,value FROM gateway_state WHERE key=?").get(SCHEMA_KEY) as StateRow | undefined;
    let marker: unknown;
    try { marker = row && JSON.parse(row.value); } catch { throw new StateError("持久状态版本标记损坏。"); }
    if (!row || row.category !== "metadata" || row.encoding !== "json" || !marker || typeof marker !== "object" || Array.isArray(marker))
      throw new StateError("持久状态版本标记缺失或损坏。");
    if ((marker as { version?: unknown }).version !== STATE_VERSION) throw new StateError("持久状态版本不兼容；请保留数据并使用匹配版本。");
    if (!["context", "messages", "conversations", "channel_events", "voice_records"].every(name => tableExists(db, name)) || tableExists(db, "gateway_state_meta"))
      throw new StateError("六表结构不完整或仍有冲突的旧版本标记。");
    return 2;
  }
  if (columns.includes("key") && db.prepare("SELECT 1 FROM gateway_state WHERE key=?").get(SCHEMA_KEY))
    throw new StateError("持久状态版本标记与结构冲突。");
  if (!tableExists(db, "gateway_state_meta")) return 0;
  const rows = db.prepare("SELECT id,version FROM gateway_state_meta").all() as { id: number; version: number }[];
  if (!rows.length) return 0; // A failed, uncommitted legacy consolidation may have prepared empty tables.
  if (rows.length !== 1 || rows[0].id !== 1 || rows[0].version !== LEGACY_STATE_VERSION)
    throw new StateError("持久状态版本不兼容；请保留数据并使用匹配版本。");
  if (!["key", "value", "updated_at"].every(name => columns.includes(name))) throw new StateError("集中状态表损坏。");
  return 1;
}
export function activeDatabase(db: DatabaseSync): boolean { return schemaVersion(db) !== 0; }
export function stateCategory(key: string): StateCategory {
  if (key.startsWith("system/") || key === RECENT_DELETED_KEY || key === ILINK_RECEIPT_KEY) return "metadata";
  if (key === VOICE_STATUS_KEY) return "diagnostic";
  if (key.startsWith("channels/")) return "channel";
  if (["runtime/expression.json", "runtime/provider.json", "runtime/model.json", "runtime/api-model.json", "runtime/memory-model.json", "runtime/openrouter-model.json", "runtime/openrouter-images.json", "voice/settings.json"].includes(key)) return "settings";
  return "runtime";
}
export function getState(db: DatabaseSync, key: string): StateRow | undefined {
  if (!tableExists(db, "gateway_state")) return undefined;
  const modern = columnNames(db, "gateway_state").includes("encoding");
  const row = db.prepare(modern ? "SELECT key,category,encoding,value,updated_at FROM gateway_state WHERE key=?"
    : "SELECT key,value,updated_at FROM gateway_state WHERE key=?").get(key) as StateRow | undefined;
  if (!row) return undefined;
  if (!modern) return { ...row, category: stateCategory(key), encoding: "json" };
  if (!categories.has(row.category) || !["json", "encrypted_json"].includes(row.encoding) || typeof row.value !== "string")
    throw new StateError("持久状态编码无效。");
  return row;
}
/** Thin storage operation: callers keep related changes in their existing transaction. */
export function putState(db: DatabaseSync, row: { key: string; value: string; category?: StateCategory; encoding?: StateEncoding; updatedAt?: string }): void {
  const category = row.category ?? stateCategory(row.key), encoding = row.encoding ?? "json";
  if (!row.key || typeof row.value !== "string" || !categories.has(category) || !["json", "encrypted_json"].includes(encoding))
    throw new StateError("持久状态条目无效。");
  const at = row.updatedAt ?? new Date().toISOString();
  if (!columnNames(db, "gateway_state").includes("encoding")) {
    if (encoding !== "json") throw new StateError("旧格式不支持该编码。");
    db.prepare("INSERT INTO gateway_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(row.key, row.value, at);
  } else db.prepare("INSERT INTO gateway_state(key,category,encoding,value,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET category=excluded.category,encoding=excluded.encoding,value=excluded.value,updated_at=excluded.updated_at")
    .run(row.key, category, encoding, row.value, at);
}
export function validatePersonaDocument(raw: unknown): PersonaDocument {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new StateError("Persona 状态格式错误。");
  const state = raw as Record<string, unknown>;
  if (![1, 2].includes(state.version as number) || typeof state.active !== "string" || !state.presets || typeof state.presets !== "object" || Array.isArray(state.presets))
    throw new StateError("Persona 状态版本不兼容。");
  const entries = Object.entries(state.presets);
  if (!entries.length || entries.length > 24) throw new StateError("Persona 模式数量不合法。");
  for (const [id, words] of entries) if (!/^[a-z][a-z0-9_]{0,23}$/.test(id) || !Array.isArray(words) || !words.length || words.length > 12 ||
    words.some(word => typeof word !== "string" || !/^[A-Z][A-Z0-9_]{0,39}$/.test(word)) || new Set(words).size !== words.length)
    throw new StateError("Persona 关键词或模式名无效。");
  if (!Object.hasOwn(state.presets, "default") || !Object.hasOwn(state.presets, state.active)) throw new StateError("Persona 默认或当前模式缺失。");
  if (state.showStageDirections !== undefined && typeof state.showStageDirections !== "boolean") throw new StateError("角色描写开关无效。");
  return raw as PersonaDocument;
}
export function readPersonaDocument(db: DatabaseSync): PersonaDocument | undefined {
  const rows = db.prepare("SELECT id,body,selected FROM context WHERE kind='persona' ORDER BY rowid").all() as { id: string; body: string; selected: number }[];
  if (!rows.length) return undefined;
  const meta = getState(db, PERSONA_META_KEY);
  let metadata: { version: number; revision: number; showStageDirections?: boolean };
  try { metadata = JSON.parse(meta?.value ?? "null"); } catch { throw new StateError("Persona 元数据损坏。"); }
  if (!meta || meta.category !== "metadata" || meta.encoding !== "json" || !metadata! || !Number.isSafeInteger(metadata.revision) || metadata.revision < 1 || rows.filter(row => row.selected === 1).length !== 1)
    throw new StateError("Persona 当前选择或修订元数据损坏。");
  try { return validatePersonaDocument({ version: metadata.version, ...(metadata.showStageDirections !== undefined ? {showStageDirections:metadata.showStageDirections} : {}), active: rows.find(row => row.selected === 1)!.id,
    presets: Object.fromEntries(rows.map(row => [row.id, JSON.parse(row.body)])) }); }
  catch { throw new StateError("Persona 内容损坏。"); }
}
/** No implicit initialization or version upgrade. Preserve caller-owned revision checks and transaction. */
export function writePersonaDocument(db: DatabaseSync, raw: unknown, updatedAt = new Date().toISOString()): void {
  const value = validatePersonaDocument(raw);
  transaction(db, () => {
    const rows = db.prepare("SELECT id,body,selected,revision FROM context WHERE kind='persona'").all() as {id:string;body:string;selected:number;revision:number}[];
    const meta = getState(db, PERSONA_META_KEY);
    let revision = 0;
    if (meta) {
      let parsed: { revision: number };
      try { parsed = JSON.parse(meta.value); } catch { throw new StateError("Persona 元数据损坏。"); }
      if (meta.category !== "metadata" || meta.encoding !== "json" || !Number.isSafeInteger(parsed?.revision) || parsed.revision < 1) throw new StateError("Persona 修订元数据损坏。");
      revision = parsed.revision;
    } else if (rows.length) throw new StateError("Persona 修订元数据缺失。");
    const previous = new Map(rows.map(row => [row.id, row]));
    // Clear selection first so the partial unique index never sees two active rows.
    db.prepare("UPDATE context SET selected=0 WHERE kind='persona'").run();
    for (const row of rows) if (!Object.hasOwn(value.presets, row.id)) db.prepare("DELETE FROM context WHERE kind='persona' AND id=?").run(row.id);
    for (const [id, words] of Object.entries(value.presets)) {
      const body = JSON.stringify(words), selected = id === value.active ? 1 : 0, old = previous.get(id);
      const changed = !old || old.body !== body || old.selected !== selected;
      db.prepare("INSERT INTO context(kind,id,body,revision,updated_at,selected) VALUES('persona',?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,revision=excluded.revision,updated_at=CASE WHEN context.body<>excluded.body OR context.revision<>excluded.revision THEN excluded.updated_at ELSE context.updated_at END,selected=excluded.selected")
        .run(id, body, old ? old.revision + Number(changed) : 1, updatedAt, selected);
    }
    putState(db, { key: PERSONA_META_KEY, value: JSON.stringify({ version: value.version, ...(value.showStageDirections !== undefined ? {showStageDirections:value.showStageDirections} : {}), revision: revision + 1 }), category: "metadata", updatedAt });
  });
}
export function centralEnabled(root: string): boolean {
  if (!databasePresent(root)) return false;
  const db = openDatabase(mainPath(root), true);
  try { return activeDatabase(db); } finally { db.close(); }
}
let transactionSequence = 0;
export function transaction<T>(db: DatabaseSync, body: () => T): T {
  // isTransaction was backported in Node 22.16.0, the supported minimum.
  // https://nodejs.org/download/release/v22.16.0/docs/api/sqlite.html#databaseistransaction
  const nested = db.isTransaction, savepoint = "gateway_state_" + (++transactionSequence);
  db.exec(nested ? "SAVEPOINT " + savepoint : "BEGIN IMMEDIATE");
  try { const result = body(); db.exec(nested ? "RELEASE " + savepoint : "COMMIT"); return result; }
  catch (error) {
    try { db.exec(nested ? "ROLLBACK TO " + savepoint + "; RELEASE " + savepoint : "ROLLBACK"); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}
export function integrity(db: DatabaseSync): void {
  const result = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
  if (result.length !== 1 || result[0].integrity_check !== "ok") throw new StateError("SQLite 完整性检查失败。");
}
export function createStateSchema(db: DatabaseSync): void {
  if (schemaVersion(db) === 2) return;
  db.exec(`CREATE TABLE IF NOT EXISTS gateway_state_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,migrated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gateway_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gateway_path_roots(root TEXT PRIMARY KEY);`);
}
export function pathRoots(root: string, db?: DatabaseSync): string[] {
  if (!db && !databasePresent(root)) return [resolve(root)];
  const connection = db ?? openDatabase(mainPath(root), true);
  try {
    let stored: string[] = [];
    if (schemaVersion(connection) === 2) {
      const row = getState(connection, ROOTS_KEY);
      try { stored = JSON.parse(row?.value ?? "null"); } catch { throw new StateError("历史路径元数据损坏。"); }
      if (!row || row.encoding !== "json" || !Array.isArray(stored) || stored.some(item => typeof item !== "string" || !item)) throw new StateError("历史路径元数据损坏。");
    } else if (tableExists(connection, "gateway_path_roots")) stored = (connection.prepare("SELECT root FROM gateway_path_roots").all() as { root: string }[]).map(row => row.root);
    return [...new Set([resolve(root), ...stored])];
  } finally { if (!db) connection.close(); }
}
export function addPathRoots(db: DatabaseSync, roots: string[]): void {
  if (roots.some(root => typeof root !== "string" || !root)) throw new StateError("历史路径元数据无效。");
  if (schemaVersion(db) === 2) {
    const row = getState(db, ROOTS_KEY);
    let old: unknown;
    try { old = JSON.parse(row?.value ?? "null"); } catch { throw new StateError("历史路径元数据损坏。"); }
    if (!Array.isArray(old) || old.some(root => typeof root !== "string" || !root)) throw new StateError("历史路径元数据损坏。");
    putState(db, { key: ROOTS_KEY, category: "metadata", value: JSON.stringify([...new Set([...old, ...roots])]) });
  } else {
    db.exec("CREATE TABLE IF NOT EXISTS gateway_path_roots(root TEXT PRIMARY KEY)");
    for (const root of roots) db.prepare("INSERT OR IGNORE INTO gateway_path_roots(root) VALUES(?)").run(root);
  }
}
const PREFIX = "gateway-data:";
/** Transform only attachment path fields, never chat text, prompts, URLs or credentials. */
export function references<T>(value: T, root: string, direction: "store" | "load", roots = [resolve(root)]): T {
  const walk = (item: unknown, field = ""): unknown => {
    if (Array.isArray(item)) return item.map(value => walk(value));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, walk(value, key)]));
    if (typeof item !== "string" || !["path", "localPath"].includes(field)) return item;
    let key: string | undefined;
    if (item.startsWith(PREFIX)) key = item.slice(PREFIX.length);
    else for (const origin of roots) {
      const normal = item.replaceAll("\\", "/"), base = origin.replaceAll("\\", "/").replace(/\/$/, "") + "/";
      if (normal.startsWith(base + "media/")) { key = normal.slice(base.length); break; }
    }
    if (!key) return item;
    if (!key.startsWith("media/") || key.split("/").some(x => !x || x === "." || x === "..") || key.includes("\\") || key.includes(":")) throw new StateError("附件引用无效。");
    return direction === "store" ? PREFIX + key : join(root, ...key.split("/"));
  };
  return walk(value) as T;
}
export function outside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
}
export function readDocument(file: string): { managed: boolean; value?: string } {
  const entry = address(file);
  if (!entry || !databasePresent(entry.root)) return { managed: false };
  const db = openDatabase(mainPath(entry.root), true);
  try {
    if (!activeDatabase(db)) return { managed: false };
    if (schemaVersion(db) === 2) {
      if (entry.key === CORE_KEY) return { managed: true, value: (db.prepare("SELECT body FROM context WHERE kind='core' AND id='main'").get() as {body:string}|undefined)?.body };
      if (entry.key === PERSONA_KEY) {
        const value = readPersonaDocument(db);
        if (!value) throw new StateError("数据库中的 Persona 缺失；不会回退默认预设。");
        return { managed: true, value: JSON.stringify(value) };
      }
    }
    const row = getState(db, entry.key);
    if (!row) return { managed: true };
    if (row.encoding !== "json") throw new StateError("此状态文档不能按 JSON 读取。");
    return { managed: true, value: entry.key === CORE_KEY ? row.value
      : JSON.stringify(references(JSON.parse(row.value), entry.root, "load", pathRoots(entry.root, db))) };
  } finally { db.close(); }
}
export function writeDocument(file: string, value: unknown): boolean {
  const entry = address(file);
  if (!entry || !centralEnabled(entry.root)) return false;
  const db = openDatabase(mainPath(entry.root));
  try {
    if (schemaVersion(db) === 2 && entry.key === PERSONA_KEY) { writePersonaDocument(db, value); return true; }
    if (entry.key === CORE_KEY) throw new StateError("Core 必须经专用校验接口修改。");
    const text = JSON.stringify(references(value, entry.root, "store", pathRoots(entry.root, db)));
    if (text === undefined) throw new StateError("持久状态不可为空。");
    putState(db, { key: entry.key, value: text });
    return true;
  } finally { db.close(); }
}
export function removeDocument(file: string, archiveKey?: string): boolean {
  const entry = address(file);
  if (!entry || !centralEnabled(entry.root)) return false;
  const db = openDatabase(mainPath(entry.root));
  try {
    if ([CORE_KEY, PERSONA_KEY].includes(entry.key)) throw new StateError("正式上下文不能经通用删除入口移除。");
    transaction(db, () => {
      if (archiveKey) {
        if (!managedKey(archiveKey)) throw new StateError("无效的恢复归档路径。");
        if (getState(db, archiveKey)) throw new StateError("恢复归档已存在；拒绝覆盖。");
        const prior = getState(db, entry.key);
        if (prior) putState(db, { key: archiveKey, value: prior.value, category: prior.category, encoding: prior.encoding, updatedAt: prior.updated_at });
      }
      db.prepare("DELETE FROM gateway_state WHERE key=?").run(entry.key);
    });
    return true;
  } finally { db.close(); }
}
