import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { controlTunnelUrl } from "../config/index.js";
import { ControlAuth, ControlRateLimiter } from "./auth.js";
import { ControlData, ControlDataError } from "./data.js";
import type { HostMonitor } from "./host.js";
import type { TaskTraceStore } from "../observability/store.js";

interface ControlOptions {
  publicUrl: string;
  temporary?: boolean;
  tunnelReady?: boolean;
  data: ControlData;
  traces: TaskTraceStore;
  calls?: TaskTraceStore;
  host: HostMonitor;
  heartbeat: () => Promise<Record<string, unknown>>;
  mutate: <T>(work: () => Promise<T> | T) => Promise<T>;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const ASSETS: Record<string, { file: string; type: string }> = {
  "/control/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/control/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/control/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
};

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "json_required", "请求需要 JSON 格式。");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 384 * 1024) throw new HttpError(413, "body_too_large", "请求内容过大。");
    chunks.push(bytes);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "invalid_json", "请求不是有效 JSON。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "invalid_body", "请求需要 JSON 对象。");
  return parsed as Record<string, unknown>;
}

function safeName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 180) || "attachment";
}

/** Owner-only data/trace interface. It deliberately has no model or operational controls. */
export class ControlCenter {
  readonly auth: ControlAuth;
  private url: URL;
  private tunnelReady = true;
  private tunnelReason = "";
  private readonly rate = new ControlRateLimiter();
  private readonly assets = new Map<string, Buffer>();
  private readonly pending = new Set<Promise<boolean>>();
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(private readonly options: ControlOptions) {
    this.url = new URL(options.publicUrl);
    this.tunnelReady = !options.temporary || options.tunnelReady === true;
    this.auth = new ControlAuth(this.url.protocol === "https:");
  }

  loginEntry(): { text: string; url: string } {
    if(!this.tunnelReady) throw new Error("Control tunnel unavailable.");
    const code = this.auth.issueCode();
    const url = new URL(this.url.href);
    url.hash = new URLSearchParams({ login_code: code }).toString();
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const accessHint = local ? "\n当前链接仅供部署电脑本机访问。手机不能直接使用此地址；请设置 GATEWAY_CONTROL_TUNNEL=cloudflare 并使用 npm start。步骤见 docs/control-center.md。\n" : "";
    return { url: url.href, text: "Sophon 控制中心\n打开以下链接即可自动登录（5 分钟内有效）。" + accessHint + "\n\n备用登录码：\n" + code };
  }

  setTunnelUrl(value: unknown, reason?: unknown): void {
    if(!this.options.temporary) return;
    const reasons: Record<string,string> = {
      preparing:"正在自动检查或下载连接组件。", download_failed:"组件下载失败，请检查主机到 GitHub 的网络，稍后会自动重试。",
      checksum_failed:"组件校验失败，已停止使用；请在停机后清理本地组件缓存再重试。",
      unsupported_platform:"此系统暂不支持自动下载，请通过 GATEWAY_CLOUDFLARED_BIN 指定兼容的可执行文件。",
      configured_binary_unavailable:"指定的组件路径不可用，请检查 GATEWAY_CLOUDFLARED_BIN。",
      binary_unavailable:"组件无法执行，请检查系统兼容性与执行权限。",
      connection_failed:"隧道连接失败，正在重试，请检查出站网络。",
    };
    this.tunnelReason = typeof reason === "string" ? reasons[reason] ?? "连接组件暂不可用，正在重试。" : "";
    const valid = controlTunnelUrl(value);
    if(valid === this.url.href && this.tunnelReady) return;
    this.auth.revokeAll();
    this.tunnelReady = Boolean(valid);
    if(valid) this.url = new URL(valid);
  }

  loginMessage(): string {
    if(!this.tunnelReady) return "控制中心临时网址尚未就绪。" + this.tunnelReason + "请使用 npm start 启动，稍后重新发送 /status。";
    const entry = this.loginEntry(); return entry.text + "\n" + entry.url; }

