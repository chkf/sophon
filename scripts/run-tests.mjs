import { availableParallelism } from "node:os";
import { readdir, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTestSandbox } from "./testing/environment.mjs";
async function discover(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await discover(path));
    else if (/\.test\.(ts|mjs)$/.test(path)) files.push(path);
  }
  return files.sort();
}
const source = fileURLToPath(new URL("../", import.meta.url));
const files = (await Promise.all(["src", "scripts/testing"].map(dir => discover(join(source, dir))))).flat();
const sandbox = await createTestSandbox();
try {
  // Some restricted execution hosts start test workers but suppress their pipe
  // output. Node can then report only file-level successes without running the
  // reported cases. Refuse that environment instead of claiming a test pass.
  const ready = "gateway-test-worker-ready";
  let probe;
  try {
    probe = await promisify(execFile)(process.execPath, ["-e", "process.stdout.write(" + JSON.stringify(ready) + ")"],
      { cwd: sandbox.root, env: sandbox.env, timeout: 10_000, maxBuffer: 1024 });
  } catch { throw new Error("测试子进程 I/O 不可用；测试套件尚未执行，请使用支持本地子进程的开发环境。"); }
  if (probe.stdout !== ready) throw new Error("测试子进程未返回就绪凭据；拒绝把文件级退出状态记为用例通过。");
  // Absolute source/loader paths let cwd remain empty: loadConfig cannot read the
  // checkout's .env, and default data paths cannot open the running Host's state.
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--test", "--test-concurrency="+Math.min(4,availableParallelism()), ...files], {
    cwd: sandbox.root, env: sandbox.env, stdio: "inherit",
  });
  process.exitCode = await new Promise(resolve => {
    child.once("error", () => resolve(1));
    child.once("close", code => resolve(code ?? 1));
  });
} finally {
  await rm(sandbox.root, { recursive: true, force: true });
}
