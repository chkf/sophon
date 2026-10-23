import { writeLegacyPersonaFixture } from "../../scripts/testing/persona-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProviderRuntime } from "./providers.js";
import { ProviderDeliveryStore } from "./delivery-store.js";
import { SessionStore } from "../sessions/store.js";
import { DeliveryCoordinator } from "../delivery/coordinator.js";
import { PersonaStore } from "../persona/store.js";
import { migrateState } from "../state/migration.js";
import { migrateSchemaDatabase } from "../state/schema.js";
import { mainPath, openDatabase } from "../state/database.js";

async function temp(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "delivery-contract-"));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function migrateFixture(root: string, version: 1 | 2): Promise<void> {
  await mkdir(join(root, "core"));
  await writeFile(join(root, "core", "core.md"), "# Synthetic Core\n合成交付测试。\n");
  await writeLegacyPersonaFixture(root,"default");
  new SessionStore(root).close();
  await migrateState(root, true);
  if (version === 2) {
    const db = openDatabase(mainPath(root));
    try { migrateSchemaDatabase(db, root); } finally { db.close(); }
  }
}
function providers(root: string) {
  const events: unknown[][] = [];
  const runtime = (name: string) => ({ async getSession() { return { status: "connected", sharing: true }; },
    async getModelSelection() { return { mode: "auto" }; }, async reply() { return { text: name }; },
    async commitSession(...args: unknown[]) { events.push([name, "commit", ...args]); },
    async resetSession(...args: unknown[]) { events.push([name, "reset", ...args]); } });
  const lanes = { siwc: runtime("siwc"), openrouter: runtime("openrouter") };
  return { runtime: new ProviderRuntime(root, lanes as never), lanes, events };
}
const turn = (deliveryId: string) => ({ purpose: "chat" as const, sessionId: "telegram:owner", text: "你好", deferAssistantCommit: true, deliveryId });

test("stale and duplicate delivery IDs cannot settle or erase a new reply; restart keeps original provider", () => temp(async root => {
  const f = providers(root);
  await f.runtime.reply(turn("old"));
  await f.runtime.reply(turn("new"));
  assert.equal(await f.runtime.commitSession("telegram:owner", "old", "old"), false);
  assert.equal(await f.runtime.resetSession("telegram:owner", "old"), false);
  await f.runtime.selectProvider("openrouter");
  const restarted = new ProviderRuntime(root, f.lanes as never);
  const sessions = new SessionStore(root);
  try { const delivery = new DeliveryCoordinator(restarted, sessions);
  await delivery.commitDeliveredAssistant("telegram", "owner", "owner", "new", undefined, "new");
  await delivery.commitDeliveredAssistant("telegram", "owner", "owner", "duplicate", undefined, "new");
  assert.deepEqual(f.events.filter(e => e[1] === "commit"), [["siwc", "commit", "telegram:owner", "new", "new"]]);
  assert.equal((await sessions.get("telegram", "owner"))?.messages.length, 1);
  } finally { sessions.close(); }
}));

test("ticket settlement and transcript write serialize with the next generation", () => temp(async root => {
  const f = providers(root); await f.runtime.reply(turn("old"));
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const commit = f.runtime.settleSessionDelivery("telegram:owner", "old", "delivered", async () => { started(); await gate; });
  await entered;
  const next = f.runtime.reply(turn("new"));
  release(); await Promise.all([commit, next]);
  const store = new ProviderDeliveryStore(join(root, "runtime", "provider.json.deliveries"));
  assert.equal((await store.read("telegram:owner"))?.deliveryId, "new");
}));

