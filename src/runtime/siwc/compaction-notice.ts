import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../../util/atomic-json.js";
import type { CompactionCheckpoint } from "./stateful-types.js";

/** A durable, write-before-send at-most-once claim. Markers live in the
 * existing schema-v2 gateway_state runtime/context namespace. A crashed send
 * may be missed, but a retried turn never produces duplicate owner messages. */
export class CompactionNoticeLedger {
  constructor(private readonly dataDir: string) {}
  private path(id: string): string {
    const key = createHash("sha256").update("siwc-notice:" + id).digest("hex");
    return join(this.dataDir, "runtime", "context", key + ".json");
  }
  async claim(checkpoint: CompactionCheckpoint): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(checkpoint.id)) throw new Error("Invalid SIWC compaction event ID.");
    const path = this.path(checkpoint.id);
    const prior = await readJsonFile<{ version: 1; id: string } | undefined>(path, undefined);
    if (prior) {
      if (prior.version !== 1 || prior.id !== checkpoint.id) throw new Error("Compaction notice receipt corrupted.");
      return false;
    }
    await writeJsonAtomic(path, { version: 1, id: checkpoint.id, claimedAt: new Date().toISOString() });
    return true;
  }
}
