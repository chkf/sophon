import { ControlMemory, type ControlMemoryOptions } from './memory.js';
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ChannelName } from "../channels/types.js";
import { LocalCoreContextProvider, renderRecentSummary } from "../core/context.js";
import { executeLocalContextTool, LOCAL_CONTEXT_TOOL_NAMES } from "../core/tools.js";
import { LocalKnowledgeStore, type RecentEntry } from "../knowledge/store.js";
import { expressionInstruction, ExpressionStore } from "../expression/store.js";
import { SessionStore, messageRevision, type SessionMessage } from "../sessions/store.js";
import { mainPath, openDatabase, schemaVersion } from "../state/database.js";
import { readContextObservation } from "./context-observation.js";

export class ControlDataError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message); this.name = "ControlDataError";
  }
}

export interface ControlPage { offset?: number; limit?: number }
export interface ControlHistoryQuery extends ControlPage {
  conversationKey: string;
  query?: string;
  /** ISO timestamps, or calendar dates interpreted in the Gateway timezone. */
  from?: string;
  to?: string;
  around?: number;
  expectedRevision?: string;
}
export interface ControlAttachmentQuery {
  conversationKey: string;
  messageIndex: number;
  attachmentIndex: number;
  expectedRevision?: string;
}
export interface ControlAttachment {
  /** The caller streams this already-open descriptor and closes it afterwards. */
  file: FileHandle;
  path: string;
  fileName: string;
  mimeType: string;
  size: number;
}
export interface ControlConversation {
  key: string;
  channel: ChannelName;
  conversationId: string;
  count: number;
  updatedAt: string;
}
export interface ControlCore { body: string; revision: number; updatedAt: string }
export interface ControlRecentQuery extends ControlPage { query?: string; archived?: boolean }
export interface ControlRecentTarget { id: string; expectedRevision: number }
export type ControlRecent = Omit<RecentEntry, "sourceId"> & { archived: boolean };

const MAX_BODY_BYTES = 256 * 1024;
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const SAFE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
function invalid(message = "无效的控制中心请求。") { return new ControlDataError("invalid_request", 400, message); }
function missing(message = "记录不存在或已经移除。") { return new ControlDataError("not_found", 404, message); }
function number(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw invalid();
  return value;
}
function page(input: ControlPage) {
  const offset = number(input.offset, 0, 1_000_000_000);
  const limit = number(input.limit, 50, 100);
  if (!limit) throw invalid();
  return { offset, limit };
}
function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0") || (!allowEmpty && !value.trim())) throw invalid();
  return value;
}
function body(value: unknown): string {
  const result = text(value, MAX_BODY_BYTES);
  if (Buffer.byteLength(result) > MAX_BODY_BYTES || result.includes("\ufffd")) throw invalid("正文为空、损坏或超过 256 KiB。");
  return result;
}
function revision(value: unknown): number {
  const result = number(value, 0, Number.MAX_SAFE_INTEGER);
  if (!result) throw invalid("需要当前修订号，保存前请先读取内容。");
  return result;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function safeName(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim()
    ? basename(value.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 160) || fallback : fallback;
}
function within(root: string, target: string): boolean {
  const part = relative(root, target);
  return part !== "" && part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part);
}
function optionalInstant(value: unknown): string | null {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
}
function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Content operations for the authenticated owner. No provider requests or arbitrary file/state browsing. */
export class ControlData {
  readonly memory: ControlMemory;
  private readonly db: DatabaseSync;
  private readonly sessions: SessionStore;
  private readonly knowledge: LocalKnowledgeStore;
  private readonly localContext: LocalCoreContextProvider;
  private readonly ownsSessions: boolean;
  private readonly ownsKnowledge: boolean;
  private readonly timezone: string;
  private readonly editHistory?: (sessionId: string, work: () => Promise<void>) => Promise<void>;