test("failed WeChat history recording survives restart and blocks an intervening Telegram generation without losing the delivery", () => temp(async root => {
  await migrateFixture(root, 2);
  const f = providers(root);
  let generations = 0;
  for (const lane of Object.values(f.lanes)) lane.reply = async () => { generations++; return { text: "已确认发送的答复" }; };
  let sessions: SessionStore | undefined = new SessionStore(root);
  const sessionId = "telegram:123", user = "synthetic-wechat-owner", deliveryId = "wechat-delivery";
  const ticketStore = new ProviderDeliveryStore(join(root, "runtime", "provider.json.deliveries"));
  const fragments = [{ accountId: "synthetic-bot", conversationId: user, direction: "outbound" as const,
    messageId: "platform-receipt-1", text: "已确认发送的答复" }];
  const db = new DatabaseSync(join(root, "sessions", "gateway.sqlite"));
  try {
    await sessions.bindOwnerSession("123", user);
    await sessions.append("wechat", user, user, [{ id: "wechat-inbound", role: "user", content: "合成请求",
      at: "2026-10-22T08:00:00.000Z", source: { channel: "wechat" } }]);
    await f.runtime.reply({ ...turn(deliveryId), sessionId });
    db.exec("CREATE TRIGGER fail_history_record BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'injected history failure'); END;");
    const delivery = new DeliveryCoordinator(f.runtime, sessions);
    await assert.rejects(delivery.commitDeliveredAssistant("wechat", user, user, "已确认发送的答复",
      undefined, deliveryId, true, fragments), /injected history failure/);
    assert.equal((await ticketStore.read(sessionId))?.recordPending, true);
    assert.equal((await ticketStore.read(sessionId))?.deliveryId, deliveryId);
    assert.deepEqual(f.events, [], "a failed transcript write does not commit or reset its provider lane");
    await assert.rejects(f.runtime.reply({ ...turn("telegram-next"), sessionId }), error =>
      error instanceof Error && (error as Error & { inboundRetryable?: boolean }).inboundRetryable === true);
    assert.equal(generations, 1, "the new Telegram request has not called any model");
    assert.equal((await sessions.get("telegram", "123"))?.messages.length, 1);

    sessions.close(); sessions = undefined;
    db.exec("DROP TRIGGER fail_history_record");
    const restarted = new ProviderRuntime(root, f.lanes as never);
    await restarted.selectProvider("openrouter");
    await assert.rejects(restarted.reply({ ...turn("telegram-after-restart"), sessionId }), /历史保存尚未完成/);
    assert.equal(await restarted.resetSession(sessionId, deliveryId), false);
    assert.equal(await restarted.commitSession(sessionId, "cannot skip recording", deliveryId), false);
    let unrelatedRecording = false;
    assert.equal(await restarted.settleSessionDelivery(sessionId, deliveryId, "cannot use a non-durable acknowledgement",
      async () => { unrelatedRecording = true; }), false);
    assert.equal(unrelatedRecording, false);
    assert.equal(generations, 1);
    assert.equal((await ticketStore.read(sessionId))?.recordPending, true);
    sessions = new SessionStore(root);
    const resumed = new DeliveryCoordinator(restarted, sessions);
    await resumed.commitDeliveredAssistant("wechat", user, user, "已确认发送的答复", undefined, deliveryId, true, fragments);
    await resumed.commitDeliveredAssistant("wechat", user, user, "已确认发送的答复", undefined, deliveryId, true, fragments);
    const history = await sessions.get("telegram", "123");
    assert.equal(history!.messages.length, 2);
    assert.equal(history!.messages[1]!.id, deliveryId + ":assistant");
    assert.deepEqual(history!.messages[1]!.source?.platformMessages, fragments);
    assert.equal(history!.messages[1]!.source?.channel, "wechat");
    assert.equal(await ticketStore.read(sessionId), undefined);
    assert.deepEqual(f.events, [["siwc", "commit", sessionId, "已确认发送的答复", deliveryId]],
      "settlement stays on the original provider and is not repeated");
    await restarted.reply({ ...turn("telegram-resumed"), sessionId });
    assert.equal(generations, 2, "normal generation resumes only after recording succeeds");
  } finally { db.close(); sessions?.close(); }
}));

