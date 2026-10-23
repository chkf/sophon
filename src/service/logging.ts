import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { format } from "node:util";
import { redactLogText } from "../commands/host-logs.js";

const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
type LogLevel = typeof LEVELS[number];
type ConsoleTarget = Pick<Console, LogLevel>;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export interface FileLogging {
  redact(text: string): string;
  close(): Promise<void>;
}

/** Also covers keys selected through environment-based provider configuration. */
export function environmentLogSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => Boolean(value) && /TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE|(?:^|_)KEY(?:$|_)/i.test(name))
    .map(([, value]) => value!);
}

/** Install only around the service lifetime; ordinary CLI commands have no log side effects. */
export async function installFileLogging(options: {
  directory: string;
  secrets?: Array<string | undefined>;
  enabled?: boolean;
  maxBytes?: number;
  console?: ConsoleTarget;
}): Promise<FileLogging> {
  const secrets = [...new Set((options.secrets ?? []).filter((value): value is string => Boolean(value))
    .flatMap(value => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]))]
    .sort((a, b) => b.length - a.length);
  const redact = (text: string): string => {
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    text = text.replace(/(\b(?:[a-z0-9_]*(?:token|secret|password|key)|authorization|cookie)\s*[:=]\s*)(['"])(?:\\.|(?!\2)[\s\S])*\2/gi,
      "$1$2[REDACTED]$2");
    text = text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
    return redactLogText(text);
  };
  if (options.enabled === false) return { redact, async close() {} };
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new Error("Log size limit must be at least 1024 bytes.");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const file = join(options.directory, "gateway.log");
  const backup = file + ".1";
  const previous = await lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (previous?.isSymbolicLink()) throw new Error("Refusing to write a linked log file.");
  let handle = await open(file, "a", 0o600);
  let size = (await handle.stat()).size;
  const target = options.console ?? console;
  const original = Object.fromEntries(LEVELS.map(level => [level, target[level]])) as Record<LogLevel, ConsoleTarget[LogLevel]>;
  const wrappers = {} as Record<LogLevel, ConsoleTarget[LogLevel]>;
  let pending: Promise<void> = Promise.resolve();
  let failed = false;
  let closing: Promise<void> | undefined;

  for (const level of LEVELS) {
    wrappers[level] = (...values: unknown[]) => {
      const text = redact(format(...values));
      original[level].call(target, text);
      if (closing || failed) return;
      const at = new Date().toISOString();
      let entry = text.slice(0, 16_000).replace(/\r\n?/g, "\n").split("\n")
        .map(line => at + " [" + level + "] " + line).join("\n") + "\n";
      if (Buffer.byteLength(entry) > maxBytes) {
        entry = Buffer.from(entry).subarray(0, maxBytes - 80).toString("utf8") +
          "\n" + at + " [warn] [entry truncated]\n";
      }
      pending = pending.then(async () => {
        if (failed) return;
        const bytes = Buffer.byteLength(entry);
        if (size && size + bytes > maxBytes) {
          await handle.close();
          await rm(backup, { force: true });
          await rename(file, backup);
          handle = await open(file, "a", 0o600);
          size = 0;
        }
        await handle.writeFile(entry, "utf8");
        size += bytes;
      }).catch(() => {
        failed = true;
        original.error.call(target, "[gateway] Local log writing failed; console output remains available.");
      });
    };
    target[level] = wrappers[level];
  }
  return {
    redact,
    close() {
      if (closing) return closing;
      for (const level of LEVELS) if (target[level] === wrappers[level]) target[level] = original[level];
      closing = pending.then(() => handle.close().catch(() => {
        original.error.call(target, "[gateway] Local log handle could not be closed cleanly.");
      }));
      return closing;
    },
  };
}
