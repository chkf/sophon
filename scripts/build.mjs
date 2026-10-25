import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cp, lstat, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "dist");
if (relative(root, output) !== "dist" || resolve(process.cwd()) !== resolve(root)) {
  throw new Error("Build must run from the project root with its own dist directory.");
}
const previous = await lstat(output).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
if (previous?.isSymbolicLink()) throw new Error("Refusing to clean a linked build directory.");
// Regenerate only this project's output so deleted modules cannot survive a build.
await rm(output, { recursive: true, force: true });
const compiler = new URL("../node_modules/typescript/bin/tsc", import.meta.url);
const result = spawnSync(process.execPath, [fileURLToPath(compiler), "-p", "tsconfig.json"], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
await cp("schema-compatibility.json", "dist/schema-compatibility.json");

await cp("src/control/assets", "dist/control/assets", { recursive: true });
