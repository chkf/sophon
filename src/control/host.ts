import { readFile, statfs } from "node:fs/promises";
import { cpus, freemem, platform, totalmem, uptime, type CpuInfo } from "node:os";
import { performance } from "node:perf_hooks";

export interface HostSample {
  at: string;
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  swapUsedBytes: number | null;
  swapTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  rxBytesPerSecond: number | null;
  txBytesPerSecond: number | null;
}

export interface HostSnapshot {
  supported: boolean;
  at: string;
  samples: HostSample[];
  uptimeSeconds: number;
  processUptimeSeconds: number;
  rssBytes: number;
  networkInterfaces: string[];
  scopeNotes: string[];
}

export interface CpuCounters { total: number; idle: number; cores: number }
export interface NetworkCounters { name: string; rx: bigint; tx: bigint }
type MemorySample = Pick<HostSample, "memoryUsedBytes" | "memoryTotalBytes" | "swapUsedBytes" | "swapTotalBytes">;
const emptyMemory: MemorySample = { memoryUsedBytes: null, memoryTotalBytes: null, swapUsedBytes: null, swapTotalBytes: null };
const SAMPLE_INTERVAL_MS = 5_000;
const MAX_SAMPLES = 120;

function validCount(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }

export function cpuCounters(values: CpuInfo[]): CpuCounters | undefined {
  if (!values.length) return undefined;
  let total = 0, idle = 0;
  for (const { times } of values) {
    const counters = [times.user, times.nice, times.sys, times.idle, times.irq];
    if (!counters.every(validCount)) return undefined;
    total += counters.reduce((sum, value) => sum + value, 0);
    idle += times.idle;
  }
  return validCount(total) && validCount(idle) ? { total, idle, cores: values.length } : undefined;
}

/** A baseline, reset, hot-plug or missing interval is not a zero-usage sample. */
export function cpuPercent(previous: CpuCounters | undefined, current: CpuCounters | undefined): number | null {
  if (!previous || !current || previous.cores !== current.cores) return null;
  const total = current.total - previous.total, idle = current.idle - previous.idle;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return 100 * (total - idle) / total;
}

export function parseLinuxMemory(text: string): MemorySample {
  const fields = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_]+):\s+(\d+)\s+kB\s*$/.exec(line);
    if (!match) continue;
    const value = Number(match[2]) * 1024;
    if (validCount(value)) fields.set(match[1], value);
  }
  const total = fields.get("MemTotal"), available = fields.get("MemAvailable");
  const swap = fields.get("SwapTotal"), freeSwap = fields.get("SwapFree");
  return {
    memoryTotalBytes: total !== undefined && total > 0 ? total : null,
    memoryUsedBytes: total !== undefined && total > 0 && available !== undefined && available <= total ? total - available : null,
    swapTotalBytes: swap ?? null,
    swapUsedBytes: swap !== undefined && freeSwap !== undefined && freeSwap <= swap ? swap - freeSwap : null,
  };
}

export function parseLinuxNetwork(text: string): NetworkCounters[] | undefined {
  const interfaces: NetworkCounters[] = [];
  for (const line of text.split("\n")) {
    const colon = line.lastIndexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (name === "lo") continue;
    const fields = line.slice(colon + 1).trim().split(/\s+/);
    if (!name || fields.length < 16 || !fields.every(value => /^\d+$/.test(value))) return undefined;
    interfaces.push({ name, rx: BigInt(fields[0]), tx: BigInt(fields[8]) });
  }
  return interfaces.length ? interfaces.sort((a, b) => a.name.localeCompare(b.name)) : undefined;
}

