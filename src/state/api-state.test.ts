import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeGateway } from "../setup.js";
import { readJsonFile, writeJsonAtomic } from "../util/atomic-json.js";
import { getState, mainPath, openDatabase } from "./database.js";

test("API model selection and uncertain paid operations persist in SQLite across reopening", async () => {
  const parent = await mkdtemp(join(tmpdir(), "gateway-api-state-"));
  const root = join(parent, "data");
  try {
    await initializeGateway(root);
    const modelKey = "runtime/api-model.json";
    const turnKey = "runtime/api-turns/" + "a".repeat(64) + ".json";
    const model = { mode: "pinned", model: "local-tool-model" };
    const turn = { status: "started" };
    await writeJsonAtomic(join(root, modelKey), model);
    await writeJsonAtomic(join(root, turnKey), turn);
    assert.equal(existsSync(join(root, modelKey)), false);
    assert.equal(existsSync(join(root, turnKey)), false);
    assert.deepEqual(await readJsonFile(join(root, modelKey), null), model);
    assert.deepEqual(await readJsonFile(join(root, turnKey), null), turn);
    const db = openDatabase(mainPath(root), true);
    try {
      assert.equal(getState(db, modelKey)?.category, "settings");
      assert.equal(getState(db, turnKey)?.category, "runtime");
    } finally { db.close(); }
  } finally { await rm(parent, { recursive: true, force: true }); }
});
