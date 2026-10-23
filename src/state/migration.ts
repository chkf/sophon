import { backup, DatabaseSync } from "node:sqlite";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, writeFile, statfs } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { validateCore, loadCore } from "../core/loader.js";
import { acquireInstanceLock } from "../service/instance-lock.js";
import type { CredentialEncryptionAdapter } from "../runtime/siwc/sdk.js";
import { CORE_KEY, LEGACY_STATE_VERSION, StateError, activeDatabase, createStateSchema, integrity, mainPath,
  managedKey, openDatabase, outside, pathRoots, references, tableExists, transaction, schemaVersion } from "./database.js";
import { assertDeletionMetadata, assertIlinkReceiptMetadata, downgradeSchemaDatabase, inspectSchemaMigration, migrateSchemaDatabase, type SchemaPreview } from "./schema.js";

export const AUXILIARY = [
  { file: "channels/ilink.sqlite", tables: { state: "ilink_state", events: "ilink_events" } },
  { file: "voice/voice.sqlite", tables: { jobs: "voice_jobs", voice_text: "voice_text", status: "voice_status" } },
];
export function createAuxiliarySchema(db: DatabaseSync): void {
  if (schemaVersion(db) === 2) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ilink_state(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ilink_events(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS voice_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,day TEXT NOT NULL,result TEXT,error TEXT);
    CREATE TABLE IF NOT EXISTS voice_text(token TEXT PRIMARY KEY,chat TEXT NOT NULL,message INTEGER,text TEXT NOT NULL,page INTEGER);
    CREATE TABLE IF NOT EXISTS voice_status(kind TEXT PRIMARY KEY,note TEXT NOT NULL);`);
}
export async function safeSnapshot(source: string, target: string): Promise<void> {
  if (existsSync(target)) throw new StateError("快照目标已存在；拒绝覆盖。");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const db = openDatabase(source, true);
  try { await backup(db, target, { rate: 128 }); } finally { db.close(); }
  const copy = new DatabaseSync(target);
  try { integrity(copy); copy.exec("PRAGMA journal_mode=DELETE"); } finally { copy.close(); }
  await chmod(target, 0o600);
}
async function files(root: string, base = ""): Promise<string[]> {
  const found: string[] = [];
  for (const item of await readdir(join(root, base), { withFileTypes: true })) {
    const key = base ? base + "/" + item.name : item.name;
    if (item.isSymbolicLink()) throw new StateError("状态目录包含符号链接；请先明确实际文件范围，不能跳过后切换权威来源。");
    if (item.isDirectory() && !key.startsWith(".") && !key.includes("gateway-instance.lock")) found.push(...await files(root, key));
    else if (item.isFile() && managedKey(key)) found.push(key);
  }
  return found;
}
export function validateDocument(key: string, text: string): void {
  if (key === CORE_KEY) return validateCore(text);
  let value: any;
  try { value = JSON.parse(text); } catch { throw new StateError("状态 JSON 损坏，迁移已停止。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StateError("状态必须为 JSON 对象。");
  if (key === "runtime/persona.json" && (![1, 2].includes(value.version) || typeof value.active !== "string" ||
      !value.presets?.default || !Array.isArray(value.presets[value.active]) ||
      Object.values(value.presets).some((v: any) => !Array.isArray(v) || !v.length || v.some((x: unknown) => typeof x !== "string")))) throw new StateError("Persona 状态无效。");
  if (/runtime\/(?:(?:api|openrouter)-)?model.json$/.test(key) && (!["auto", "pinned"].includes(value.mode) || value.mode === "pinned" && typeof value.model !== "string")) throw new StateError("模型设置无效。");
  if (key === "runtime/provider.json" && !["api", "siwc", "openrouter"].includes(value.provider)) throw new StateError("Provider 设置无效。");
  if (key === "channels/active.json" && !["telegram", "wechat", "off"].includes(value.active)) throw new StateError("主动渠道无效。");
  if (key.startsWith("runtime/context/") && (value.version !== 1 || typeof value.model !== "string" || !Array.isArray(value.contextItems))) throw new StateError("运行时 checkpoint 无效。");
  if (key === "voice/settings.json" && ["asr", "tts", "proactive"].some(k => value[k] !== undefined && typeof value[k] !== "boolean")) throw new StateError("语音设置无效。");
}
function copyRows(source: DatabaseSync, target: DatabaseSync, from: string, to: string): void {
  if (!tableExists(source, from)) throw new StateError("必要数据库表缺失，迁移已停止。");
  const columns = (source.prepare(`PRAGMA table_info("${from}")`).all() as { name: string }[]).map(c => c.name);
  const expected = (target.prepare(`PRAGMA table_info("${to}")`).all() as { name: string }[]).map(c => c.name);
  if (JSON.stringify(columns) !== JSON.stringify(expected)) throw new StateError("数据库结构冲突；请离线处理，原文件保留。");
  const names = columns.map(c => '"' + c + '"').join(",");
  const insert = target.prepare(`INSERT INTO "${to}"(${names}) VALUES(${columns.map(() => "?").join(",")})`);
  for (const row of source.prepare(`SELECT ${names} FROM "${from}"`).iterate()) {
    const prior = target.prepare(`SELECT ${names} FROM "${to}" WHERE "${columns[0]}"=?`).get(row[columns[0]]);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new StateError("新旧数据库记录冲突；没有覆盖任何记录。");
    if (!prior) insert.run(...columns.map(c => row[c]));
  }
}
export async function migrateState(dataDir: string, stopped: boolean): Promise<{ changed: boolean; archive?: string; documents?: number }> {
  if (!stopped) throw new StateError("请先停止写入，再使用 --stopped 执行迁移。");
  const root = resolve(dataDir);
  const lock = await acquireInstanceLock(root);
  try {
    const check = openDatabase(mainPath(root), true);
    try {
      integrity(check);
      if (!tableExists(check, "messages") || !tableExists(check, "conversations")) throw new StateError("必须使用已有的主库；不会另建空历史库。");
      if (activeDatabase(check)) { await loadCore(root); return { changed: false }; }
    } finally { check.close(); }
    const keys = await files(root);
    if (!keys.includes(CORE_KEY)) throw new StateError("原 Core 缺失，迁移已停止。");
    const documents = new Map<string, string>();
    for (const key of keys) {
      const info = await lstat(join(root, key));
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new StateError("状态文件不安全或过大；请离线检查。");
      const text = await readFile(join(root, key), "utf8"); validateDocument(key, text); documents.set(key, text);
    }
    const archive = join(root, ".state-migration", randomUUID());
    await mkdir(archive, { recursive: true, mode: 0o700 });
    await safeSnapshot(mainPath(root), mainPath(archive));
    for (const key of keys) {
      await mkdir(dirname(join(archive, key)), { recursive: true, mode: 0o700 });
      await copyFile(join(root, key), join(archive, key)); await chmod(join(archive, key), 0o600);
    }
    for (const aux of AUXILIARY) if (existsSync(join(root, aux.file))) await safeSnapshot(join(root, aux.file), join(archive, aux.file));
    const db = openDatabase(mainPath(root));
    try {
      transaction(db, () => {
        createStateSchema(db); createAuxiliarySchema(db);
        const roots = pathRoots(root, db);
        for (const [key, text] of documents) {
          const value = key === CORE_KEY ? text : JSON.stringify(references(JSON.parse(text), root, "store", roots));
          const old = db.prepare("SELECT value FROM gateway_state WHERE key=?").get(key) as { value: string } | undefined;
          if (old && old.value !== value) throw new StateError("旧文件与数据库冲突；请导出比较后显式处理。");
          if (!old) db.prepare("INSERT INTO gateway_state VALUES(?,?,?)").run(key, value, new Date().toISOString());
        }
        for (const aux of AUXILIARY) if (existsSync(join(archive, aux.file))) {
          const source = openDatabase(join(archive, aux.file), true);
          try {
            const tables = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
            if (tables.some(t => !Object.hasOwn(aux.tables, t.name))) throw new StateError("辅助库包含未登记的表；请明确迁移边界，不会静默遗漏。");
            for (const [from, to] of Object.entries(aux.tables)) copyRows(source, db, from, to);
          }
          finally { source.close(); }
        }
        integrity(db);
        db.prepare("INSERT OR IGNORE INTO gateway_path_roots VALUES(?)").run(root);
        db.prepare("INSERT INTO gateway_state_meta VALUES(1,?,?)").run(LEGACY_STATE_VERSION, new Date().toISOString());
      });
    } finally { db.close(); }
    return { changed: true, archive, documents: documents.size };
  } finally { await lock.release(); }
}
export async function importCore(root: string, input: string): Promise<void> {
  const metadata = await lstat(input);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 256 * 1024) throw new StateError("Core 导入文件无效。");
  const text = await readFile(input, "utf8"); validateCore(text);
  const db = openDatabase(mainPath(root));
  try {
    if (!activeDatabase(db)) throw new StateError("请先迁移持久状态。");
    transaction(db, () => {
      if (schemaVersion(db) === 2) {
        if (!db.prepare("SELECT 1 FROM context WHERE kind='core' AND id='main'").get()) throw new StateError("正式 Core 缺失，请先恢复完整状态。");
        db.prepare("UPDATE context SET body=?,revision=revision+1,updated_at=? WHERE kind='core' AND id='main'").run(text,new Date().toISOString());
        if (db.prepare("SELECT body FROM context WHERE kind='core' AND id='main'").get()?.body !== text) throw new StateError("Core 写后回读失败。");
      } else {
        if (!db.prepare("SELECT 1 FROM gateway_state WHERE key=?").get(CORE_KEY)) throw new StateError("正式 Core 缺失，请先恢复完整状态。");
        db.prepare("UPDATE gateway_state SET value=?,updated_at=? WHERE key=?").run(text, new Date().toISOString(), CORE_KEY);
      }
    });
  } finally { db.close(); }
}
export async function exportCore(root: string, output: string): Promise<void> {
  const core = await loadCore(root);
  if (!outside(root, output)) throw new StateError("请导出到数据目录之外，避免覆盖回滚原件。");
  await writeFile(output, core.text, { flag: "wx", mode: 0o600 });
}
/** Fresh directory containing a consistent main DB and current old-format files. No activation. */
export async function rollbackExport(root: string, target: string, stopped: boolean, encryption?: CredentialEncryptionAdapter): Promise<void> {
  if (!stopped || !outside(root, target) || !outside(target, root)) throw new StateError("回滚导出要求停写及独立的新目录。");
  const lock = await acquireInstanceLock(root);
  try {
    await mkdir(target, { mode: 0o700 });
    await safeSnapshot(mainPath(root), mainPath(target));
    const copy = openDatabase(mainPath(target));
    try {
      if (!activeDatabase(copy)) throw new StateError("尚未完成持久状态迁移。");
      if (schemaVersion(copy) === 2) downgradeSchemaDatabase(copy);
      for (const row of copy.prepare("SELECT key,value FROM gateway_state").all() as { key: string; value: string }[]) {
        if (!managedKey(row.key)) throw new StateError("回滚路径不受支持。");
        await mkdir(dirname(join(target, row.key)), { recursive: true, mode: 0o700 });
        const text = row.key === CORE_KEY ? row.value : JSON.stringify(references(JSON.parse(row.value), root, "load", pathRoots(root, copy)), null, 2) + "\n";
        await writeFile(join(target, row.key), text, { mode: 0o600, flag: "wx" });
      }
      for (const aux of AUXILIARY) {
        const path = join(target, aux.file); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const dest = openDatabase(path);
        try {
          for (const [legacy, central] of Object.entries(aux.tables)) {
            const schema = (copy.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(central) as { sql: string }).sql;
            dest.exec(schema.replace(new RegExp('\\b' + central + '\\b'), legacy));
            copyRows(copy, dest, central, legacy);
          }
          if (aux.file === "channels/ilink.sqlite") {
            const row = dest.prepare("SELECT payload FROM state WHERE id=1").get() as { payload: string } | undefined;
            if (row) {
              if (!encryption) throw new StateError("回滚导出需要原有凭据解密接口。");
              const state = JSON.parse(await encryption.decrypt(Buffer.from(row.payload, "base64")));
              const encoded = await encryption.encrypt(JSON.stringify(references(state, root, "load", pathRoots(root, copy))));
              dest.prepare("UPDATE state SET payload=? WHERE id=1").run(Buffer.from(encoded).toString("base64"));
            }
          }
          integrity(dest); dest.exec("PRAGMA journal_mode=DELETE");
        } finally { dest.close(); }
      }
      // Older code needs absolute attachment paths, but message IDs/content/session keys stay intact.
      for (const field of ["attachments", "source"]) {
        for (const row of copy.prepare(`SELECT rowid,${field} AS value FROM messages WHERE ${field} IS NOT NULL`).all() as {rowid:number;value:string}[]) {
          copy.prepare(`UPDATE messages SET ${field}=? WHERE rowid=?`).run(JSON.stringify(references(JSON.parse(row.value), root, "load", pathRoots(root, copy))), row.rowid);
        }
      }
      // Explicit legacy authority; a future re-migration must not encounter stale central tables.
      copy.exec("DROP TABLE gateway_state_meta; DROP TABLE gateway_state; DROP TABLE ilink_state; DROP TABLE ilink_events; DROP TABLE voice_jobs; DROP TABLE voice_text; DROP TABLE voice_status;");
      copy.exec("PRAGMA journal_mode=DELETE");
    } finally { copy.close(); }
  } finally { await lock.release(); }
}

/** Read-only preview. Counts and space estimates contain no private content or credentials. */
export async function preflightSchema(dataDir:string):Promise<SchemaPreview & {availableBytes:number}> {
  const path=mainPath(resolve(dataDir)), metadata=await lstat(path);
  if(!metadata.isFile()||metadata.isSymbolicLink())throw new StateError("迁移主库必须为普通文件。");
  const db=openDatabase(path,true);
  try {
    const preview=inspectSchemaMigration(db), space=await statfs(dirname(path));
    return {...preview,availableBytes:Number(space.bavail)*Number(space.bsize)};
  } finally {db.close();}
}
/** Explicit offline v1 -> v2 transaction. The SQLite archive is not a substitute for a full external recovery point. */
export async function migrateSchema(dataDir:string,stopped:boolean):Promise<SchemaPreview & {archive?:string}> {
  if(!stopped)throw new StateError("请先停止写入，再使用 --stopped 执行六表迁移。");
  const root=resolve(dataDir), lock=await acquireInstanceLock(root);
  try {
    const preview=await preflightSchema(root);
    if(!preview.changed)return preview;
    if(preview.availableBytes<preview.requiredFreeBytes)throw new StateError("剩余空间不足以保留快照并完成迁移。");
    const archive=join(root,".schema-migration",randomUUID());
    await mkdir(archive,{recursive:true,mode:0o700});
    await safeSnapshot(mainPath(root),mainPath(archive));
    await writeFile(join(archive,"migration.json"),JSON.stringify({createdAt:new Date().toISOString(),...preview,externalRecoveryRequired:true})+"\n",{mode:0o600});
    const db=openDatabase(mainPath(root));
    try {migrateSchemaDatabase(db,root);}finally{db.close();}
    return {...preview,archive};
  } finally {await lock.release();}
}
/** Independent v1 central database export; external files and encryption key remain a separate verified recovery dependency. */
export async function schemaV1Export(root:string,target:string,stopped:boolean):Promise<void> {
  if(!stopped||!outside(root,target)||!outside(target,root))throw new StateError("旧格式导出要求停写及独立的新目录。");
  const lock=await acquireInstanceLock(root);
  try {
    const source=openDatabase(mainPath(root),true);
    try {if(schemaVersion(source)!==2)throw new StateError("六表格式导出要求源库为版本 2。");inspectSchemaMigration(source);assertDeletionMetadata(source,true);assertIlinkReceiptMetadata(source,true);}finally{source.close();}
    await mkdir(target,{mode:0o700});
    await safeSnapshot(mainPath(root),mainPath(target));
    const copy=openDatabase(mainPath(target));
    try {downgradeSchemaDatabase(copy);copy.exec("PRAGMA journal_mode=DELETE");}finally{copy.close();}
  } finally {await lock.release();}
}
