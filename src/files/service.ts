import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { InboundMessage } from "../channels/types.js";
import { getState, mainPath, openDatabase, putState } from "../state/database.js";
import { SerialQueue } from "../util/serial-queue.js";
import { FILE_TOOLS } from "./tools.js";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const CONFIRMATION_MS = 15 * 60_000;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
type Result = Record<string, unknown>;
export interface OutboundDocument { filename: string; bytes: Uint8Array; caption?: string }
type Proposal = { action: "replace" | "delete"; path: string; content?: string; hash: string;
  identity: string; mode: number; owner: string; messageId: string; expires: number; requestHash: string };
type Receipt = { requestHash: string; status: "started" | "complete"; result?: Result };

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("Invalid " + label);
  return value;
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || Number(n) < min || Number(n) > max) throw new Error("Invalid file pagination");
  return Number(n);
}
function filename(value: unknown): string {
  const name = text(value, "filename");
  if (name === "." || name === ".." || /[\\/\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 240) throw new Error("Invalid filename");
  return name;
}
function content(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_FILE_BYTES || value.includes("\0")) throw new Error("Invalid UTF-8 file content");
  return value;
}
function identity(stat: { dev: number; ino: number; mtimeMs: number; size: number }): string {
  return [stat.dev, stat.ino, stat.mtimeMs, stat.size].join(":");
}
/** A descriptor-bound, bounded read avoids following final symlinks or loading growing files without a limit. */
async function readFile(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Only regular files up to 20 MiB are supported");
    const bytes = Buffer.alloc(Math.min(MAX_FILE_BYTES, stat.size) + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await handle.stat();
    if (used > stat.size || identity(stat) !== identity(after)) throw new Error("File changed while being read");
    return { bytes: bytes.subarray(0, used), stat };
  } finally { await handle.close(); }
}

export class FileService {
  private readonly queue = new SerialQueue();
  private readonly proposals = new Map<string, Proposal>();
  private readonly applied = new Map<string, { owner: string; result: Result }>();
  constructor(private readonly dataDir: string, readonly generatedDir: string,
    private readonly owner: string, private readonly send: (file: OutboundDocument) => Promise<number>,
    private readonly clock: () => number = Date.now) {}

