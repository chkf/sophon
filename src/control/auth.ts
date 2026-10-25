import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const CODE_TTL = 5 * 60_000;
const SESSION_TTL = 8 * 60 * 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");

export interface ControlSession { csrfToken: string; expiresAt: number }

/** Login credentials are process-local, hashed and revoked on restart. */
export class ControlAuth {
  private code?: { hash: string; expiresAt: number };
  private readonly sessions = new Map<string, ControlSession>();
  constructor(private readonly secure = true, private readonly now: () => number = Date.now) {}

  get cookieName(): string { return this.secure ? "__Host-sophon-control" : "sophon-control-local"; }

  issueCode(): string {
    const value = token();
    this.code = { hash: digest(value), expiresAt: this.now() + CODE_TTL };
    return value;
  }

  consumeCode(value: unknown): boolean {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
    const current = this.code;
    if (!current || current.expiresAt <= this.now()) { this.code = undefined; return false; }
    if (!timingSafeEqual(Buffer.from(digest(value)), Buffer.from(current.hash))) return false;
    this.code = undefined;
    return true;
  }

  private prune(): void {
    for (const [key, value] of this.sessions) if (value.expiresAt <= this.now()) this.sessions.delete(key);
  }

  create(): { id: string; session: ControlSession } {
    this.prune();
    if (this.sessions.size >= 16) this.sessions.delete(this.sessions.keys().next().value!);
    const id = token(), session = { csrfToken: token(), expiresAt: this.now() + SESSION_TTL };
    this.sessions.set(digest(id), session);
    return { id, session };
  }

  get(id: string): ControlSession | undefined {
    this.prune();
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return undefined;
    return this.sessions.get(digest(id));
  }

  readCookie(header?: string): string {
    const matches = (header ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(this.cookieName + "="));
    return matches.length === 1 ? matches[0].slice(this.cookieName.length + 1) : "";
  }

  validCsrf(session: ControlSession, supplied: unknown): boolean {
    return typeof supplied === "string" && /^[A-Za-z0-9_-]{43}$/.test(supplied) &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrfToken));
  }

  revoke(id: string): void { this.sessions.delete(digest(id)); }
  revokeAll(): void { this.sessions.clear(); this.code = undefined; }
  cookie(id: string): string {
    return this.cookieName + "=" + id + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + (id ? SESSION_TTL / 1000 : 0) + (this.secure ? "; Secure" : "");
  }
}

/** Remote addresses are read directly; proxy-supplied client IPs are not trusted. */
export class ControlRateLimiter {
  private readonly buckets = new Map<string, { until: number; count: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  allow(key: string, maximum: number, windowMs = 60_000): boolean {
    const now = this.now();
    for (const [name, bucket] of this.buckets) if (bucket.until <= now) this.buckets.delete(name);
    const bucket = this.buckets.get(key) ?? { until: now + windowMs, count: 0 };
    if (!this.buckets.has(key) && this.buckets.size >= 2048) return false;
    this.buckets.set(key, bucket);
    return ++bucket.count <= maximum;
  }
}
