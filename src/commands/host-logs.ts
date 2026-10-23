import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeSession } from "../runtime/types.js";

const READ_WINDOW_BYTES = 256 * 1024;
const MAX_ERRORS = 5;
const LOG_FILES = ["gateway.log"] as const;
const ERROR_LINE = /\b(error|failed|failure|timeout|timed out|closed|unavailable|refused|reset|conflict|rate.?limit|exhausted|reauth|invalid_grant|overloaded|exited|exit)\b/i;

export interface HostDiagnosticSnapshot {
  runtime: RuntimeSession;
  chatgptProbeOk: boolean;
  chatgptProbeError?: string;
  localCoreAvailable: boolean;
}

export function redactLogText(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:access_token|token|api_key|apikey|secret|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b((?:[A-Z_][A-Z0-9_]*)?(?:TOKEN|SECRET|PASSWORD|KEY))\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/("(?:access_?token|refresh_?token|token|secret|password|api_?key|authorization|cookie)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2")
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]+\b/g, "[REDACTED_OPENROUTER_KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]");
}

async function readTail(path: string): Promise<string[]> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  if (size === 0) return [];
  const length = Math.min(size, READ_WINDOW_BYTES);
  const position = Math.max(0, size - length);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (position > 0) {
      const firstBreak = text.indexOf("\n");
      if (firstBreak >= 0) text = text.slice(firstBreak + 1);
    }
    return text.split(/\r?\n/).filter(Boolean);
  } finally {
    await handle.close();
  }
}

function lineTimestamp(line: string, fallback: number): number {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T\S+)/);
  if (!match) return fallback;
  const value = Date.parse(match[1]!);
  return Number.isFinite(value) ? value : fallback;
}

function errorFingerprint(line: string): string {
  return redactLogText(line)
    .replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, "")
    .replace(/\b(?:attempt|retry)\s+\d+\/\d+\b/gi, "attempt")
    .replace(/\bretrying in \d+(?:\.\d+)?(?:ms|s)\b/gi, "retrying")
    .replace(/\bpid=\d+\b/gi, "pid")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type LogRange = "15m" | "1h" | "today";
export type LogSource = "all" | "gateway";
export interface LogEvent { text: string; at: number; source: string; count: number }
export function logSince(range: LogRange, now: number, timezone = "Asia/Shanghai"): number {
  if (range !== "today") return now - (range === "1h" ? 60 : 15) * 60_000;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hourCycle: "h23",
    hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(now);
  const n = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  return now - ((n("hour") * 60 + n("minute")) * 60 + n("second")) * 1000 - now % 1000;
}
function isErrorLine(text: string): boolean {
  if (/\bexit(?:ed)?(?:[=: ]+(?:code[=: ]*)?)?0\b|completed successfully|normal exit/i.test(text)) return false;
  return ERROR_LINE.test(text);
}
export async function readLogEvents(logDir: string, options: {
  range?: LogRange; source?: LogSource; errorsOnly?: boolean; now?: number; timezone?: string;
} = {}): Promise<LogEvent[]> {
  const now = options.now ?? Date.now();
  const since = logSince(options.range ?? "15m", now, options.timezone);
  const groups = await Promise.all(LOG_FILES.filter(name => !options.source || options.source === "all" ||
    name === options.source + ".log").map(async name => {
    const lines = await readTail(join(logDir, name));
    const events: LogEvent[] = [];
    // Undated legacy lines are not presented as recent events. Continuation lines
    // inherit only a real timestamp from this bounded read, never file mtime.
    for (const text of lines) {
      const at = lineTimestamp(text, NaN);
      if (Number.isFinite(at)) events.push({ text, at, source: name.slice(0, -4), count: 1 });
      else if (events.length) events[events.length - 1]!.text += "\n" + text;
    }
    return events.filter(e => e.at >= since && e.at <= now &&
      (options.errorsOnly === false || isErrorLine(e.text)));
  }));
  const grouped = new Map<string, LogEvent>();
  for (const entry of groups.flat().sort((a,b) => a.at-b.at)) {
    const key = entry.source + ":" + errorFingerprint(entry.text);
    grouped.set(key, { ...entry, text: redactLogText(entry.text), count: (grouped.get(key)?.count ?? 0) + 1 });
  }
  return [...grouped.values()].sort((a,b) => b.at-a.at);
}
export async function readRecentHostErrors(logDir: string): Promise<string[]> {
  return (await readLogEvents(logDir)).slice(0, MAX_ERRORS).map(e =>
    e.text + (e.count > 1 ? "  [本时段重复 " + e.count + " 次]" : ""));
}
export function summarizeLog(text: string): string {
  if (/subscription|usage.limit|额度/.test(text)) return "模型额度不足或已暂停";
  if (/conflict|other getUpdates/i.test(text)) return "Telegram 轮询冲突";
  if (/timeout|timed out/i.test(text)) return "请求超时";
  if (/ECONN|fetch failed|connection|websocket.*closed/i.test(text)) return "连接异常";
  if (/invalid_grant|reauth|401|认证/i.test(text)) return "认证或登录态异常";
  return text.replace(/^\d{4}-\d{2}-\d{2}T\S+\s*/, "").split("\n")[0]!.slice(0, 160);
}