  constructor(private readonly rootDir: string, options: {
    memory?: ControlMemoryOptions;
    sessions?: SessionStore;
    knowledge?: LocalKnowledgeStore;
    context?: LocalCoreContextProvider;
    expressions?: ExpressionStore;
    timezone?: string;
    editHistory?: (sessionId: string, work: () => Promise<void>) => Promise<void>;
  } = {}) {
    this.editHistory = options.editHistory;
    this.timezone = options.timezone ?? "UTC";
    // Validate without reading any production credentials or contacting a provider.
    new Intl.DateTimeFormat("en", { timeZone: this.timezone }).format();
    this.db = openDatabase(mainPath(rootDir), true);
    try {
      if (schemaVersion(this.db) !== 2) throw new ControlDataError("unsupported_schema", 409, "控制中心需要现有六表数据库，不会自动迁移。");
      this.sessions = options.sessions ?? new SessionStore(rootDir);
      this.knowledge = options.knowledge ?? new LocalKnowledgeStore(rootDir, "formal");
    } catch (error) { this.db.close(); throw error; }
    this.memory = new ControlMemory(this.db, options.memory, this.sessions);
    this.ownsSessions = !options.sessions;
    this.ownsKnowledge = !options.knowledge;
    const expressions = options.expressions ?? new ExpressionStore(rootDir);
    this.localContext = options.context ?? new LocalCoreContextProvider(rootDir,
      () => renderRecentSummary(this.knowledge.listRecent()), () => expressions.snapshot(),
      () => this.knowledge.getRecentRevision());
  }

  close(): void {
    this.db.close();
    if (this.ownsSessions) this.sessions.close();
    if (this.ownsKnowledge) this.knowledge.close();
  }

  conversations(input: ControlPage = {}) {
    const { offset, limit } = page(input);
    const total = (this.db.prepare("SELECT count(*) AS n FROM conversations").get() as { n: number }).n;
    const rows = this.db.prepare("SELECT key,channel,conversation_id,count,updated_at FROM conversations ORDER BY updated_at DESC,key LIMIT ? OFFSET ?")
      .all(limit, offset) as { key: string; channel: ChannelName; conversation_id: string; count: number; updated_at: string }[];
    return { items: rows.map(row => ({ key: row.key, channel: row.channel, conversationId: row.conversation_id,
      count: row.count, updatedAt: row.updated_at })), total, nextOffset: offset + rows.length < total ? offset + rows.length : null };
  }

  private conversation(key: unknown): ControlConversation {
    const value = text(key, 512);
    const row = this.db.prepare("SELECT key,channel,conversation_id,count,updated_at FROM conversations WHERE key=?")
      .get(value) as { key: string; channel: ChannelName; conversation_id: string; count: number; updated_at: string } | undefined;
    if (!row || !["telegram", "wechat"].includes(row.channel)) throw missing("找不到此会话。");
    return { key: row.key, channel: row.channel, conversationId: row.conversation_id, count: row.count, updatedAt: row.updated_at };
  }

