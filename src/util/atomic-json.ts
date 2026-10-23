import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { readDocument, writeDocument, removeDocument } from "../state/database.js";
import { rm } from "node:fs/promises";

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  const stored = readDocument(path);
  if (stored.managed) return stored.value === undefined ? fallback : JSON.parse(stored.value) as T;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  if (writeDocument(path, value)) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

export async function removeJson(path: string): Promise<void> {
  if (!removeDocument(path)) await rm(path, { force: true });
}