  allowed(message: InboundMessage): boolean {
    return message.channel === "telegram" && message.senderId === this.owner && message.conversationId === this.owner;
  }
  tools(message: InboundMessage) { return this.allowed(message) ? FILE_TOOLS : []; }
  execute(name: string, args: Record<string, unknown>, message: InboundMessage): Promise<Result> {
    if (!this.allowed(message) || !FILE_TOOLS.some(tool => tool.name === name)) return Promise.reject(new Error("File tools are unavailable for this conversation"));
    return this.queue.run(async () => {
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid file arguments");
      if (name === "telegram_send_document") return this.document(args, message);
      if (name === "gateway_file_propose") return this.propose(args, message);
      if (name === "gateway_file_apply") return this.apply(args.confirmation, message);
      const path = resolve(name === "gateway_file_list" && args.path === undefined ? "." : text(args.path, "path"));
      if (name === "gateway_file_info") {
        const stat = await lstat(path);
        return { path, type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other", bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
      }
      const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      if (name === "gateway_file_list") {
        const limit = integer(args.limit, 50, 1, 100);
        const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        return { path, total: entries.length, items: entries.slice(offset, offset + limit).map(entry => ({ name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other" })),
          nextOffset: offset + limit < entries.length ? offset + limit : null };
      }
      const maxChars = integer(args.maxChars, 6000, 1, 12000);
      const file = await readFile(path);
      const value = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      if (value.includes("\0")) throw new Error("File is not UTF-8 text");
      return { path, content: value.slice(offset, offset + maxChars), totalChars: value.length,
        nextOffset: offset + maxChars < value.length ? offset + maxChars : null };
    });
  }

  private receipt(key: string, value?: Receipt): Receipt | undefined {
    const db = openDatabase(mainPath(this.dataDir));
    try {
      if (value) putState(db, { key, value: JSON.stringify(value) });
      const row = getState(db, key);
      if (!row) return undefined;
      const receipt = JSON.parse(row.value) as Receipt;
      if (!receipt || typeof receipt.requestHash !== "string" || !["started", "complete"].includes(receipt.status)) throw new Error("Invalid file operation receipt");
      return receipt;
    } finally { db.close(); }
  }
  private async document(args: Record<string, unknown>, message: InboundMessage): Promise<Result> {
    const mode = args.mode;
    if (!["generate", "save", "existing"].includes(String(mode))) throw new Error("Invalid document mode");
    const isExisting = mode === "existing";
    const name = isExisting ? filename(basename(text(args.path, "path"))) : filename(args.filename);
    const value = isExisting ? undefined : content(args.content);
    if ((isExisting && (args.content !== undefined || args.filename !== undefined)) || (mode === "generate" && args.path !== undefined)) throw new Error("Unexpected document parameters");
    const caption = args.caption === undefined ? undefined : text(args.caption, "caption");
    if (caption && caption.length > 1024) throw new Error("Caption is too long");
    const path = args.path === undefined ? undefined : resolve(text(args.path, "path"));
    if (mode === "save" && path && basename(path) !== name) throw new Error("Destination must match filename");
    const operationId = text(message.messageId, "message ID");
    const requestHash = digest(JSON.stringify([mode, name, value, path, caption]));
    const key = "runtime/file-operations/" + digest(JSON.stringify([this.owner, operationId, mode, path ?? name]));
    const prior = this.receipt(key);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new Error("This file operation was already requested with different content");
      return prior.status === "complete" && prior.result ? prior.result : { success: false, uncertain: true, message: "之前的文件交付结果不明确，不自动重复发送。请检查聊天中的文件后再发起新的请求。" };
    }
    let savedPath: string | undefined;
    let bytes: Uint8Array;
    if (isExisting) bytes = (await readFile(path!)).bytes;
    else {
      bytes = Buffer.from(value!, "utf8");
      await mkdir(this.generatedDir, { recursive: true, mode: 0o700 });
      savedPath = path ?? join(this.generatedDir, name);
      try { await writeFile(savedPath, bytes, { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if (mode !== "generate" || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        savedPath = join(await mkdtemp(join(this.generatedDir, "document-")), name);
        await writeFile(savedPath, bytes, { flag: "wx", mode: 0o600 });
      }
    }
    const result: Result = { success: true, filename: name, bytes: bytes.byteLength,
      ...(savedPath ? { saved: true, path: savedPath } : {}) };
    if (mode !== "save") {
      // Persist the attempt before network I/O; a lost acknowledgement is never replayed after restart.
      this.receipt(key, { requestHash, status: "started" });
      const messageId = await this.send({ filename: name, bytes, ...(caption ? { caption } : {}) });
      if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error("Document delivery was not acknowledged");
      Object.assign(result, { delivered: true, messageId });
    }
    this.receipt(key, { requestHash, status: "complete", result });
    return result;
  }

  private async propose(args: Record<string, unknown>, message: InboundMessage): Promise<Result> {
    for (const [code, proposal] of this.proposals) if (proposal.expires <= this.clock()) this.proposals.delete(code);
    if (args.action !== "replace" && args.action !== "delete") throw new Error("Invalid file action");
    const requested = resolve(text(args.path, "path"));
    if ((await lstat(requested)).isSymbolicLink()) throw new Error("Linked files cannot be modified");
    const path = await realpath(requested);
    const value = args.action === "replace" ? content(args.content) : undefined;
    if (args.action === "delete" && args.content !== undefined) throw new Error("Delete does not accept replacement content");
    const requestHash = digest(JSON.stringify([message.messageId, args.action, path, value]));
    const previous = [...this.proposals].find(([, p]) => p.requestHash === requestHash);
    let code = previous?.[0];
    if (!code) {
      if (this.proposals.size >= 20 || [...this.proposals.values()].reduce((n, p) => n + Buffer.byteLength(p.content ?? ""), Buffer.byteLength(value ?? "")) > MAX_FILE_BYTES * 2) throw new Error("Too many pending file operations");
      const file = await readFile(path);
      code = randomBytes(8).toString("hex").toUpperCase();
      this.proposals.set(code, { action: args.action, path, content: value, hash: digest(file.bytes), identity: identity(file.stat),
        mode: file.stat.mode & 0o777, owner: this.owner, messageId: text(message.messageId, "message ID"), expires: this.clock() + CONFIRMATION_MS, requestHash });
    }
    const proposal = this.proposals.get(code)!;
    return { pending: true, action: proposal.action, path, confirmation: code, instruction: "确认文件操作 " + code,
      expiresAt: new Date(proposal.expires).toISOString(), originalSha256: proposal.hash,
      ...(value === undefined ? {} : { replacementBytes: Buffer.byteLength(value), preview: value.slice(0, 1200), previewTruncated: value.length > 1200 }) };
  }
  private async apply(raw: unknown, message: InboundMessage): Promise<Result> {
    const code = text(raw, "confirmation");
    if (message.text.trim() !== "确认文件操作 " + code) throw new Error("The current user message must explicitly confirm this operation");
    const prior = this.applied.get(code);
    if (prior?.owner === this.owner) return prior.result;
    const proposal = this.proposals.get(code);
    if (!proposal || proposal.owner !== this.owner || proposal.expires <= this.clock() || proposal.messageId === message.messageId) throw new Error("File confirmation is missing or expired");
    if (await realpath(proposal.path) !== proposal.path) throw new Error("File path changed after proposal");
    const file = await readFile(proposal.path);
    if (identity(file.stat) !== proposal.identity || digest(file.bytes) !== proposal.hash) throw new Error("File changed after proposal; prepare a new operation");
    this.proposals.delete(code);
    if (proposal.action === "delete") await unlink(proposal.path);
    else {
      const temporary = join(dirname(proposal.path), ".file-update-" + randomUUID());
      try {
        await writeFile(temporary, proposal.content!, { flag: "wx", mode: proposal.mode });
        await rename(temporary, proposal.path);
      } finally { await unlink(temporary).catch(() => undefined); }
    }
    const result = { success: true, action: proposal.action, path: proposal.path };
    this.applied.set(code, { owner: this.owner, result });
    if (this.applied.size > 200) this.applied.delete(this.applied.keys().next().value!);
    return result;
  }
}