/** Compare per-interface counters so a reset cannot be hidden by another interface's traffic. */
export function networkRates(previous: NetworkCounters[] | undefined, current: NetworkCounters[] | undefined,
  elapsedMs: number): { rxBytesPerSecond: number | null; txBytesPerSecond: number | null } {
  const unavailable = { rxBytesPerSecond: null, txBytesPerSecond: null };
  if (!previous?.length || !current?.length || previous.length !== current.length || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return unavailable;
  const prior = new Map(previous.map(value => [value.name, value]));
  let rx = 0n, tx = 0n;
  for (const value of current) {
    const before = prior.get(value.name);
    if (!before || value.rx < before.rx || value.tx < before.tx) return unavailable;
    rx += value.rx - before.rx;
    tx += value.tx - before.tx;
  }
  const rxRate = Number(rx) * 1000 / elapsedMs, txRate = Number(tx) * 1000 / elapsedMs;
  return Number.isFinite(rxRate) && Number.isFinite(txRate) ? { rxBytesPerSecond: rxRate, txBytesPerSecond: txRate } : unavailable;
}

/** Bounded in-memory host sampling. It never invokes a command or sends a network request. */
export class HostMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private readonly samples: HostSample[] = [];
  private previousCpu?: CpuCounters;
  private previousNetwork?: NetworkCounters[];
  private previousAt?: number;
  private interfaces: string[] = [];
  private notes: string[] = [];

  constructor(private readonly rootDir: string) {}

  start(): void {
    if (this.timer) return;
    void this.sample().catch(() => undefined);
    this.timer = setInterval(() => { void this.sample().catch(() => undefined); }, SAMPLE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.previousCpu = undefined;
    this.previousNetwork = undefined;
    this.previousAt = undefined;
  }

  async snapshot(): Promise<HostSnapshot> {
    if (!this.samples.length || this.pending) await this.sample();
    const latest = this.samples.at(-1)!;
    return {
      supported: latest.memoryTotalBytes !== null || latest.cpuPercent !== null || latest.diskTotalBytes !== null,
      at: latest.at,
      samples: this.samples.map(sample => ({ ...sample })),
      uptimeSeconds: uptime(), processUptimeSeconds: process.uptime(), rssBytes: process.memoryUsage().rss,
      networkInterfaces: [...this.interfaces], scopeNotes: [...this.notes],
    };
  }

  private sample(): Promise<void> {
    return this.pending ??= this.collect().finally(() => { this.pending = undefined; });
  }

  private async collect(): Promise<void> {
    const at = new Date().toISOString(), clock = performance.now(), linux = platform() === "linux";
    const notes = ["CPU 与内存为操作系统可见范围，不代表容器配额；RSS 为当前网关进程。", "磁盘统计为数据目录所在文件系统；每 5 秒采样，最多保留 120 个样本。"];
    let currentCpu: CpuCounters | undefined;
    try { currentCpu = cpuCounters(cpus()); } catch { /* Report missing CPU data below. */ }
    const [memoryResult, networkResult, diskResult] = await Promise.allSettled([
      linux ? readFile("/proc/meminfo", "utf8").then(parseLinuxMemory) : Promise.resolve().then(() => {
        const total = totalmem(), available = freemem();
        return { ...emptyMemory, memoryTotalBytes: validCount(total) && total > 0 ? total : null,
          memoryUsedBytes: validCount(total) && total > 0 && validCount(available) && available <= total ? total - available : null };
      }),
      linux ? readFile("/proc/net/dev", "utf8").then(parseLinuxNetwork) : Promise.resolve(undefined),
      statfs(this.rootDir),
    ]);
    const memory = memoryResult.status === "fulfilled" ? memoryResult.value : { ...emptyMemory };
    const network = networkResult.status === "fulfilled" ? networkResult.value : undefined;
    const rates = networkRates(this.previousNetwork, network, this.previousAt === undefined ? 0 : clock - this.previousAt);
    const cpu = cpuPercent(this.previousCpu, currentCpu);
    let diskTotalBytes: number | null = null, diskUsedBytes: number | null = null;
    if (diskResult.status === "fulfilled") {
      const { bsize, blocks, bfree } = diskResult.value;
      const total = bsize * blocks, used = bsize * (blocks - bfree);
      if (validCount(total) && total > 0 && validCount(used) && used <= total) { diskTotalBytes = total; diskUsedBytes = used; }
    }
    if (cpu === null) notes.push(currentCpu ? "CPU 需要两个连续有效样本；计数重置或核心变化时本次不可用。" : "CPU 计数暂不可用。");
    if (memory.memoryUsedBytes === null) notes.push("内存使用量暂不可用。");
    if (linux && memory.memoryUsedBytes !== null) notes.push("Linux 内存使用量按 MemTotal − MemAvailable 计算，包含可回收缓存的影响。");
    if (memory.swapUsedBytes === null) notes.push(linux ? "Swap 数据暂不可用。" : "当前系统未提供此采样方式的 Swap 数据。");
    if (diskUsedBytes === null) notes.push("数据目录所在文件系统的容量暂不可用。");
    if (network) {
      notes.push("网络汇总非 loopback 接口；虚拟接口可能重复计算同一流量，不代表运营商账单。");
      if (rates.rxBytesPerSecond === null) notes.push("网络速率需要两个连续有效样本；接口或计数变化时本次不可用。");
    } else notes.push(linux ? "非 loopback 网络计数暂不可用。" : "当前系统未提供此采样方式的网络速率。");
    this.samples.push({ at, cpuPercent: cpu, ...memory, diskUsedBytes, diskTotalBytes, ...rates });
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    this.previousCpu = currentCpu;
    this.previousNetwork = network;
    this.previousAt = clock;
    this.interfaces = network?.map(value => value.name) ?? [];
    this.notes = notes;
  }
}
