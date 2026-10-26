import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeGateway } from "./setup.js";
import { LocalCoreContextProvider } from "./core/context.js";
import { ExpressionStore } from "./expression/store.js";
import { SessionStore } from "./sessions/store.js";

test("fresh standalone setup creates usable context and schema without remote services", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-init-")), data = join(root, "data");
  try {
    await initializeGateway(data);
    const context = await new LocalCoreContextProvider(data).load();
    assert.equal(context.available, true);
    assert.match(context.data!.core, /用户自行配置/);
    const personas = await new ExpressionStore(data).snapshot();
    assert.deepEqual(Object.keys(personas), ["showStageDirections"]);
    assert.equal(personas.showStageDirections, false);
    const sessions = new SessionStore(data);
    try {
      await sessions.prepare();
      assert.equal(sessions.supportsDurableIlinkDelivery(), true);
    } finally { sessions.close(); }
    await assert.rejects(initializeGateway(data), /refuses to overwrite/);
    assert.equal((await new LocalCoreContextProvider(data).load()).data!.core, context.data!.core);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("setup preserves any pre-existing directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-init-preserve-"));
  try {
    await writeFile(join(root, "keep.txt"), "existing user data");
    await assert.rejects(initializeGateway(root), /refuses to overwrite/);
    assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "existing user data");
  } finally { await rm(root, { recursive: true, force: true }); }
});
