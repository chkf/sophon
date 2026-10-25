import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getState, putState, schemaVersion, RECENT_DELETED_KEY } from "../state/database.js";

export type ConversationState = "Pending" | "Ongoing" | "Done";

export interface RecentEntry {
  id: string;
  body: string;
  conversationState: ConversationState | null;
  stateDate: string | null;
  eventAt: string | null;
  sourceId: string | null;
  revision: number;
  updatedAt: string;
}
export type RecentChange = { id: string; expectedRevision: number; body?: string;
  conversationState?: ConversationState | null; stateDate?: string | null; eventAt?: string | null };
export type RecentCreate = { id?: string; body: string; conversationState?: ConversationState | null;
  stateDate?: string | null; eventAt?: string | null; sourceId?: string | null };
export type RecentDelete = { id: string; expectedRevision: number };
export interface RecentDeletion { id: string; sourceId: string | null; revision: number; deletedAt: string }
export { RECENT_DELETED_KEY } from "../state/database.js";
export const MAX_RECENT_DELETE = 20;
/** A replay of a known deleted identity is not a fresh topic and must not resurrect it. */
export class RecentDeletedError extends Error {
  constructor(public readonly deletion: RecentDeletion) {
    super("该 Recent 已删除，不会因重复调用重新创建。"); this.name = "RecentDeletedError";
  }
}
const conversationStates = new Set(["Pending", "Ongoing", "Done"]);
function optionalState(value: string | null | undefined, allowed: Set<string>): void {
  if (value !== undefined && value !== null && !allowed.has(value)) throw new Error("Unknown state; ask the owner before importing.");
}
function validDate(value: string | null | undefined): void {
  if (value === undefined || value === null) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("State date must be YYYY-MM-DD or null.");
  const [y, m, d] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() + 1 !== m || parsed.getUTCDate() !== d) throw new Error("Invalid state calendar date.");
}
function validEventAt(value: string | null | undefined): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) throw new Error("Event time requires explicit ISO 8601 timezone.");
}
function required(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing " + name);
}
type RecentRow = { id: string; body: string; conversation_state: ConversationState | null; state_date: string | null; event_at: string | null; source_id: string | null; revision: number; updated_at: string };
function recent(row: RecentRow): RecentEntry {
  return { id: row.id, body: row.body, conversationState: row.conversation_state, stateDate: row.state_date, eventAt: row.event_at, sourceId: row.source_id, revision: row.revision, updatedAt: row.updated_at };
}
/** Conservative local knowledge store: only formal Gateway may open it.
 * This store owns local Recent entries. External services remain independent.
 * Existing external records and conversation history remain untouched.
 */
