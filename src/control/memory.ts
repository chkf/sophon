import type { DatabaseSync } from 'node:sqlite';
import { memoryMarker } from '../memory/schema.js';
import { MemoryStore } from '../memory/store.js';
import { bootstrapStatus } from '../memory/bootstrap.js';
import { activation } from '../memory/weights.js';
import { messageRevision, type SessionStore } from '../sessions/store.js';
import { ControlDataError } from './data.js';

export interface ControlMemoryOptions {
  ownerId?: string;
  enabled?: boolean;
  runtimeStatus?: () => string | undefined;
}
function invalid() { return new ControlDataError('invalid_request', 400, '无效的记忆图请求。'); }
function text(value: unknown, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw invalid();
  return value;
}
function page(input: Record<string, unknown>) {
  const offset = input.offset ?? 0, limit = input.limit ?? 30;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 ||
      typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw invalid();
  return { offset, limit };
}

/** Owner-scoped, read-only browsing; never runs migration, models or graph maintenance. */
export class ControlMemory {
  private store?: MemoryStore;
  private readonly scope?: string;
  constructor(private readonly db: DatabaseSync, private readonly options: ControlMemoryOptions = {}, private readonly sessions: SessionStore) {
    if (options.ownerId && /^\d+$/.test(options.ownerId)) this.scope = 'telegram:' + options.ownerId;
  }
  private graph(): MemoryStore {
    if (!this.scope || memoryMarker(this.db)?.version !== 2) {
      throw new ControlDataError('memory_unavailable', 409, '记忆图尚未配置或需要停机迁移。');
    }
    return this.store ??= new MemoryStore(this.db, this.scope);
  }
  overview() {
    const marker = memoryMarker(this.db);
    const available = Boolean(this.scope && marker?.version === 2);
    const runtimeStatus=this.options.runtimeStatus?.();
    if (!available) return { available, enabled: this.options.enabled === true, version: marker?.version ?? 0, runtimeStatus };
    const store = this.graph(), progress = bootstrapStatus(store);
    const counts = Object.fromEntries(this.db.prepare('SELECT status,count(*) n FROM memory_nodes WHERE owner_scope=? GROUP BY status').all(this.scope!)
      .map(row => [String(row.status), Number(row.n)]));
    counts.active = Number(this.db.prepare(`SELECT count(*) n FROM memory_nodes n WHERE n.owner_scope=? AND n.status='active'
      AND EXISTS (SELECT 1 FROM memory_topic_memberships m JOIN memory_topics t ON t.id=m.topic_id WHERE m.node_id=n.id AND m.status='active' AND t.status='active' AND t.owner_scope=n.owner_scope)`).get(this.scope!)!.n);
    const topics = Number(this.db.prepare("SELECT count(*) n FROM memory_topics WHERE owner_scope=? AND status='active'").get(this.scope!)!.n);
    const problems = this.db.prepare(`SELECT status,error_code,attempts,run_after,updated_at FROM memory_jobs
      WHERE owner_scope=? AND status IN ('failed','retry') ORDER BY updated_at DESC,id LIMIT 5`).all(this.scope!);
    return { available, enabled: this.options.enabled === true, version: marker!.version, revision: marker!.revision,
      counts, topics, progress, problems, runtimeStatus };
  }
  private topic(id: string) {
    const row = this.db.prepare("SELECT id,parent_id,name,description FROM memory_topics WHERE id=? AND owner_scope=? AND status='active'").get(id, this.scope!);
    if (!row) throw new ControlDataError('not_found', 404, '主题不存在或已归档。');
    return row;
  }
  topics(input: Record<string, unknown>) {
    this.graph(); const { offset, limit } = page(input);
    const parent = input.parentId == null ? null : text(input.parentId);
    const path = []; let cursor = parent;
    while (cursor) {
      const row = this.topic(cursor); path.unshift({ id: row.id, name: row.name });
      if (path.length > 6) throw invalid();
      cursor = row.parent_id as string | null;
    }
    const total = Number(this.db.prepare("SELECT count(*) n FROM memory_topics WHERE owner_scope=? AND parent_id IS ? AND status='active'").get(this.scope!, parent)!.n);
    const items = this.db.prepare(`SELECT t.id,t.name,t.description,
      (SELECT count(*) FROM memory_topics c WHERE c.parent_id=t.id AND c.owner_scope=t.owner_scope AND c.status='active') children,
      (SELECT count(*) FROM memory_topic_memberships m JOIN memory_nodes n ON n.id=m.node_id WHERE m.topic_id=t.id AND m.status='active' AND n.status='active' AND n.owner_scope=t.owner_scope) memories
      FROM memory_topics t WHERE t.owner_scope=? AND t.parent_id IS ? AND t.status='active' ORDER BY t.name,t.id LIMIT ? OFFSET ?`).all(this.scope!, parent, limit, offset);
    const related = parent ? this.db.prepare(`SELECT t.id,t.name,e.strength FROM memory_topic_edges e JOIN memory_topics t
      ON t.id=CASE WHEN e.topic_a=? THEN e.topic_b ELSE e.topic_a END WHERE (e.topic_a=? OR e.topic_b=?)
      AND t.owner_scope=? AND t.status='active' ORDER BY e.strength DESC,t.id LIMIT 12`).all(parent, parent, parent, this.scope!) : [];
    return { items, path, related, total, nextOffset: offset + items.length < total ? offset + items.length : null };
  }
  nodes(input: Record<string, unknown>) {
    const store = this.graph(), { offset, limit } = page(input);
    if (input.query !== undefined && input.query !== '') {
      const query = text(input.query, 500);
      return { items: store.search(query, 2, 16), nextOffset: null, search: true };
    }
    const topic = input.topicId == null ? null : text(input.topicId);
    if (topic) this.topic(topic);
    const status = input.status ?? 'active';
    if (typeof status !== 'string' || !['active', 'archived', 'stale'].includes(status)) throw invalid();
    const membership = (condition: string) => `EXISTS (SELECT 1 FROM memory_topic_memberships m JOIN memory_topics t ON t.id=m.topic_id WHERE m.node_id=n.id AND t.owner_scope=n.owner_scope${topic ? ' AND m.topic_id=?' : ''} AND ${condition})`;
    const filter = status === 'active' ? `n.status='active' AND ${membership("m.status='active' AND t.status='active'")}`
      : status === 'archived' ? `n.status<>'stale' AND ${membership("(m.status IN ('covered','archived') OR n.status='archived')")}`
      : `n.status='stale'${topic ? ' AND ' + membership('1=1') : ''}`;
    const params = [this.scope!, ...(topic ? [topic] : [])];
    const items = this.db.prepare(`SELECT n.id,n.kind,n.status,n.gist,n.importance,n.activation_base,n.reinforced_at,n.half_life_days,n.created_at,
      (SELECT substr(c.body,1,200) FROM memory_recent_links r JOIN context c ON c.kind='recent' AND c.id=r.recent_id AND c.revision=r.recent_revision WHERE r.node_id=n.id) recent_body,
      (SELECT c.conversation_state FROM memory_recent_links r JOIN context c ON c.kind='recent' AND c.id=r.recent_id AND c.revision=r.recent_revision WHERE r.node_id=n.id) recent_state
      FROM memory_nodes n WHERE n.owner_scope=? AND ${filter} ORDER BY n.created_at DESC,n.id LIMIT ? OFFSET ?`).all(...params, limit + 1, offset);
    const more = items.length > limit;
    return { items: items.slice(0, limit).map(row => {
      const { activation_base, reinforced_at, half_life_days, recent_body, recent_state, ...rest } = row;
      const protectedRecent = recent_body != null && recent_state !== 'Done' && row.status === 'active';
      return { ...rest, gist: recent_body == null ? row.gist : String(recent_body).slice(0, 200),
        activation: protectedRecent ? 1 : activation(Number(activation_base), String(reinforced_at), Number(half_life_days), Date.now()),
        protected: protectedRecent };
    }), nextOffset: more ? offset + limit : null, search: false };
  }
  async node(input: Record<string, unknown>) {
    this.graph(); const id = text(input.id), { offset, limit } = page(input);
    const row = this.db.prepare('SELECT id,kind,status,revision,gist,summary,detail,importance,activation_base,half_life_days,reinforced_at,created_at FROM memory_nodes WHERE id=? AND owner_scope=?').get(id, this.scope!);
    if (!row) throw new ControlDataError('not_found', 404, '记忆不存在或已移除。');
    const recent = this.db.prepare(`SELECT c.id,c.body,c.conversation_state FROM memory_recent_links r JOIN context c
      ON c.kind='recent' AND c.id=r.recent_id AND c.revision=r.recent_revision WHERE r.node_id=? AND r.owner_scope=?`).get(id, this.scope!);
    const sources = this.db.prepare(`SELECT m.rowid,m.seq FROM memory_sources s JOIN messages m ON m.rowid=s.message_rowid
      WHERE s.node_id=? AND m.conv_key=? ORDER BY m.seq LIMIT ? OFFSET ?`).all(id, this.scope!, limit + 1, offset);
    const memberships = this.db.prepare(`SELECT t.id,t.name,m.status FROM memory_topic_memberships m JOIN memory_topics t ON t.id=m.topic_id
      WHERE m.node_id=? AND t.owner_scope=? ORDER BY t.name LIMIT 50`).all(id, this.scope!);
    const excerpts = [];
    for (const source of sources.slice(0, limit)) {
      const message = (await this.sessions.readRange('telegram', this.options.ownerId!, Number(source.seq), 1))[0];
      if (message) excerpts.push({ conversationKey: this.scope, index: source.seq, revision: messageRevision(message),
        role: message.role, at: message.at, content: message.content.slice(0, 600), truncated: message.content.length > 600 });
    }
    const current = this.db.prepare('SELECT revision,status FROM memory_nodes WHERE id=? AND owner_scope=?').get(id, this.scope!);
    if (!current || current.revision !== row.revision || current.status !== row.status || sources.slice(0, limit).some(source =>
      !this.db.prepare('SELECT 1 FROM messages WHERE rowid=? AND seq=? AND conv_key=?').get(source.rowid!, source.seq!, this.scope!))) {
      throw new ControlDataError('revision_conflict', 409, '记忆来源已变化，请重新读取。');
    }
    return { ...row, ...(row.status === 'stale' ? { gist: '', summary: '', detail: '' } : {}),
      activation: recent && recent.conversation_state !== 'Done' && row.status === 'active' ? 1 : activation(Number(row.activation_base), String(row.reinforced_at), Number(row.half_life_days), Date.now()),
      recent: recent ? { id: recent.id, body: String(recent.body).slice(0, 6000), truncated: String(recent.body).length > 6000, state: recent.conversation_state } : null,
      memberships, sources: excerpts,
      nextOffset: sources.length > limit ? offset + limit : null };
  }
}

