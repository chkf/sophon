import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeGateway } from "../setup.js";
import { GatewayService } from "../service.js";
import type { GatewayConfig } from "../config/index.js";
import { SessionStore } from "../sessions/store.js";

test("control entry is owner-only, local, and never becomes model history", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-control-entry-")), dataDir = join(root, "data");
  await initializeGateway(dataDir);
  const config: GatewayConfig = {
    dataDir, control: { publicUrl: "http://127.0.0.1:8790/control/" },
    siwcDevkitDir: join(root, "unused"), provider: "api", maxToolRounds: 2,
    telegram: { token: "fixture-token", ownerId: "100" }, server: { host: "127.0.0.1", port: 8790 },
    heartbeat: { enabled: false, timezone: "UTC", quietStart: "01:00", quietEnd: "07:00", cooldownMinutes: 60, dailyCap: 8, minIntervalMinutes: 60, maxIntervalMinutes: 120 },
  };
  const service = new GatewayService(config, { reply: () => assert.fail("login must not call a model") } as never);
  const invoke = (service as unknown as { handleInbound(message: unknown): Promise<{ text: string }> }).handleInbound.bind(service);
  const inbound = { channel: "telegram", conversationId: "100", senderId: "100", messageId: "fixture-command", text: "/status", receivedAt: new Date().toISOString(), attachments: [] };
  try {
    const owner = await invoke(inbound);
    assert.match(owner.text, /Sophon 控制中心/);
    assert.match(owner.text, /备用登录码/);
    assert.match(owner.text, /手机不能直接使用此地址/);
    const other = await invoke({ ...inbound, senderId: "200", conversationId: "200" });
    assert.match(other.text, /管理员私聊/);
    assert.doesNotMatch(other.text, /[A-Za-z0-9_-]{43}/);
    const history = new SessionStore(dataDir);
    try { assert.equal((await history.summary()).total, 0); } finally { history.close(); }
  } finally { await service.stop(); await rm(root, { recursive: true, force: true }); }
});