test("provider settlement failure retains the recording ticket and retry does not duplicate committed history", () => temp(async root => {
  await migrateFixture(root, 2);
  const f = providers(root), sessions = new SessionStore(root);
  const tickets = new ProviderDeliveryStore(join(root, "runtime", "provider.json.deliveries"));
  let fail = true, commits = 0;
  f.lanes.siwc.commitSession = async () => {
    commits++;
    if (fail) throw new Error("injected provider settlement failure");
  };
  try {
    await f.runtime.reply({ ...turn("provider-failure"), sessionId: "wechat:owner" });
    const delivery = new DeliveryCoordinator(f.runtime, sessions);
    await assert.rejects(delivery.commitDeliveredAssistant("wechat", "owner", "owner", "已落库答复",
      undefined, "provider-failure"), /injected provider settlement failure/);
    assert.equal((await sessions.get("wechat", "owner"))?.messages.length, 1);
    assert.equal((await tickets.read("wechat:owner"))?.recordPending, true);
    fail = false;
    const restarted = new ProviderRuntime(root, f.lanes as never);
    const resumed = new DeliveryCoordinator(restarted, sessions);
    await resumed.commitDeliveredAssistant("wechat", "owner", "owner", "已落库答复", undefined, "provider-failure");
    await resumed.commitDeliveredAssistant("wechat", "owner", "owner", "已落库答复", undefined, "provider-failure");
    assert.equal((await sessions.get("wechat", "owner"))?.messages.length, 1);
    assert.equal(await tickets.read("wechat:owner"), undefined);
    assert.equal(commits, 2, "only the failed settlement is retried; duplicate acknowledgement is ignored");
  } finally { sessions.close(); }
}));

for (const [version, channel] of [[0, "telegram"], [1, "telegram"], [2, "telegram"], [0, "wechat"], [1, "wechat"]] as const) {
  test(`${channel} schema ${version} settles a failed history write without permanently blocking the next generation`, () => temp(async root => {
    if (version > 0) await migrateFixture(root, version);
    const f = providers(root), sessions = new SessionStore(root);
    const tickets = new ProviderDeliveryStore(join(root, "runtime", "provider.json.deliveries"));
    const db = new DatabaseSync(mainPath(root));
    const sessionId = channel + ":owner";
    let runtime = f.runtime, generations = 0;
    f.lanes.siwc.reply = async () => { generations++; return { text: "已确认发送的答复" }; };
    try {
      db.exec("CREATE TRIGGER fail_history_record BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'injected history failure'); END;");
      for (const complete of [true, false]) {
        const deliveryId = complete ? "complete-delivery" : "partial-delivery";
        await runtime.reply({ ...turn(deliveryId), sessionId });
        const delivery = new DeliveryCoordinator(runtime, sessions);
        await assert.rejects(delivery.commitDeliveredAssistant(channel, "owner", "owner", "已确认发送的答复",
          undefined, deliveryId, complete), /injected history failure/);
        assert.equal(await tickets.read(sessionId), undefined, "a non-replayable acknowledgement cannot create a pending-record lock");
        assert.deepEqual(f.events.at(-1), complete
          ? ["siwc", "commit", sessionId, "已确认发送的答复", deliveryId]
          : ["siwc", "reset", sessionId, deliveryId]);
        await delivery.commitDeliveredAssistant(channel, "owner", "owner", "duplicate", undefined, deliveryId, complete);
        assert.equal((await sessions.get(channel, "owner"))?.messages.length ?? 0, 0);
        runtime = new ProviderRuntime(root, f.lanes as never);
      }
      await runtime.reply({ ...turn("after-record-failure"), sessionId });
      assert.equal(generations, 3, "generation resumes after both complete and partial acknowledgement failures, including restart");
      assert.equal((await tickets.read(sessionId))?.recordPending, undefined);
    } finally { db.close(); sessions.close(); }
  }));
}

test("unbound legacy ticket remains recovery evidence and cannot accept a session-only acknowledgement", () => temp(async root => {
  const f = providers(root); const path = join(root, "runtime", "provider.json.deliveries");
  const store = new ProviderDeliveryStore(path);
  await store.write("telegram:owner", { provider: "siwc", id: "legacy-lane" });
  assert.equal(await f.runtime.commitSession("telegram:owner", "unsafe"), false);
  await f.runtime.reply(turn("new"));
  assert.ok((await readdir(path)).some(name => name.endsWith(".legacy-recovery")));
  assert.equal((await store.read("telegram:owner"))?.deliveryId, "new");
  await store.write("telegram:owner", { provider: "siwc", id: "another-legacy-lane" });
  await f.runtime.reply(turn("later"));
  const archives = (await readdir(path)).filter(name => name.endsWith(".legacy-recovery"));
  assert.equal(archives.length, 2);
  assert.deepEqual((await Promise.all(archives.map(async name => JSON.parse(await readFile(join(path, name), "utf8")).id))).sort(), ["another-legacy-lane", "legacy-lane"]);
}));
