import { createHash } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { centralEnabled, mainPath, openDatabase, transaction } from "../../state/database.js";
import { hasUnresolvedToolEvidence } from "./responses-codec.js";
import { LaneStore } from "./lane-store.js";
import { readJsonFile } from "../../util/atomic-json.js";

const contextKey = (id: string) => "runtime/context/" + createHash("sha256").update(id).digest("hex") + ".json";
const baseSession = (id: string) => id.replace(/:provider:siwc:\d+$/, "");
const laneId = (base: string, epoch: number) => epoch === 0 ? base : base + ":provider:siwc:" + epoch;

/** Only the selected, durably settled model may retire siblings. Generation IDs
 * remain reserved; switching back rebuilds from history instead of stale context. */
export async function cleanupInactiveModelContexts(dataDir: string, currentId: string, protectedIds: ReadonlySet<string> = new Set()): Promise<{ removed: number; sessions: string[] }> {
  const empty = { removed: 0, sessions: [] as string[] };
  const selection = await readJsonFile<any>(join(dataDir,"runtime","provider.json"), undefined);
  const base = baseSession(currentId);
  if (!selection || selection.provider !== "siwc" || typeof selection.activeSiwcModel !== "string" ||
    !Number.isSafeInteger(selection.epoch) || selection.epoch < 0 || laneId(base,selection.epoch) !== currentId ||
    !selection.siwcEpochByModel || typeof selection.siwcEpochByModel !== "object" || Array.isArray(selection.siwcEpochByModel) ||
    Object.entries(selection.siwcEpochByModel).some(([model,epoch]) => !model || !Number.isSafeInteger(epoch) || (epoch as number) < 0) ||
    selection.siwcEpochByModel[selection.activeSiwcModel] !== selection.epoch) return empty;
  const current = await new LaneStore(dataDir).read(currentId);
  if (!settled(current) || current!.model !== selection.activeSiwcModel || current!.historyRebuildPending || current!.coverageVerified === false) return empty;
  const known = new Map<string,{id:string;model:string}>();
  for (const [model,epoch] of Object.entries(selection.siwcEpochByModel)) {
    const id = laneId(base,epoch as number);
    if (id !== currentId) known.set(contextKey(id),{id,model});
  }
  const sessions = new Set<string>();
  const removed = await cleanupContexts(dataDir,(key,text) => {
    if(key === contextKey(currentId))return false;
    let state;
    try {state=JSON.parse(text);} catch {return false;}
    // v1 omitted sessionId: identify only by the exact registered generation key.
    const legacy = known.get(key);
    if(state?.version===1 && state.sessionId===undefined && legacy && state.model===legacy.model) {
      state={...state,version:2,sessionId:legacy.id};
    }
    if(!settled(state) || protectedIds.has(state.sessionId) || state.sessionId===currentId || baseSession(state.sessionId)!==base)return false;
    if(key===contextKey(state.sessionId)) {sessions.add(state.sessionId);return true;}
    return transitionArchive(key,state);
  });
  return {removed,sessions:[...sessions]};
}

function settled(state: any): boolean {
  return state?.version === 2 && typeof state.sessionId === "string" &&
    typeof state.model === "string" && Array.isArray(state.contextItems) &&
    !state.contextItems.some((item: unknown) => !item || typeof item !== "object" || Array.isArray(item)) &&
    !Object.keys(state).some(field => field.startsWith("pending") && state[field] != null) &&
    !hasUnresolvedToolEvidence(state.contextItems);
}

function transitionArchive(key: string, state: any): boolean {
  return ["model-change", "control-change", "explicit-reset", ...(typeof state.archiveReason === "string" && state.archiveReason.startsWith("memory-rebase:") ? [state.archiveReason] : [])].some(reason => {
    const id = createHash("sha256").update(JSON.stringify([state.sessionId, state.model,
      state.checkpoint?.id ?? state.controlRevision ?? "", reason])).digest("hex");
    return key === "runtime/context/" + id + ".json";
  });
}