export class LocalKnowledgeStore {
  private readonly db: DatabaseSync;
  private readonly ownsConnection: boolean;
  readonly supportsContextTools: boolean;
  private readonly table: "context" | "recent_entries";
  private readonly kindFilter: string;
  constructor(readonly dataDir: string, mode: "formal", connection?: DatabaseSync) {
    if (mode !== "formal") throw new Error("Ephemeral sessions cannot access formal knowledge.");
    const path = join(dataDir, "sessions", "gateway.sqlite");
    if (!existsSync(path)) throw new Error("Existing Gateway SQLite database required; refusing to create a parallel store.");
    this.db = connection ?? new DatabaseSync(path);
    this.ownsConnection = !connection;
    try {
      this.supportsContextTools = schemaVersion(this.db) === 2;
      this.table = this.supportsContextTools ? "context" : "recent_entries";
      this.kindFilter = this.supportsContextTools ? "kind='recent' AND " : "";
      if (!connection) this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      if (!this.supportsContextTools) this.db.exec([
        `CREATE TABLE IF NOT EXISTS recent_entries (
          id TEXT PRIMARY KEY, body TEXT NOT NULL,
          conversation_state TEXT CHECK(conversation_state IN ('Pending','Ongoing','Done')),
          state_date TEXT, event_at TEXT, source_id TEXT,
          revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)`,
        "CREATE INDEX IF NOT EXISTS recent_by_state ON recent_entries(conversation_state,state_date)",
        "CREATE UNIQUE INDEX IF NOT EXISTS recent_source_unique ON recent_entries(source_id) WHERE source_id IS NOT NULL",
        `CREATE TABLE IF NOT EXISTS knowledge_review_progress (
          scope TEXT PRIMARY KEY, through_seq INTEGER NOT NULL CHECK(through_seq >= -1),
          updated_at TEXT NOT NULL)`,
      ].join(";") + ";");
      if (this.supportsContextTools) {
        const deleted = this.deletions();
        const deletedIds = new Set(deleted.map(entry => entry.id));
        const deletedSources = new Set(deleted.map(entry => entry.sourceId).filter(value => value !== null));
        const rows = this.db.prepare("SELECT id,source_id FROM context WHERE kind='recent'").all() as { id: string; source_id: string | null }[];
        if (rows.some(row => deletedIds.has(row.id) || (row.source_id !== null && deletedSources.has(row.source_id)))) {
          throw new Error("Recent 删除凭据与有效条目冲突。");
        }
      }
    } catch (error) { if (this.ownsConnection) this.db.close(); throw error; }
  }
  close(): void { if (this.ownsConnection) this.db.close(); }
  private tx<T>(run: () => T): T {
    // SAVEPOINT composes with an explicitly supplied caller transaction.
    const savepoint = "recent_" + randomUUID().replaceAll("-", "");
    this.db.exec("SAVEPOINT " + savepoint);
    try { const result = run(); this.db.exec("RELEASE " + savepoint); return result; }
    catch (error) { try { this.db.exec("ROLLBACK TO " + savepoint + "; RELEASE " + savepoint); } catch { /* preserve original */ } throw error; }
  }
  private deletions(): RecentDeletion[] {
    if (!this.supportsContextTools) return [];
    const row = getState(this.db, RECENT_DELETED_KEY);
    if (!row) return [];
    if (row.encoding !== "json" || row.category !== "metadata") throw new Error("Recent 删除凭据格式无效。");
    let value: unknown;
    try { value = JSON.parse(row.value); } catch { throw new Error("Recent 删除凭据不可读取。"); }
    const data = value as { version?: unknown; entries?: unknown } | null;
    if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).some(key => !["version", "entries"].includes(key)) ||
      data.version !== 1 || !Array.isArray(data.entries)) throw new Error("Recent 删除凭据版本无效。");
    const ids = new Set<string>(), sources = new Set<string>();
    for (const entry of data.entries) {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id.trim() ||
        (entry.sourceId !== null && (typeof entry.sourceId !== "string" || !entry.sourceId.trim())) ||
        !Number.isSafeInteger(entry.revision) || entry.revision < 1 ||
        typeof entry.deletedAt !== "string" || !Number.isFinite(Date.parse(entry.deletedAt)) ||
        Object.keys(entry).some(key => !["id", "sourceId", "revision", "deletedAt"].includes(key)) ||
        ids.has(entry.id) || (entry.sourceId !== null && sources.has(entry.sourceId))) throw new Error("Recent 删除凭据内容无效。");
      ids.add(entry.id); if (entry.sourceId !== null) sources.add(entry.sourceId);
    }
    return data.entries as RecentDeletion[];
  }
  createRecent(input: RecentCreate): RecentEntry {
    return this.tx(() => this.createRecentTx(input));
  }
  private createRecentTx(input: RecentCreate): RecentEntry {
    if (input.id !== undefined) required(input.id, "recent ID");
    if (input.sourceId != null) required(input.sourceId, "trusted source ID");
    const deleted = this.deletions().find(item => item.id === input.id || (input.sourceId != null && item.sourceId === input.sourceId));
    if (deleted) throw new RecentDeletedError(deleted);
    required(input.body, "recent body");
    optionalState(input.conversationState, conversationStates);
    validDate(input.stateDate);
    validEventAt(input.eventAt);
    if (input.conversationState === null && input.stateDate !== null && input.stateDate !== undefined) {
      throw new Error("An unknown conversation state cannot have a status-change date.");
    }
    if (input.sourceId != null || input.id !== undefined) {
      const rows = this.db.prepare(`SELECT * FROM ${this.table} WHERE ${this.kindFilter}(source_id=? OR id=?)`)
        .all(input.sourceId ?? null, input.id ?? null) as RecentRow[];
      if (rows.length > 1) throw new Error("Recent identity and source conflict.");
      const prior = rows[0];
      if (prior) {
        if ((input.id !== undefined && prior.id !== input.id) ||
            (input.sourceId != null && prior.source_id !== input.sourceId) || prior.body !== input.body ||
            prior.conversation_state !== (input.conversationState ?? null) ||
            prior.state_date !== (input.stateDate ?? null) ||
            prior.event_at !== (input.eventAt ?? null)) {
          throw new Error("Same inbound create operation has changed; refusing duplicate or overwrite.");
        }
        return recent(prior);
      }
    }
    const id = input.id ?? "recent:" + randomUUID();
    this.db.prepare(`INSERT INTO ${this.table}(${this.supportsContextTools ? "kind," : ""}id,body,conversation_state,state_date,event_at,source_id,updated_at)
      VALUES(${this.supportsContextTools ? "'recent'," : ""}?,?,?,?,?,?,?)`)
      .run(id, input.body, input.conversationState ?? null, input.stateDate ?? null,
        input.eventAt ?? null, input.sourceId ?? null, new Date().toISOString());
    return this.getRecent(id)!;
  }
  getRecent(id: string): RecentEntry | undefined {
    const row = this.db.prepare(`SELECT * FROM ${this.table} WHERE ${this.kindFilter}id=?`).get(id) as RecentRow | undefined;
    return row && recent(row);
  }
  listRecent(): RecentEntry[] {
    return (this.db.prepare(`SELECT * FROM ${this.table} WHERE ${this.kindFilter}1 ORDER BY updated_at DESC`).all() as RecentRow[]).map(recent);
  }
  /** Version the complete store, not just the bounded summary shown to a model.
   * Receipts also invalidate a chain when a tool created and deleted an entry
   * during one turn, leaving the active rows identical to the prior snapshot. */
  getRecentRevision(): string {
    const hash = createHash("sha256");
    for (const row of this.db.prepare(`SELECT id,body,conversation_state,state_date,event_at,source_id,revision,updated_at
      FROM ${this.table} WHERE ${this.kindFilter}1 ORDER BY id`).iterate()) hash.update(JSON.stringify(row) + "\n");
    hash.update(JSON.stringify(this.deletions()));
    return "sha256:" + hash.digest("hex");
  }
  private updateRecentTx(change: RecentChange): void {
    const current = this.getRecent(change.id);
    if (!current) throw new Error("Recent target not found.");
    if (current.revision !== change.expectedRevision) throw new Error("Stale Recent revision, refusing lost update.");
    optionalState(change.conversationState, conversationStates);
    if (change.stateDate !== undefined) validDate(change.stateDate);
    if (change.eventAt !== undefined) validEventAt(change.eventAt);
    const newState = change.conversationState === undefined ? current.conversationState : change.conversationState;
    const stateChanged = newState !== current.conversationState;
    if (!stateChanged && change.stateDate !== undefined && change.stateDate !== current.stateDate) {
      throw new Error("State date changes only when conversation state changes.");
    }
    if (stateChanged && change.stateDate === undefined) {
      throw new Error("Explicit state date or null required when changing conversation state.");
    }
    const body = change.body ?? current.body;
    required(body, "recent body");
    this.db.prepare(`UPDATE ${this.table} SET body=?,conversation_state=?,state_date=?,event_at=?,revision=revision+1,updated_at=? WHERE ${this.kindFilter}id=? AND revision=?`)
      .run(body, newState, stateChanged ? change.stateDate ?? null : current.stateDate,
        change.eventAt === undefined ? current.eventAt : change.eventAt,
        new Date().toISOString(), change.id, change.expectedRevision);
  }
  updateRecent(change: RecentChange): RecentEntry {
    return this.tx(() => { this.updateRecentTx(change); return this.getRecent(change.id)!; });
  }
  getReviewCursor(scope: string): number {
    required(scope, "review scope");
    if (this.supportsContextTools) {
      const convKey = this.reviewConversationKey(scope);
      const row = this.db.prepare("SELECT recent_review_through_seq AS through_seq FROM conversations WHERE key=?")
        .get(convKey) as { through_seq: number } | undefined;
      if (!row) throw new Error("Recent review conversation not found.");
      return row.through_seq;
    }
    const row = this.db.prepare("SELECT through_seq FROM knowledge_review_progress WHERE scope=?").get(scope) as { through_seq: number } | undefined;
    return row?.through_seq ?? -1;
  }
  private reviewConversationKey(scope: string): string {
    if (!scope.startsWith("formal:")) throw new Error("Only formal review scope is supported.");
    const key = scope.slice("formal:".length);
    if (!/^(telegram|wechat):[^:]+$/.test(key)) throw new Error("Invalid formal conversation scope.");
    return key;
  }
  /** Apply updates and advance review position in one SQLite transaction.
   * Caller must verify that the reviewed message interval is complete.
   * Scope must be a formal session key; never pass ephemeral session data.
   */
  commitReview(scope: string, expectedCursor: number, throughSeq: number, changes: RecentChange[],
    creates: Omit<RecentCreate, "sourceId">[] = [], deletes: RecentDelete[] = []): "committed" | "already" {
    required(scope, "review scope");
    if (!scope.startsWith("formal:")) throw new Error("Only formal review scope is supported.");
    if (!Number.isSafeInteger(expectedCursor) || expectedCursor < -1 || !Number.isSafeInteger(throughSeq) || throughSeq < expectedCursor) {
      throw new Error("Invalid review sequence interval.");
    }
    return this.tx(() => {
      const current = this.getReviewCursor(scope);
      if (throughSeq <= current) return "already" as const;
      if (current !== expectedCursor) throw new Error("Review cursor advanced concurrently; retry from latest position.");
      const convKey = scope.slice("formal:".length);
      if (!/^(telegram|wechat):[^:]+$/.test(convKey)) throw new Error("Invalid formal conversation scope.");
      const row = this.db.prepare("SELECT count(*) AS n, min(seq) AS first_seq, max(seq) AS last_seq FROM messages WHERE conv_key=? AND seq>? AND seq<=?")
        .get(convKey, current, throughSeq) as { n: number; first_seq: number | null; last_seq: number | null };
      const expected = throughSeq - current;
      if (row.n !== expected || row.first_seq !== current + 1 || row.last_seq !== throughSeq) {
        throw new Error("Cannot advance Recent review cursor across missing or unseen messages.");
      }
      if (changes.length > 12 || creates.length > 12 || deletes.length > 12) throw new Error("Review proposal exceeds bounded change count.");
      const targets = [...changes, ...deletes].map(item => item.id);
      if (new Set(targets).size !== targets.length) throw new Error("Review targets overlap or repeat.");
      if (deletes.length && !this.supportsContextTools) throw new Error("Review deletion requires the current database schema.");
      if (deletes.length) this.deleteRecentTx(deletes);
      for (const change of changes) this.updateRecentTx(change);
      const bodies = new Set<string>();
      for (const [index, create] of creates.entries()) {
        const body = create.body.trim();
        if (bodies.has(body) || this.db.prepare(`SELECT 1 FROM ${this.table} WHERE ${this.kindFilter}body=?`).get(body)) {
          throw new Error("Review proposal contains a duplicate Recent topic.");
        }
        bodies.add(body);
        const sourceId = "review:" + createHash("sha256").update(JSON.stringify([scope, expectedCursor, throughSeq, index])).digest("hex");
        try { this.createRecentTx({ ...create, sourceId }); }
        catch (error) { if (!(error instanceof RecentDeletedError)) throw error; }
      }
      if (this.supportsContextTools) {
        const updated = this.db.prepare(`UPDATE conversations SET recent_review_through_seq=?,recent_review_updated_at=?
          WHERE key=? AND recent_review_through_seq=?`).run(throughSeq, new Date().toISOString(), convKey, current);
        if (Number(updated.changes) !== 1) throw new Error("Review cursor advanced concurrently.");
      } else this.db.prepare(`INSERT INTO knowledge_review_progress(scope,through_seq,updated_at) VALUES(?,?,?)
        ON CONFLICT(scope) DO UPDATE SET through_seq=excluded.through_seq,updated_at=excluded.updated_at`)
        .run(scope, throughSeq, new Date().toISOString());
      return "committed" as const;
    });
  }
  /** Immediate bounded deletion is independent of the automatic Done retention policy. */
  deleteRecent(targets: RecentDelete[]): { deleted: string[]; alreadyDeleted: string[] } {
    if (!this.supportsContextTools) throw new Error("Recent 删除需要显式迁移至六表数据库后使用。");
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_RECENT_DELETE) throw new Error("Recent 删除每次需要 1–20 个明确条目。");
    return this.tx(() => this.deleteRecentTx(targets));
  }
  private deleteRecentTx(targets: RecentDelete[]): { deleted: string[]; alreadyDeleted: string[] } {
    const seen = new Set<string>();
    const tombstones = this.deletions();
    const result = { deleted: [] as string[], alreadyDeleted: [] as string[] };
    const selected: RecentEntry[] = [];
    for (const target of targets) {
      required(target.id, "recent ID");
      if (seen.has(target.id) || !Number.isSafeInteger(target.expectedRevision) || target.expectedRevision < 1) throw new Error("Recent 删除 ID 重复或修订号无效。");
      seen.add(target.id);
      const current = this.getRecent(target.id), prior = tombstones.find(item => item.id === target.id);
      if (current && prior) throw new Error("Recent 删除凭据与有效条目冲突。");
      if (!current) {
        if (!prior) throw new Error("Recent target not found.");
        if (prior.revision !== target.expectedRevision) throw new Error("Stale Recent revision, refusing lost delete.");
        result.alreadyDeleted.push(target.id); continue;
      }
      if (current.revision !== target.expectedRevision) throw new Error("Stale Recent revision, refusing lost delete.");
      selected.push(current);
    }
    const deletedAt = new Date().toISOString();
    for (const current of selected) {
      if (current.sourceId !== null && tombstones.some(item => item.sourceId === current.sourceId)) throw new Error("Recent 来源与删除凭据冲突。");
      const removed = this.db.prepare("DELETE FROM context WHERE kind='recent' AND id=? AND revision=?")
        .run(current.id, current.revision);
      if (Number(removed.changes) !== 1) throw new Error("Stale Recent revision, refusing lost delete.");
      tombstones.push({ id: current.id, sourceId: current.sourceId, revision: current.revision, deletedAt });
      result.deleted.push(current.id);
    }
    if (selected.length) putState(this.db, { key: RECENT_DELETED_KEY, category: "metadata", encoding: "json",
      value: JSON.stringify({ version: 1, entries: tombstones }), updatedAt: deletedAt });
    for (const id of [...result.deleted, ...result.alreadyDeleted]) {
      if (this.getRecent(id)) throw new Error("Recent 删除回读失败。");
    }
    return result;
  }
}