  private dateBoundary(value: unknown, end: boolean): string | undefined {
    if (value === undefined || value === "") return undefined;
    const input = text(value, 64);
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
      const parsed = new Date(input + "T00:00:00Z");
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input) throw invalid("日期无效。");
      if (end) parsed.setUTCDate(parsed.getUTCDate() + 1);
      const desired = parsed.getTime();
      const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: this.timezone, year: "numeric", month: "2-digit",
        day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
      let candidate = desired;
      for (let i = 0; i < 3; i++) {
        const parts = Object.fromEntries(formatter.formatToParts(candidate).map(part => [part.type, part.value]));
        const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
          Number(parts.hour), Number(parts.minute), Number(parts.second));
        const change = desired - observed;
        candidate += change;
        if (!change) break;
      }
      return new Date(candidate - (end ? 1 : 0)).toISOString();
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input) || !Number.isFinite(Date.parse(input))) {
      throw invalid("日期需要 YYYY-MM-DD 或带时区的 ISO 时间。");
    }
    return new Date(input).toISOString();
  }

  private message(message: SessionMessage, index: number, channel: ChannelName) {
    return { index, revision: messageRevision(message), ...(message.id ? { id: message.id } : {}), role: message.role, content: message.content, at: message.at,
      channel: message.source?.channel ?? channel, ...(message.origin ? { origin: message.origin } : {}),
      ...(message.partial !== undefined ? { partial: message.partial } : {}),
      attachments: (message.attachments ?? []).map((attachment, attachmentIndex) => ({ index: attachmentIndex,
        expectedRevision: messageRevision(message), kind: attachment.kind, fileName: safeName(attachment.fileName, "attachment-" + (attachmentIndex + 1)),
        mimeType: SAFE_IMAGE_MIMES.has(attachment.mimeType ?? "") ? attachment.mimeType : "application/octet-stream" })) };
  }

  async history(input: ControlHistoryQuery) {
    const conv = this.conversation(input.conversationKey);
    let { offset, limit } = page(input);
    const query = input.query === undefined ? "" : text(input.query, 256, true);
    const from = this.dateBoundary(input.from, false), to = this.dateBoundary(input.to, true);
    if (from && to && Date.parse(from) > Date.parse(to)) throw invalid("开始日期不能晚于结束日期。");
    const filtered = Boolean(query || from || to) && input.around === undefined;
    if (input.around !== undefined) {
      const around = number(input.around, 0, Number.MAX_SAFE_INTEGER);
      if (around >= conv.count) throw missing("找不到此消息。");
      if (input.expectedRevision !== undefined) {
        const target = (await this.sessions.readRange(conv.channel, conv.conversationId, around, 1))[0];
        if (!target || messageRevision(target) !== input.expectedRevision) throw new ControlDataError("revision_conflict", 409, "消息位置已变化，请刷新。");
      }
      offset = Math.max(0, around - Math.floor(limit / 2));
    }
    if (!filtered) {
      // Offsets count from the newest message; stored indices stay chronological
      // so attachments and context links continue to address the original row.
      const context = input.around !== undefined;
      const end = Math.max(0, conv.count - offset);
      const start = context ? offset : Math.max(0, end - limit);
      const messages = await this.sessions.readRange(conv.channel, conv.conversationId, start, context ? limit : end - start);
      return { conversationKey: conv.key, items: messages.map((item, index) => this.message(item, start + index, conv.channel)).reverse(),
        total: conv.count, nextOffset: offset + messages.length < conv.count ? offset + messages.length : null, offset, filtered };
    }
    const view = await this.sessions.view(conv.channel, conv.conversationId);
    const dates = { from, to };
    const { total } = await view.history.search(query, 0, 0, undefined, dates);
    const end = Math.max(0, total - offset), start = Math.max(0, end - limit);
    const result = await view.history.search(query, start, end - start, undefined, dates);
    const items = await Promise.all(result.entries.reverse().map(async entry => {
      const message = (await this.sessions.readRange(conv.channel, conv.conversationId, entry.index, 1))[0];
      if (!message) throw missing("消息在读取时发生变化，请刷新。");
      return this.message(message, entry.index, conv.channel);
    }));
    return { conversationKey: conv.key, items, total, nextOffset: offset + items.length < total ? offset + items.length : null, offset, filtered };
  }

  async deleteHistory(input: { conversationKey: string; messageIndex: number; expectedRevision: string; confirm: boolean }) {
    if (input.confirm !== true) throw invalid("删除聊天记录需要确认。");
    const conv = this.conversation(input.conversationKey);
    const index = number(input.messageIndex, -1, Number.MAX_SAFE_INTEGER);
    if (index < 0) throw invalid();
    const expected = text(input.expectedRevision, 64);
    if (!/^[a-f0-9]{64}$/.test(expected)) throw invalid("请先读取要删除的消息。");
    const current = (await this.sessions.readRange(conv.channel, conv.conversationId, index, 1))[0];
    if (!current) throw missing();
    if (messageRevision(current) !== expected) throw new ControlDataError("revision_conflict", 409, "消息已变化，请刷新后重新确认。");
    if (!this.editHistory) throw new ControlDataError("history_edit_unavailable", 503, "历史编辑尚未就绪，未删除记录。");
    try {
      await this.editHistory(this.sessions.sessionKey(conv.channel, conv.conversationId), async () => {
        const result = await this.sessions.deleteMessage(conv.channel, conv.conversationId, index, expected);
        if (result === "missing") throw missing();
        if (result === "conflict") throw new ControlDataError("revision_conflict", 409, "消息已变化，请刷新后重新确认。");
      });
    } catch (error) {
      if (error instanceof ControlDataError) throw error;
      throw new ControlDataError("history_edit_blocked", 409, "当前回复尚未结算或历史编辑失败，未删除记录，请稍后重试。");
    }
    return { deleted: true, messageIndex: index };
  }

  async attachment(input: ControlAttachmentQuery): Promise<ControlAttachment> {
    const conv = this.conversation(input.conversationKey);
    const index = number(input.messageIndex, -1, Number.MAX_SAFE_INTEGER);
    const attachmentIndex = number(input.attachmentIndex, -1, 1000);
    if (index < 0 || attachmentIndex < 0 || index >= conv.count) throw missing();
    const message = (await this.sessions.readRange(conv.channel, conv.conversationId, index, 1))[0];
    if (input.expectedRevision !== undefined && (!message || messageRevision(message) !== input.expectedRevision))
      throw new ControlDataError("revision_conflict", 409, "附件所属消息已变化，请刷新。");
    const attachment = message?.attachments?.[attachmentIndex];
    if (!attachment) throw missing("附件不存在。");
    const mediaRoot = resolve(this.rootDir, "media"), candidate = resolve(attachment.path);
    if (!within(mediaRoot, candidate)) throw missing("附件不在允许的媒体目录中。");
    let file: FileHandle | undefined;
    try {
      // No symlink component, including a replaced media directory, may escape this fixed root.
      const rootReal = await realpath(this.rootDir);
      const mediaReal = await realpath(mediaRoot);
      if (mediaReal !== join(rootReal, "media")) throw missing("附件目录不可用。");
      let current = mediaRoot;
      for (const part of relative(mediaRoot, candidate).split(sep)) {
        current = join(current, part);
        if ((await lstat(current)).isSymbolicLink()) throw missing("不提供符号链接附件。");
      }
      const resolved = await realpath(candidate);
      if (!within(mediaReal, resolved)) throw missing("附件路径不可用。");
      file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat();
      const pathInfo = await lstat(resolved);
      if (!info.isFile() || pathInfo.isSymbolicLink() || info.dev !== pathInfo.dev || info.ino !== pathInfo.ino ||
          info.size > MAX_ATTACHMENT_BYTES || !within(mediaReal, await realpath(resolved))) throw missing("附件已变化、不可读取或超过 32 MiB。");
      return { file, path: resolved, fileName: safeName(attachment.fileName, basename(resolved)),
        mimeType: SAFE_IMAGE_MIMES.has(attachment.mimeType ?? "") ? attachment.mimeType! : "application/octet-stream", size: info.size };
    } catch (error) {
      await file?.close();
      if (error instanceof ControlDataError) throw error;
      throw missing("附件已过期或不可读取。");
    }
  }

  async core(): Promise<ControlCore> {
    const result = await executeLocalContextTool(this.rootDir, "formal", LOCAL_CONTEXT_TOOL_NAMES.coreRead, {}) as { core: ControlCore };
    return result.core;
  }

  async saveCore(input: { body: string; expectedRevision: number }): Promise<ControlCore> {
    const expectedRevision = revision(input.expectedRevision), nextBody = body(input.body);
    if ((await this.core()).revision !== expectedRevision) throw new ControlDataError("revision_conflict", 409, "Core 已被更新，请重新读取并合并修改。");
    try {
      const result = await executeLocalContextTool(this.rootDir, "formal", LOCAL_CONTEXT_TOOL_NAMES.coreWrite,
        { body: nextBody, expected_revision: expectedRevision }) as { updated: ControlCore };
      this.localContext.invalidate();
      return result.updated;
    } catch (error) {
      if (error instanceof Error && /revision/.test(error.message)) throw new ControlDataError("revision_conflict", 409, "Core 已被更新，请重新读取并合并修改。");
      throw error;
    }
  }

  private recentEntry(entry: RecentEntry): ControlRecent {
    const { sourceId: _source, ...visible } = entry;
    return { ...visible, archived: entry.conversationState === "Done" };
  }

  recent(input: ControlRecentQuery = {}) {
    const { offset, limit } = page(input);
    const query = input.query === undefined ? "" : text(input.query, 256, true);
    if (input.archived !== undefined && typeof input.archived !== "boolean") throw invalid();
    const terms = ["kind='recent'"], args: Array<string | number> = [];
    if (input.archived !== undefined) terms.push(input.archived ? "conversation_state='Done'" : "(conversation_state IS NULL OR conversation_state<>'Done')");
    if (query) { terms.push("instr(lower(body),lower(?))>0"); args.push(query); }
    const where = terms.join(" AND ");
    const total = (this.db.prepare("SELECT count(*) AS n FROM context WHERE " + where).get(...args) as { n: number }).n;
    const rows = this.db.prepare("SELECT id FROM context WHERE " + where + " ORDER BY updated_at DESC,id LIMIT ? OFFSET ?")
      .all(...args, limit, offset) as { id: string }[];
    const items = rows.map(row => this.knowledge.getRecent(row.id)).filter((entry): entry is RecentEntry => Boolean(entry)).map(entry => this.recentEntry(entry));
    return { items, total, nextOffset: offset + rows.length < total ? offset + rows.length : null };
  }

  private currentRecent(input: ControlRecentTarget) {
    const id = text(input.id, 512), expectedRevision = revision(input.expectedRevision);
    const current = this.knowledge.getRecent(id);
    if (!current) throw missing("Recent 已删除或不存在。");
    if (current.revision !== expectedRevision) throw new ControlDataError("revision_conflict", 409, "Recent 已被更新，请重新读取并合并修改。");
    return current;
  }

  saveRecent(input: ControlRecentTarget & { body: string }): ControlRecent {
    const current = this.currentRecent(input);
    const updated = this.knowledge.updateRecent({ id: current.id, expectedRevision: current.revision, body: body(input.body) });
    // Recent only changes the next dynamic directory; it must not rebuild the SIWC lane.
    return this.recentEntry(updated);
  }

  archiveRecent(input: ControlRecentTarget & { archived: boolean }): ControlRecent {
    const current = this.currentRecent(input);
    if (typeof input.archived !== "boolean") throw invalid();
    if ((current.conversationState === "Done") === input.archived) return this.recentEntry(current);
    const stateDate = new Intl.DateTimeFormat("en-CA", { timeZone: this.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    return this.recentEntry(this.knowledge.updateRecent({ id: current.id, expectedRevision: current.revision,
      conversationState: input.archived ? "Done" : "Ongoing", stateDate }));
  }

  deleteRecent(input: ControlRecentTarget) {
    const id = text(input.id, 512), expectedRevision = revision(input.expectedRevision);
    try { return this.knowledge.deleteRecent([{ id, expectedRevision }]); }
    catch (error) {
      if (error instanceof Error && /Stale/.test(error.message)) throw new ControlDataError("revision_conflict", 409, "Recent 已被更新，请重新读取并合并修改。");
      if (error instanceof Error && /not found/.test(error.message)) throw missing("Recent 已删除或不存在。");
      throw error;
    }
  }

  /** Only persisted recovery metadata is projected; contextItems and opaque payloads never leave this boundary. */
  context() {
    const snapshot = this.localContext.peek();
    const counts = this.db.prepare("SELECT count(*) AS total,sum(CASE WHEN conversation_state IS NULL OR conversation_state<>'Done' THEN 1 ELSE 0 END) AS active FROM context WHERE kind='recent'")
      .get() as { total: number; active: number | null };
    // Project metadata inside SQLite: large opaque contextItems never enter the HTTP process response.
    const rows = this.db.prepare(`SELECT key,updated_at,CASE WHEN json_valid(value) THEN json_object(
      'version',json_extract(value,'$.version'),'model',json_extract(value,'$.model'),
      'sessionId',json_extract(value,'$.sessionId'),'startedAt',json_extract(value,'$.startedAt'),
      'lastCompactedAt',json_extract(value,'$.lastCompactedAt'),'historyCursor',json_extract(value,'$.historyCursor'),
      'coverageVerified',json_extract(value,'$.coverageVerified'),
      'hasContextItems',json_type(value,'$.contextItems')='array',
      'pendingDelivery',json_type(value,'$.pendingDeliveryId')='text' OR json_type(value,'$.pendingDeliveryItems')='array',
      'checkpoint',json_object('id',json_extract(value,'$.checkpoint.id'),'at',json_extract(value,'$.checkpoint.at'),
        'reason',json_extract(value,'$.checkpoint.reason'),'coveredThroughSeq',json_extract(value,'$.checkpoint.coveredThroughSeq'))
      ) ELSE '{}' END AS value FROM gateway_state
      WHERE category='runtime' AND encoding='json' AND key GLOB 'runtime/context/*.json'
      ORDER BY updated_at DESC LIMIT 100`)
      .all() as { key: string; value: string; updated_at: string }[];
    const checkpoints = rows.flatMap(row => {
      if (!/^runtime\/context\/[a-f0-9]{64}\.json$/.test(row.key)) return [];
      let raw: unknown;
      try { raw = JSON.parse(row.value); } catch { return []; }
      if (!record(raw) || ![1, 2].includes(raw.version as number) || raw.hasContextItems !== 1 || typeof raw.model !== "string") return [];
      const sessionId = typeof raw.sessionId === "string" && raw.sessionId.length <= 512 ? raw.sessionId : null;
      const canonical = sessionId ? "runtime/context/" + createHash("sha256").update(sessionId).digest("hex") + ".json" : null;
      const cp = record(raw.checkpoint) ? raw.checkpoint : null;
      return [{ id: row.key.slice("runtime/context/".length, -5), sessionId, model: raw.model.slice(0, 200),
        updatedAt: row.updated_at, startedAt: optionalInstant(raw.startedAt), lastCompactedAt: optionalInstant(raw.lastCompactedAt),
        historyCursor: safeInteger(raw.historyCursor), coverageVerified: raw.coverageVerified === 1 ? true : raw.coverageVerified === 0 ? false : null,
        pendingDelivery: raw.pendingDelivery === 1, archived: canonical !== null && canonical !== row.key,
        checkpoint: cp && typeof cp.id === "string" && /^[a-f0-9]{64}$/.test(cp.id) && optionalInstant(cp.at) &&
          ["capacity", "seven_days"].includes(cp.reason as string) && safeInteger(cp.coveredThroughSeq) !== null
          ? { id: cp.id, at: cp.at as string, reason: cp.reason as string, coveredThroughSeq: cp.coveredThroughSeq as number } : null }];
    });
    const lastRequest = readContextObservation(this.db);
    return { available: snapshot?.available === true, loadedAt: snapshot?.loadedAt ?? null,
      local: snapshot?.available && snapshot.data ? {
        core: snapshot.data.core, recentDirectory: snapshot.data.recent, guidance: snapshot.data.guidance,
        expression: snapshot.data.expression ? { showStageDirections: snapshot.data.expression.showStageDirections, instruction: expressionInstruction(snapshot.data.expression) } : null,
        revisions: { core: snapshot.data.coreRevision, recent: snapshot.data.recentRevision, expression: snapshot.data.expressionRevision ?? null },
      } : null,
      recent: { totalCount: counts.total, activeCount: counts.active ?? 0 }, checkpoints,
      lastRequest,
      usage: { supported: lastRequest?.usage !== null && lastRequest?.usage !== undefined,
        note: "数值来自正式会话中最近一次真实模型调用；未回报字段保持未知，不代表当前窗口总量或整轮累计。" },
      note: "本地内容是最近一次组装的快照，修改后会在后续请求使用。检查点只展示已保存的恢复元数据，不代表完整模型上下文；压缩内容不可直接阅读。" };
  }
}