/** Startup owns the instance lock: validate old contexts against durable chat evidence. */
export async function cleanupConfirmedArchivesOnStartup(dataDir: string): Promise<number> {
  if (!centralEnabled(dataDir)) return 0;
  const db = openDatabase(mainPath(dataDir));
  const store = new LaneStore(dataDir);
  try {
    const rows = db.prepare("SELECT key,json_extract(value,'$.sessionId') AS sessionId FROM gateway_state WHERE category='runtime' AND encoding='json' AND key GLOB 'runtime/context/*.json' AND json_valid(value)").all() as {key:string;sessionId:unknown}[];
    const confirmed = new Map<string,number>();
    for (const row of rows) {
      if (typeof row.sessionId !== "string") continue;
      const id = row.sessionId;
      if (row.key !== "runtime/context/" + createHash("sha256").update(id).digest("hex") + ".json") continue;
      let current;
      try { current = await store.read(id); } catch { continue; }
      if (!settled(current) || current!.historyRebuildPending || current!.coverageVerified === false ||
        !Number.isSafeInteger(current!.historyCursor) || current!.historyCursor! < 1) continue;
      const conversation = id.replace(/:provider:siwc:\d+$/, "");
      const receipt = db.prepare("SELECT role,origin,partial FROM messages WHERE conv_key=? AND seq=?")
        .get(conversation, current!.historyCursor! - 1) as {role:string;origin:string|null;partial:number|null}|undefined;
      if (receipt?.role === "assistant" && receipt.origin === "chat" && receipt.partial !== 1) {
        confirmed.set(id, current!.historyCursor!);
      }
    }
    let removed = await cleanupContexts(dataDir, (key, text) => {
      let state;
      try { state = JSON.parse(text); } catch { return false; }
      if (!settled(state) || !transitionArchive(key,state)) return false;
      const through = confirmed.get(state.sessionId);
      return through !== undefined && Number.isSafeInteger(state.historyCursor) &&
        state.historyCursor >= 0 && state.historyCursor < through;
    });
    for (const id of confirmed.keys()) removed += (await cleanupInactiveModelContexts(dataDir,id)).removed;
    return removed;
  } finally { db.close(); }
}

/** Recognize only the exact archive format emitted by background resetSession. */
function disposable(key: string, text: string): boolean {
  let state;
  try { state = JSON.parse(text); } catch { return false; }
  if (!state || state.version !== 2 || typeof state.sessionId !== "string" ||
    !/^background:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(state.sessionId) ||
    typeof state.model !== "string" || !Array.isArray(state.contextItems) ||
    state.contextItems.some((item: unknown) => !item || typeof item !== "object" || Array.isArray(item)) ||
    Object.keys(state).some(field => field.startsWith("pending") && state[field] != null) ||
    hasUnresolvedToolEvidence(state.contextItems)) return false;
  const id = createHash("sha256").update(JSON.stringify([state.sessionId, state.model,
    state.checkpoint?.id ?? state.controlRevision ?? "", "explicit-reset"])).digest("hex");
  return key === "runtime/context/" + id + ".json";
}

/** Run only after the service instance lock and database integrity check. */
export async function cleanupBackgroundArchives(dataDir: string): Promise<number> {
  return cleanupContexts(dataDir, disposable);
}

/** Called only after a matching delivery receipt and durable canonical save. */
export async function cleanupSupersededArchives(dataDir: string, sessionId: string): Promise<number> {
  return cleanupContexts(dataDir, (key, text) => {
    let state;
    try { state = JSON.parse(text); } catch { return false; }
    if (!settled(state) || state.sessionId !== sessionId) return false;
    // Recognize known transition archives only. Preserve canonical lanes,
    // corrupt-recovery quarantine, foreign sessions and unknown legacy records.
    return transitionArchive(key, state);
  });
}

async function cleanupContexts(dataDir: string, disposable: (key: string, text: string) => boolean): Promise<number> {
  if (centralEnabled(dataDir)) {
    const db = openDatabase(mainPath(dataDir));
    try {
      return transaction(db, () => {
        // Read one payload at a time so old archives cannot exhaust a small VPS.
        const rows = db.prepare("SELECT key FROM gateway_state WHERE category='runtime' AND encoding='json' AND key GLOB 'runtime/context/*.json'").all() as {key: string}[];
        let removed = 0;
        const read = db.prepare("SELECT value FROM gateway_state WHERE key=?");
        const erase = db.prepare("DELETE FROM gateway_state WHERE key=?");
        for (const { key } of rows) {
          const row = read.get(key) as {value: string};
          if (disposable(key, row.value)) { erase.run(key); removed++; }
        }
        return removed;
      });
    } finally { db.close(); }
  }
  const directory = join(dataDir, "runtime", "context");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (disposable("runtime/context/" + entry.name, await readFile(path, "utf8"))) {
      await unlink(path); removed++;
    }
  }
  return removed;
}
