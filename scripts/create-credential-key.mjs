import { randomBytes } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const path = resolve(process.argv[2] || "./secrets/chatgpt-credential.key");

await mkdir(dirname(path), { recursive: true, mode: 0o700 });
const file = await open(path, "wx", 0o600);
try {
  await file.writeFile(randomBytes(32).toString("base64") + "\n", "utf8");
  await file.sync();
} finally {
  await file.close();
}
console.log("Created managed credential key: " + path);
console.log("Keep this file secret. Never commit it.");