function classifyProbeError(error: string): string {
  const value = error.toLowerCase();
  if (
    value.includes("subscription_sharing_usage_limit_exceeded") ||
    value.includes("sharing limit") ||
    value.includes("usage limit")
  ) return "ChatGPT 额度/共享用量已耗尽";
  if (value.includes("429") || value.includes("rate limit")) return "ChatGPT 限流";
  if (
    value.includes("invalid_grant") ||
    value.includes("reauth") ||
    value.includes("sign in") ||
    value.includes("token_expired") ||
    value.includes("refresh_token")
  ) return "ChatGPT 登录态异常";
  if (
    value.includes("websocket") ||
    value.includes("network") ||
    value.includes("timeout") ||
    value.includes("timed out") ||
    value.includes("fetch failed") ||
    value.includes("econn") ||
    value.includes("reset") ||
    value.includes("refused") ||
    value.includes("closed")
  ) return "ChatGPT 网络/连接异常";
  return "ChatGPT runtime 异常";
}

function diagnose(snapshot: HostDiagnosticSnapshot, errors: string[]): string {
  if (snapshot.runtime.status === "reauth_required") return "ChatGPT 登录态需要重新授权";
  if (snapshot.runtime.status !== "connected") return "ChatGPT runtime 未连接";
  if (!snapshot.runtime.sharing) return "ChatGPT plan sharing 未启用";
  if (!snapshot.chatgptProbeOk) return classifyProbeError(snapshot.chatgptProbeError ?? "");
  if (!snapshot.localCoreAvailable) return "本地 Core / SQLite 不可用";

  const recent = errors.join("\n").toLowerCase();
  if (/telegram.*conflict|other getupdates/.test(recent)) return "Telegram polling 冲突";
  if (/responses websocket|chatgpt|runtime.*(network|timeout|closed|failed)/.test(recent)) {
    return "ChatGPT 最近出现过瞬时连接异常；当前检测已恢复";
  }
  if (/telegram.*(network|timeout|failed|error)/.test(recent)) {
    return "Telegram 最近出现过网络异常；当前命令已能到达 Host";
  }
  return errors.length
    ? "当前检测正常；下面是最近记录到的错误"
    : "当前检测正常，没有发现最近错误";
}

export async function formatHostDiagnosis(
  logDir: string,
  snapshot: HostDiagnosticSnapshot,
): Promise<string> {
  const errors = await readRecentHostErrors(logDir);
  const cause = diagnose(snapshot, errors);
  const checks = [
    "ChatGPT=" + (snapshot.chatgptProbeOk ? "OK" : "FAIL"),
    "Local Core/SQLite=" + (snapshot.localCoreAvailable ? "OK" : "FAIL"),
    "Telegram→Host=OK",
  ].join(" · ");

  return [
    "诊断：" + cause,
    "当前：" + checks,
    ...(snapshot.chatgptProbeError && !snapshot.chatgptProbeOk
      ? ["探测错误：" + redactLogText(snapshot.chatgptProbeError)]
      : []),
    "",
    "最近错误：",
    ...(errors.length ? errors : ["无"]),
  ].join("\n");
}
