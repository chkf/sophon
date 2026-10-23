import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readDocument } from "../state/database.js";

export interface LocalCore {
  text: string;
}
export class CoreUnavailableError extends Error {}

export function validateCore(text: string): void {
  if (!text.trim() || text.includes("\u0000") || text.includes("\ufffd") || Buffer.byteLength(text, "utf8") > 256 * 1024) {
    throw new CoreUnavailableError("Core 为空、损坏或超过 256 KiB。");
  }
}

/** Load the current local Core directly.
 * The managed database is authoritative after migration.
 * Reject missing, invalid, symbolic-link or unexpectedly large Core files.
 */
export async function loadCore(dataDir: string): Promise<LocalCore> {
  const path = join(dataDir, "core", "core.md");
  try {
    const stored = readDocument(path);
    if (stored.managed) {
      if (stored.value === undefined) throw new CoreUnavailableError("数据库中的 Core 缺失；不会回退读取旧文件。");
      validateCore(stored.value);
      return { text: stored.value };
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new CoreUnavailableError("Core 路径必须是本地普通文件。");
    }
    if (info.size > 256 * 1024) {
      throw new CoreUnavailableError("Core 文件异常过大。");
    }
    const text = await readFile(path, "utf8");
    validateCore(text);
    return { text };
  } catch (error) {
    if (error instanceof CoreUnavailableError) throw error;
    throw new CoreUnavailableError("本地 Core 缺失、损坏或不可读取。");
  }
}
