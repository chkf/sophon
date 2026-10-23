import { spawn } from "node:child_process";
import { redactLogText } from "./host-logs.js";

// Only immutable, explicitly reviewed npm scripts may be launched from Telegram.
// Never accept script flags, shell fragments, paths or an arbitrary command.
export const HOST_TEST_SCRIPTS = [
  "runtime:test",
  "runtime:diagnose",
  "gateway:check",
  "runtime:models",
  "typecheck",
  "test",
] as const;

export type HostTestScript = typeof HOST_TEST_SCRIPTS[number];

export function isHostTestScript(value: string): value is HostTestScript {
  return (HOST_TEST_SCRIPTS as readonly string[]).includes(value);
}

const MAX_CAPTURE_CHARS = 7_000;
const MAX_REPLY_CHARS = 3_500;
const TIMEOUT_MS = 120_000;
// Three sequential SIWC isolation stages can take longer than a smoke test.
const DIAGNOSTIC_TIMEOUT_MS = 300_000;

export class HostTestRunner {
  private running = false;

  constructor(
    private readonly cwd: string = process.cwd(),
    private readonly timeoutMs: number = TIMEOUT_MS,
    private readonly diagnosticTimeoutMs: number = DIAGNOSTIC_TIMEOUT_MS,
  ) {}

  async run(script: HostTestScript, signal?: AbortSignal): Promise<string> {
    if (!isHostTestScript(script)) return "仅支持白名单 Host 测试。";
    if (this.running) return "已有一项 Host 测试正在运行，请等待完成。";
    this.running = true;
    try {
      return await this.execute(script, signal);
    } finally {
      this.running = false;
    }
  }

  private async execute(script: HostTestScript, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return "测试已取消。";
    const started = Date.now();
    const timeoutMs = script === "runtime:diagnose" ? this.diagnosticTimeoutMs : this.timeoutMs;
    return new Promise<string>((resolve) => {
      // Windows cannot spawn .cmd directly with shell:false. Only the immutable
      // allowlisted script reaches cmd.exe; no user arguments or shell fragments.
      const windows = process.platform === "win32";
      const child = spawn(windows ? process.env.ComSpec || "cmd.exe" : "npm",
        windows ? ["/d", "/s", "/c", "npm.cmd", "run", script] : ["run", script], {
        cwd: this.cwd,
        env: process.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let tail = "";
      let truncated = false;
      let timedOut = false;
      let spawnError = false;
      let force: ReturnType<typeof setTimeout> | undefined;

      const collect = (chunk: Buffer | string) => {
        tail += String(chunk);
        if (tail.length > MAX_CAPTURE_CHARS) {
          tail = tail.slice(-MAX_CAPTURE_CHARS);
          truncated = true;
        }
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);

      const killGroup = (signal: NodeJS.Signals) => {
        if (windows && child.pid) {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", () => { try { child.kill(signal); } catch {} });
          return;
        }
        if (child.pid && process.platform !== "win32") {
          try { process.kill(-child.pid, signal); return; } catch {}
        }
        try { child.kill(signal); } catch {}
      };
      const abort = () => { killGroup("SIGTERM");force=setTimeout(()=>killGroup("SIGKILL"),1500);force.unref?.(); };
      signal?.addEventListener("abort",abort,{once:true});
      if(signal?.aborted)abort();
      const timeout = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        force = setTimeout(() => killGroup("SIGKILL"), 1_500);
        force.unref?.();
      }, timeoutMs);
      child.once("error", () => { spawnError = true; });
      child.once("close", (code, exitSignal) => {
        signal?.removeEventListener("abort",abort);
        clearTimeout(timeout);
        if (force) clearTimeout(force);
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const passed = code === 0 && !timedOut && !spawnError && !signal?.aborted;
        const status = signal?.aborted ? "已取消" : timedOut ? "超时" : spawnError ? "无法启动" : passed ? "通过" : "失败";
        const details = tail
          .replace(/\x1b\[[0-9;]*m/g, "")
          .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
          .trim();
        const safe = redactLogText(details);
        const output = safe.length > MAX_REPLY_CHARS ? safe.slice(-MAX_REPLY_CHARS) : safe;
        resolve([
          "Host 测试：" + script,
          "结果：" + status + " · " + elapsed + "s" +
            (timedOut ? "（" + Math.ceil(timeoutMs / 1000) + "s 限制）" : " · exit=" + (code ?? exitSignal ?? "?")),
          "",
          ...(output ? [truncated || safe.length > MAX_REPLY_CHARS ? "末尾输出（已截断、脱敏）：" : "输出（已脱敏）：", output] : ["没有输出。"]),
        ].join("\n"));
      });
    });
  }
}
