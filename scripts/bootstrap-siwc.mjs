import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { commandSpec } from "./host/process.mjs";

const OFFICIAL_REPO = "https://github.com/openai/sign-in-with-chatgpt-devkit.git";
const PINNED_REF = "f723814abdccec135b519c451fb6e1992ee5e933";
const root = fileURLToPath(new URL("..", import.meta.url));
const target = join(root, "vendor", "siwc");
const requestedRef = process.env.SIWC_DEVKIT_REF?.trim() || PINNED_REF;

function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const spec = commandSpec(command, args);
    const child = spawn(spec.file, spec.args, { cwd, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

function capture(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const spec = commandSpec(command, args);
    const child = spawn(spec.file, spec.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8").trim());
      else {
        reject(
          new Error(
            Buffer.concat(stderr).toString("utf8").trim() || `${command} failed.`,
          ),
        );
      }
    });
  });
}

async function main() {
  if (!process.argv.includes("--accept-noncommercial-license")) throw new Error("SIWC is optional and uses the OpenAI noncommercial license. Read docs/optional-siwc.md, then explicitly pass --accept-noncommercial-license to install.");
  await mkdir(dirname(target), { recursive: true });
  const gitDir = join(target, ".git");

  if (existsSync(gitDir)) {
    const currentHead = await capture("git", ["rev-parse", "HEAD"], target).catch(() => "");
    const builtEntry = join(target, "packages", "local", "dist", "index.js");
    const runtimeDependency = join(target, "node_modules", "jose", "package.json");
    if (currentHead === requestedRef && existsSync(builtEntry) && existsSync(runtimeDependency)) {
      console.log(`SIWC DevKit already ready at ${target}`);
      console.log(`Pinned revision: ${currentHead}`);
      return;
    }
  }

  if (!existsSync(gitDir)) {
    if (existsSync(target)) await rm(target, { recursive: true, force: true });
    await run("git", ["clone", "--filter=blob:none", "--no-checkout", OFFICIAL_REPO, target]);
  } else {
    const origin = await capture("git", ["remote", "get-url", "origin"], target);
    if (origin !== OFFICIAL_REPO) {
      throw new Error(
        `Refusing to use ${target}: origin is ${origin}, expected ${OFFICIAL_REPO}.`,
      );
    }
  }

  await run("git", ["fetch", "--depth", "1", "origin", requestedRef], target);
  await run("git", ["checkout", "--detach", "FETCH_HEAD"], target);
  const head = await capture("git", ["rev-parse", "HEAD"], target);
  if (head !== requestedRef) {
    throw new Error(`DevKit checkout mismatch: expected ${requestedRef}, got ${head}.`);
  }

  await run(
    "npm",
    ["ci", "--workspace", "@siwc/local", "--include-workspace-root"],
    target,
  );
  await run("npm", ["run", "build", "--workspace", "@siwc/local"], target);

  console.log(`SIWC DevKit ready at ${target}`);
  console.log(`Pinned revision: ${head}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