  start(): void { this.options.host.start(); }
  beginShutdown(): void {
    this.closing = true;
    this.auth.revokeAll();
    this.options.host.stop();
  }
  close(): Promise<void> {
    this.beginShutdown();
    return this.closePromise ??= (async () => {
      await Promise.allSettled([...this.pending]);
      await this.options.data.close();
    })();
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== "/control" && !path.startsWith("/control/")) return false;
    if (!this.tunnelReady) { json(res, 503, {ok:false,error:{code:"tunnel_unavailable",message:"临时网址已失效，请重新发送 /status。"}}); return true; }
    if (this.closing) { json(res, 503, { ok: false, error: { code: "shutting_down", message: "服务正在关闭，请稍后重试。" } }); return true; }
    // Bound slow clients so shutdown can drain open uploads/downloads as well.
    req.setTimeout(15_000, () => req.destroy());
    res.setTimeout(30_000, () => res.destroy());
    const pending = this.serve(req, res, path);
    this.pending.add(pending);
    try { return await pending; } finally { this.pending.delete(pending); }
  }

  private async serve(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      if (req.headers.host !== this.url.host) throw new HttpError(403, "host_rejected", "访问地址与控制中心配置不一致。");
      const ip = req.socket.remoteAddress ?? "unknown";
      if (!this.rate.allow("all", 900) || !this.rate.allow("ip:" + ip, 360)) throw new HttpError(429, "rate_limited", "请求过于频繁，请稍后重试。");
      if (path === "/control" && req.method === "GET") { res.writeHead(308, { location: "/control/" }); res.end(); return true; }
      const asset = ASSETS[path];
      if (asset) {
        if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "此资源仅支持 GET。");
        let bytes = this.assets.get(asset.file);
        if (!bytes) { bytes = await readFile(new URL("./assets/" + asset.file, import.meta.url)); this.assets.set(asset.file, bytes); }
        res.writeHead(200, { "content-type": asset.type, "content-length": bytes.length }); res.end(bytes); return true;
      }
      if (!path.startsWith("/control/api/")) throw new HttpError(404, "not_found", "没有这个页面。");
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "此接口仅支持 POST。");
      if (req.headers.origin !== this.url.origin || req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "origin_rejected", "请求来源不匹配。");
      const action = path.slice("/control/api/".length);
      const input = await body(req);
      if (this.closing) throw new HttpError(503, "shutting_down", "服务正在关闭，请稍后重试。");
      const cookie = this.auth.readCookie(req.headers.cookie);
      const session = this.auth.get(cookie);
      if (action === "session") {
        json(res, 200, { ok: true, data: session ? { authenticated: true, csrfToken: session.csrfToken } : { authenticated: false } }); return true;
      }
      if (action === "login") {
        if (!this.rate.allow("login:" + ip, 10) || !this.rate.allow("login", 30)) throw new HttpError(429, "rate_limited", "登录尝试过于频繁，请稍后重试。");
        if (!this.auth.consumeCode(input.code)) throw new HttpError(401, "invalid_code", "登录码无效或已过期，请重新发送 /status。");
        if (session) this.auth.revoke(cookie);
        const created = this.auth.create(); res.setHeader("set-cookie", this.auth.cookie(created.id));
        json(res, 200, { ok: true, data: { authenticated: true, csrfToken: created.session.csrfToken } }); return true;
      }
      if (!session) throw new HttpError(401, "authentication_required", "请重新登录控制中心。");
      if (!this.auth.validCsrf(session, req.headers["x-control-csrf"])) throw new HttpError(403, "csrf_rejected", "页面凭据已失效，请刷新后重试。");
      if (!this.rate.allow("session:" + createHash("sha256").update(cookie).digest("hex"), 240)) throw new HttpError(429, "rate_limited", "请求过于频繁，请稍后重试。");
      const mutate = <T>(work: () => Promise<T> | T): Promise<T> => this.options.mutate(() => {
        if (this.closing) throw new HttpError(503, "shutting_down", "服务正在关闭，修改尚未执行。");
        if (res.destroyed) throw new HttpError(499, "request_closed", "请求已取消，修改尚未执行。");
        if (this.auth.get(cookie) !== session) throw new HttpError(401, "authentication_required", "登录已失效，修改尚未执行。");
        return work();
      });
      if (action === "logout") {
        this.auth.revoke(cookie); res.setHeader("set-cookie", this.auth.cookie("")); json(res, 200, { ok: true, data: { authenticated: false } }); return true;
      }
      if (action === "attachment") {
        const attachment = await this.options.data.attachment(input as never);
        try {
          const filename = safeName(attachment.fileName);
          res.setHeader("content-disposition", "attachment; filename=\"attachment\"; filename*=UTF-8''" + encodeURIComponent(filename));
          res.writeHead(200, { "content-type": "application/octet-stream", "content-length": attachment.size });
          await pipeline(attachment.file.createReadStream({ autoClose: false }), res);
        } finally { await attachment.file.close(); }
        return true;
      }
      let data: unknown;
      switch (action) {
        case "conversations": data = await this.options.data.conversations(input); break;
        case "history": data = await this.options.data.history(input as never); break;
        case "history-delete": data = await mutate(() => this.options.data.deleteHistory(input as never)); break;
        case "core": data = await this.options.data.core(); break;
        case "core-save": data = await mutate(() => this.options.data.saveCore(input as never)); break;
        case "recent": data = await this.options.data.recent(input); break;
        case "recent-save": data = await mutate(() => this.options.data.saveRecent(input as never)); break;
        case "recent-archive": data = await mutate(() => this.options.data.archiveRecent(input as never)); break;
        case "recent-delete": data = await mutate(() => this.options.data.deleteRecent(input as never)); break;
        case "graph-prompts": data = this.options.data.memory.prompts(); break;
        case "graph-prompt-save": data = await mutate(() => this.options.data.memory.savePrompt(input)); break;
        case "graph-topic-save": data = await mutate(() => this.options.data.memory.saveTopic(input)); break;
        case "graph-node-save": data = await mutate(() => this.options.data.memory.saveNode(input)); break;
        case "graph": data = this.options.data.memory.overview(); break;
        case "graph-topics": data = this.options.data.memory.topics(input); break;
        case "graph-nodes": data = this.options.data.memory.nodes(input); break;
        case "graph-node": data = await this.options.data.memory.node(input); break;
        case "context": {
          const snapshot = this.options.data.context();
          const calls = this.options.calls?.list({limit:20}).runs ?? [];
          data = {...snapshot,calls}; break;
        }
        case "call": {
          if (typeof input.id !== "string" || !/^tr_\d{13}_[a-f0-9-]{36}$/.test(input.id)) throw new HttpError(400,"invalid_call","调用标识无效。");
          data = this.options.calls?.get(input.id);
          if (!data) throw new HttpError(404,"call_not_found","调用记录不存在或已超过保留期限。");
          break;
        }
        case "tasks": {
          if (input.limit !== undefined && (typeof input.limit !== "number" || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) {
            throw new HttpError(400, "invalid_page", "任务分页数量必须为 1–100。");
          }
          if (input.before !== undefined && (typeof input.before !== "string" || !/^tr_\d{13}_[a-f0-9-]{36}$/.test(input.before))) {
            throw new HttpError(400, "invalid_cursor", "任务分页游标无效。");
          }
          data = { ...this.options.traces.list(input as never), retentionDay:this.options.traces.retentionDay(), heartbeat: await this.options.heartbeat() }; break;
        }
        case "task": {
          if (typeof input.id !== "string" || input.id.length > 160) throw new HttpError(400, "invalid_task", "任务标识无效。");
          data = this.options.traces.get(input.id);
          if (!data) throw new HttpError(404, "task_not_found", "任务记录不存在或已超过保留期限。");
          break;
        }
        case "host": data = await this.options.host.snapshot(); break;
        default: throw new HttpError(404, "not_found", "没有这个接口。");
      }
      json(res, 200, { ok: true, data });
    } catch (error) {
      if (res.destroyed) return true;
      if (res.headersSent) { if (!res.writableEnded) res.destroy(); return true; }
      if (error instanceof HttpError || error instanceof ControlDataError) json(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
      else json(res, 500, { ok: false, error: { code: "internal_error", message: "暂时无法读取或保存，请稍后重试。" } });
    }
    return true;
  }
}
