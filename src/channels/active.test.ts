import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActiveChannelRouter } from "./active.js";

test("active proactive channel persists and never falls back", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-channel-"));
  try {
    const sent: string[] = [];
    const telegram = {
      channel: "telegram" as const,
      async availableTarget() { return "tg-user"; },
      async sendText(target: string, text: string) { sent.push("tg:" + target + ":" + text); },
    };
    const router = new ActiveChannelRouter(root, { telegram }, "telegram");
    assert.equal(await router.getActive(), "telegram");
    assert.deepEqual(await router.resolve(), { channel: "telegram", target: "tg-user" });

    await router.setActive("off");
    assert.equal(await router.resolve(), undefined);
    assert.equal(await router.sendIfActive("telegram", "tg-user", "hello"), false);
    assert.deepEqual(sent, []);

    await assert.rejects(router.setActive("wechat"), /微信还没有配置/);

    const restarted = new ActiveChannelRouter(root, { telegram }, "telegram");
    assert.equal(await restarted.getActive(), "off");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
