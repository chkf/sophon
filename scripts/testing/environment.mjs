import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Inherit only OS/process essentials, never application settings, credentials
// or Node preload options from the machine running the tests.
const systemKeys = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
  "TEMP", "TMP", "TMPDIR", "LANG", "LANGUAGE", "TZ", "TERM",
  "NO_COLOR", "FORCE_COLOR",
]);

export function cleanTestEnvironment(source = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (systemKeys.has(name.toUpperCase()) || /^LC_[A-Z_]+$/i.test(name))) env[name] = value;
  }
  return env;
}

export async function createTestSandbox(source = process.env) {
  const root = await mkdtemp(join(tmpdir(), "gateway-tests-"));
  return { root, env: { ...cleanTestEnvironment(source), GATEWAY_DATA_DIR: join(root, "data") } };
}
