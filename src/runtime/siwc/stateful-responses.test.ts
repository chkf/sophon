import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../sessions/store.js";
import { recordDeliveredAssistant } from "../../delivery/coordinator.js";
import { historyFromMessages } from "../history.js";

test("Telegram reply-format preference resets on a new socket, not on every turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-voice-socket-scope-"));
  const first = new FakeSocket([messageResponse("first", "你好"), messageResponse("second", "文字回复")]);
  const second = new FakeSocket([messageResponse("third", "语音优先")]);
  let sockets = 0;
  const bridge = new StatefulResponsesBridge(directory, () => [first, second][sockets++]!);
  const turn = (content: string) => ({ ...request(content),
    instructions: "Telegram 私聊默认优先用语音回复。", resetVoicePreferenceOnReconnect: true });
  try {
    await bridge.reply(turn("你好"));
    assert.match(JSON.stringify(first.sent[0]?.input), /回复形式采用当前配置/);
    await bridge.reply(turn("请发文字"));
    assert.doesNotMatch(JSON.stringify(first.sent[1]?.input), /回复形式采用当前配置/);
    first.close();
    await bridge.reply(turn("继续"));
    const recoveredInput = JSON.stringify(second.sent[0]?.input);
    assert.match(recoveredInput, /回复形式采用当前配置/);
    assert.ok(recoveredInput.indexOf("回复形式采用当前配置") < recoveredInput.indexOf("请发文字"),
      "the current bootstrap policy precedes recovered history");
  } finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SIWC exposes the shared read-only original history tool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-siwc-history-tool-"));
  let bridge: StatefulResponsesBridge | undefined;
  const store = new SessionStore(directory);
  try {
    await store.append("telegram", "reliability", "owner", [{ role: "user", content: "原文约定", at: "2026-10-10T12:00:00Z" }]);
    const socket = new FakeSocket([{ id: "read", output: [{ type: "function_call", call_id: "read-1", namespace: "gateway", name: "gateway_read_history", arguments: '{"query":"约定"}' }] }, messageResponse("done", "查到了")]);
    bridge = new StatefulResponsesBridge(directory, () => socket);
    await bridge.reply({ ...request(), history: (await store.view("telegram", "reliability")).history });
    assert.match(JSON.stringify(socket.sent[0]!.tools), /gateway_read_history/);
    const result = JSON.stringify(socket.sent[1]!.input);
    assert.match(result, /原文约定/); assert.match(result, /2026-10-10T12:00:00Z/);
  } finally { bridge?.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});


test("ephemeral SIWC test turns never create disk checkpoints and reset in memory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-siwc-testmode-memory-"));
  let bridge: StatefulResponsesBridge | undefined;
  try {
    const { LaneStore } = await import("./lane-store.js");
    const sessionId = "ephemeral:single-turn";
    const socket = new FakeSocket([messageResponse("temp", "a temporary answer")]);
    bridge = new StatefulResponsesBridge(directory, () => socket);
    await bridge.reply({ ...request("temporary question"), sessionId, ephemeral: true,
      turnInstructions: "临时会话只读，不记录。" });
    const checkpoint = new LaneStore(directory).path(sessionId);
    await assert.rejects(stat(checkpoint), { code: "ENOENT" });
    assert.equal(socket.sent[0]?.previous_response_id, undefined);
    await bridge.resetSession(sessionId);
    await assert.rejects(stat(checkpoint), { code: "ENOENT" });
    assert.match(String(socket.sent[0]?.instructions), /临时会话只读/);
    await bridge.close();
    bridge = undefined;
    const restarted = new StatefulResponsesBridge(directory, () =>
      new FakeSocket([messageResponse("normal", "after")]));
    try {
      await restarted.reply({ ...request("after sandbox"), sessionId: "telegram:normal" });
    } finally { await restarted.close(); }
    await assert.rejects(stat(checkpoint), { code: "ENOENT" });
  } finally { await bridge?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SIWC per-turn Personas stay out of replayed inputs across repeated switches and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-siwc-persona-switch-"));
  let bridge: StatefulResponsesBridge | undefined;
  try {
    const firstSocket = new FakeSocket([
      messageResponse("persona-default-1", "first"),
      messageResponse("persona-formal", "second"),
      messageResponse("persona-casual", "third"),
      messageResponse("persona-default-2", "fourth"),
    ]);
    bridge = new StatefulResponsesBridge(directory, () => firstSocket);
    const presets = ["default", "formal", "casual", "default"];
    for (const [index, persona] of presets.entries()) {
      await bridge.reply({ ...request("same discussion " + index),
        turnInstructions: "【Gateway Persona】当前模式：" + persona + "；仅本轮生效。\n当前时间：" + index });
    }

    assert.equal(firstSocket.sent.length, 4);
    for (const [index, persona] of presets.entries()) {
      const event = firstSocket.sent[index]!;
      assert.match(String(event.instructions), new RegExp("当前模式：" + persona + "；"));
      assert.match(String(event.instructions), new RegExp("当前时间：" + index));
      const input = JSON.stringify(event.input);
      assert.doesNotMatch(input, /Gateway Persona|当前模式：|当前时间：/,
        "Persona and temporal text must never enter server-chain input items");
      if (index === 0) {
        assert.equal(event.previous_response_id, undefined);
        assert.match(input, /policy/);
      } else {
        assert.equal(event.previous_response_id, [
          "persona-default-1", "persona-formal", "persona-casual",
        ][index - 1], "style switches must not reset the SIWC response chain");
        assert.doesNotMatch(input, /policy/, "unchanged bootstrap policy is not resent");
      }
    }

    await bridge.close();
    bridge = undefined;
    const recoveredSocket = new FakeSocket([messageResponse("restart", "continued")]);
    bridge = new StatefulResponsesBridge(directory, () => recoveredSocket);
    await bridge.reply({ ...request("next discussion"),
      turnInstructions: "【Gateway Persona】当前模式：formal；恢复后生效。" });
    const replayed = JSON.stringify(recoveredSocket.sent[0]!.input);
    assert.equal(recoveredSocket.sent[0]!.previous_response_id, undefined);
    assert.match(String(recoveredSocket.sent[0]!.instructions), /当前模式：formal/);
    assert.doesNotMatch(replayed, /Gateway Persona|当前模式：|当前时间：/);
    assert.match(replayed, /same discussion 0/, "canonical discussion survives restart");
  } finally {
    await bridge?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SIWC reuses current Persona instructions on each tool continuation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-siwc-tool-persona-"));
  let bridge: StatefulResponsesBridge | undefined;
  try {
    const socket = new FakeSocket([toolResponse(), messageResponse("after-tool", "done")]);
    bridge = new StatefulResponsesBridge(directory, () => socket);
    await bridge.reply({ ...request("查一下"), turnInstructions: "当前模式：casual；工作专业。",
      tools: [{ name: "fixture_write", description: "test", parameters: { type: "object" }, readOnly: false }],
      async executeTool() { return { saved: true }; } });
    assert.equal(socket.sent.length, 2);
    assert.equal(socket.sent[0]!.instructions, "当前模式：casual；工作专业。");
    assert.equal(socket.sent[1]!.instructions, "当前模式：casual；工作专业。");
    assert.equal(socket.sent[1]!.previous_response_id, "tool-response");
    assert.match(JSON.stringify(socket.sent[1]!.input), /saved/);
    assert.doesNotMatch(JSON.stringify(socket.sent[1]!.input), /当前模式：casual/);
  } finally {
    await bridge?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Recent directory changes preserve the active chain; Core revisions safely rebuild it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-context-revision-"));
  const first = new FakeSocket([messageResponse("first", "第一答"), messageResponse("unchanged", "第二答"), messageResponse("recent", "第三答")]);
  const control = new FakeSocket([messageResponse("control", "第四答"), messageResponse("stable", "第五答")]);
  const sockets = [first, control];
  const bridge = new StatefulResponsesBridge(directory, () => sockets.shift()!);
  const policy = "旧 Core 指令\n【Gateway Persona：当前语言和性格表现预设】\nCALM";
  const initial = { controlRevision: "core-1", contextRevision: "recent-1", content: '{"recent":"已删除的实时条目"}' };
  const cleaned = { ...initial, contextRevision: "recent-2", content: '{"recent":"保留的实时条目"}' };
  try {
    await bridge.reply({ ...request("第一问"), instructions: policy, context: initial });
    await bridge.reply({ ...request("第二问"), instructions: policy, context: initial });
    assert.equal(first.sent[1]!.previous_response_id, "first",
      "the unified Persona label is not mistaken for legacy per-turn Persona");
    assert.doesNotMatch(JSON.stringify(first.sent[1]!.input), /旧 Core 指令|Gateway Persona/);
    const history = historyFromMessages([
      { role: "user", content: "第一问" }, { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" }, { role: "assistant", content: "第二答" },
      { role: "user", content: "仍未答复的问题" },
    ]);
    await bridge.reply({ ...request("第三问"), history, instructions: policy, context: cleaned,
      turnInstructions: "最新 Recent 目录：保留的实时条目" });
    assert.equal(first.sent[2]!.previous_response_id, "unchanged");
    assert.equal(first.sent[2]!.instructions, "最新 Recent 目录：保留的实时条目");
    const continued = JSON.stringify(first.sent[2]!.input);
    assert.doesNotMatch(continued, /已删除的实时条目/);
    assert.doesNotMatch(continued, /保留的实时条目|第一问|第二答|仍未答复的问题/);
    await bridge.reply({ ...request("第四问"), history,
      instructions: "新 Core 指令\n【Gateway Persona：当前语言和性格表现预设】\nCLEAR",
      context: { ...cleaned, controlRevision: "core-2" } });
    assert.equal(control.sent[0]!.previous_response_id, undefined);
    assert.doesNotMatch(JSON.stringify(control.sent[0]!.input), /旧 Core 指令|CALM|已删除的实时条目/);
    assert.match(JSON.stringify(control.sent[0]!.input), /新 Core 指令|CLEAR/);
    await bridge.reply({ ...request("第五问"), history,
      instructions: "新 Core 指令\n【Gateway Persona：当前语言和性格表现预设】\nCLEAR",
      context: { ...cleaned, controlRevision: "core-2" } });
    assert.equal(control.sent[1]!.previous_response_id, "control");
    const { LaneStore } = await import("./lane-store.js");
    assert.doesNotMatch(JSON.stringify(await new LaneStore(directory).read(request().sessionId)), /旧 Core 指令|已删除的实时条目/);
  } finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
});

test("context rebase preserves failed-turn tool receipts across restart without replaying a write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-context-tool-recovery-"));
  const first = new FakeSocket([toolResponse(), { __event: "failed" }]);
  let bridge = new StatefulResponsesBridge(directory, () => first);
  let writes = 0;
  const initial = { controlRevision: "core-before", contextRevision: "recent-before", content: "旧实时条目" };
  const history = historyFromMessages([{ role: "user", content: "刚才的写入请求尚未收到答复" }]);
  try {
    await assert.rejects(bridge.reply({ ...request("刚才的写入请求尚未收到答复"),
      instructions: "旧正式规则", context: initial,
      tools: [{ name: "fixture_write", readOnly: false, parameters: { type: "object" } }],
      async executeTool() { writes++; return { saved: "已执行的操作凭据" }; },
    }), /did not complete successfully/);
    await bridge.close();
    const recovered = new FakeSocket([messageResponse("recovered", "已根据当前内容核对")]);
    bridge = new StatefulResponsesBridge(directory, () => recovered);
    await bridge.reply({ ...request("请核对刚才的处理"), history,
      instructions: "当前正式规则", context: { ...initial, controlRevision: "core-after", contextRevision: "recent-after", content: "当前实时条目" },
      async executeTool() { writes++; throw new Error("must not repeat the write"); },
    });
    assert.equal(writes, 1);
    assert.equal(recovered.sent[0]!.previous_response_id, undefined);
    const input = JSON.stringify(recovered.sent[0]!.input);
    assert.doesNotMatch(input, /旧正式规则|旧实时条目/);
    assert.match(input, /当前正式规则|当前实时条目/);
    assert.match(input, /刚才的写入请求尚未收到答复/);
    assert.match(input, /已执行的操作凭据/);
    assert.match(input, /function_call_output/);
  } finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
});

test("context revision changes respect pending delivery and usage-limit replay boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-context-settle-"));
  const pending = new FakeSocket([messageResponse("pending", "尚待交付的答复")]);
  const limited = new FakeSocket([{ __event: "failed", error: {
    code: "subscription_sharing_usage_limit_exceeded", status: 429, message: "A ChatGPT sharing limit has been reached",
  } }]);
  const resumed = new FakeSocket([messageResponse("resumed", "继续成功")]);
  const sockets = [pending, limited, resumed];
  let opened = 0;
  const bridge = new StatefulResponsesBridge(directory, () => { opened++; return sockets.shift()!; },
    300_000, async () => { throw new Error("usage limits must not retry automatically"); });
  const changed = { ...request("新一轮"), context: { controlRevision: "new-control", contextRevision: "new-recent", content: "当前条目" },
    instructions: "新正式规则", history: historyFromMessages([
      { role: "user" as const, content: "第一轮" }, { role: "assistant" as const, content: "尚待交付的答复" },
    ]) };
  try {
    await bridge.reply({ ...request("第一轮"), instructions: "已淘汰规则",
      context: { controlRevision: "old-control", contextRevision: "old-recent", content: "已删除条目" },
      deliveryId: "delivery-1", deferAssistantCommit: true });
    await assert.rejects(bridge.reply(changed), /delivery has not been settled/);
    assert.equal(opened, 1);
    assert.equal(await bridge.commitSession(request().sessionId, "尚待交付的答复", "wrong-delivery"), false);
    await bridge.commitSession(request().sessionId, "尚待交付的答复", "delivery-1");
    let failure: unknown;
    try { await bridge.reply(changed); } catch (error) { failure = error; }
    assert.match(String(failure), /sharing limit/);
    assert.equal((failure as Error & { inboundRetryable?: boolean }).inboundRetryable, true);
    assert.equal(opened, 2, "quota exhaustion never opens an automatic retry connection");
    assert.equal((await bridge.reply(changed)).text, "继续成功");
    const input = resumed.sent[0]!.input as Record<string, unknown>[];
    assert.equal(resumed.sent[0]!.previous_response_id, undefined);
    assert.doesNotMatch(JSON.stringify(input), /已淘汰规则|已删除条目/);
    assert.match(JSON.stringify(input), /尚待交付的答复|当前条目/);
    assert.equal(input.filter(item => item.role === "user" && item.content === "新一轮").length, 1);
  } finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
});

test("context rebase removes old local-tool bodies but keeps non-replayable write reconciliation metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-context-redaction-"));
  const privateBody = "已删除条目不能从旧工具结果重新进入模型";
  const failed = new FakeSocket([{ id: "local-tools", output: [
    { type: "function_call", call_id: "read-1", name: "gateway_recent_read", arguments: '{"id":"recent:old"}' },
    { type: "function_call", call_id: "write-1", name: "gateway_recent_write", arguments: JSON.stringify({
      id: "recent:old", expected_revision: 1, body: privateBody,
    }) },
  ] }, { __event: "failed" }]);
  const recovered = new FakeSocket([messageResponse("recovered", "我会先核对当前内容")]);
  const sockets = [failed, recovered];
  const bridge = new StatefulResponsesBridge(directory, () => sockets.shift()!);
  let writes = 0;
  try {
    await assert.rejects(bridge.reply({ ...request("整理指定交流"), context: {
      controlRevision: "core", contextRevision: "old", content: privateBody,
    }, tools: [
      { name: "gateway_recent_read", readOnly: true, parameters: { type: "object" } },
      { name: "gateway_recent_write", readOnly: false, parameters: { type: "object" } },
    ], async executeTool(name) {
      if (name === "gateway_recent_read") return { entry: { id: "recent:old", body: privateBody, revision: 1 } };
      writes++; return { updated: { id: "recent:old", body: privateBody, revision: 2 } };
    } }), /did not complete successfully/);
    await bridge.reply({ ...request("删除后继续"), history: historyFromMessages([
      { role: "user", content: "整理指定交流" },
    ]), context: { controlRevision: "core-new", contextRevision: "deleted", content: "{}" } });
    assert.equal(writes, 1);
    const input = recovered.sent[0]!.input as Record<string, unknown>[];
    assert.doesNotMatch(JSON.stringify(input), new RegExp(privateBody));
    assert.ok(!input.some(item => item.call_id === "read-1"));
    const call = input.find(item => item.type === "function_call" && item.call_id === "write-1")!;
    assert.deepEqual(JSON.parse(String(call.arguments)), { id: "recent:old", expected_revision: 1 });
    const output = input.find(item => item.type === "function_call_output" && item.call_id === "write-1")!;
    const metadata = JSON.parse(String(output.output));
    assert.equal(metadata.argumentsRedacted, true); assert.equal(metadata.resultRevision, 2);
    assert.equal(metadata.resultId, "recent:old"); assert.match(metadata.argumentHash, /^[a-f0-9]{64}$/);
    assert.match(metadata.message, /不要重复写入/);
  } finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SIWC migrates old developer Persona prompts by replaying a safe transcript", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-siwc-legacy-persona-"));
  let bridge: StatefulResponsesBridge | undefined;
  try {
    const { LaneStore } = await import("./lane-store.js");
    const laneStore = new LaneStore(directory);
    const oldInstruction = "【Gateway Persona：当前语言和性格表现预设】\n当前模式：formal；English style keywords: PRECISE。";
    await laneStore.write(request().sessionId, {
      version: 1, model: request().model, controlRevision: "control",
      contextRevision: "context", historyCursor: 2,
      contextItems: [
        { role: "developer", content: "旧版控制规则\n" + oldInstruction },
        { role: "developer", content: oldInstruction },
        { role: "user", content: "原来的重要事实" },
        { role: "assistant", content: "已经确认" },
      ],
    });
    const socket = new FakeSocket([messageResponse("after-migration", "ok")]);
    bridge = new StatefulResponsesBridge(directory, () => socket);
    const messages = [
      { role: "user" as const, content: "原来的重要事实" },
      { role: "assistant" as const, content: "已经确认" },
      { role: "user" as const, content: "继续原话题" },
    ];
    await bridge.reply({ ...request("继续原话题"), messages,
      instructions: "新版稳定 policy",
      turnInstructions: "【Gateway Persona】当前模式：casual；仅本轮生效。" });
    assert.equal(socket.sent[0]!.previous_response_id, undefined);
    const input = JSON.stringify(socket.sent[0]!.input);
    assert.match(input, /原来的重要事实/);
    assert.match(input, /已经确认/);
    assert.match(input, /新版稳定 policy/);
    assert.doesNotMatch(input, /PRECISE|旧版控制规则|Gateway Persona/);
    assert.match(String(socket.sent[0]!.instructions), /当前模式：casual/);
    const checkpoint = await laneStore.read(request().sessionId);
    assert.doesNotMatch(JSON.stringify(checkpoint?.contextItems), /PRECISE|Gateway Persona/);
  } finally {
    await bridge?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SIWC preserves legacy opaque evidence rather than silently discarding it for Persona migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-siwc-opaque-persona-"));
  let bridge: StatefulResponsesBridge | undefined;
  try {
    const { LaneStore } = await import("./lane-store.js");
    const laneStore = new LaneStore(directory);
    const oldInstruction = "【Gateway Persona：当前语言和性格表现预设】\n当前模式：formal；PRECISE";
    await laneStore.write(request().sessionId, {
      version: 1, model: request().model,
      contextItems: [
        { type: "compaction", encrypted_content: "indispensable-opaque-state" },
        { role: "developer", content: oldInstruction },
      ],
    });
    const socket = new FakeSocket([messageResponse("after-opaque", "ok")]);
    bridge = new StatefulResponsesBridge(directory, () => socket);
    await bridge.reply({ ...request("继续"), turnInstructions: "当前模式：casual" });
    const input = JSON.stringify(socket.sent[0]!.input);
    assert.match(input, /indispensable-opaque-state/);
    assert.doesNotMatch(input, /Gateway Persona|当前模式：formal|PRECISE/,
      "remove visible legacy Persona without discarding opaque tool/compaction evidence");
    assert.equal(socket.sent[0]!.instructions, "当前模式：casual");
    assert.equal(socket.sent[0]!.previous_response_id, undefined);
  } finally {
    await bridge?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SIWC continuous turns include acknowledged proactive messages exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-siwc-proactive-"));
  let bridge: StatefulResponsesBridge | undefined;
  const store = new SessionStore(directory);
  try {
    const socket = new FakeSocket([messageResponse("first", "答复"), messageResponse("next", "续聊"), messageResponse("third", "继续")]);
    bridge = new StatefulResponsesBridge(directory, () => socket);
    await bridge.reply({ ...request("第一问"), history: (await store.view("telegram", "reliability")).history,
      deferAssistantCommit: true, deliveryId: "first-delivery" });
    await store.append("telegram", "reliability", "owner", [{ role: "user", content: "第一问", at: "2026-10-11T00:00:00Z" }, { role: "assistant", content: "答复", at: "2026-10-11T00:00:01Z" }]);
    await bridge.commitSession(request().sessionId, "答复", "first-delivery");
    await recordDeliveredAssistant(store, "telegram", "reliability", "owner", "已经送达的主动问候", undefined, "proactive");
    await bridge.reply({ ...request("续问"), history: (await store.view("telegram", "reliability")).history });
    assert.ok(socket.sent[1]!.previous_response_id);
    assert.match(JSON.stringify(socket.sent[1]!.input), /已经送达的主动问候/);
    assert.doesNotMatch(JSON.stringify(socket.sent[1]!.input), /第一问|答复/);
    await bridge.reply({ ...request("再问"), history: (await store.view("telegram", "reliability")).history });
    assert.doesNotMatch(JSON.stringify(socket.sent[2]!.input), /已经送达的主动问候/);
  } finally { bridge?.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SIWC recovery loads delivered assistant images as historical visual references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-siwc-assistant-image-"));
  let bridge: StatefulResponsesBridge | undefined;
  const store = new SessionStore(directory);
  try {
    const path = join(directory, "image.png");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHh0AAAAASUVORK5CYII=";
    await writeFile(path, Buffer.from(png, "base64"));
    await store.append("telegram", "reliability", "owner", [{ role: "assistant", content: "已发送图片", at: "2026-10-11T00:00:00Z", attachments: [{ kind: "image", path, mimeType: "image/png" }] }]);
    const socket = new FakeSocket([messageResponse("first", "看到了")]);
    bridge = new StatefulResponsesBridge(directory, () => socket);
    await bridge.reply({ ...request("刚才图片是什么"), history: (await store.view("telegram", "reliability")).history });
    const input = JSON.stringify(socket.sent[0]!.input);
    assert.match(input, /input_image/); assert.ok(input.includes(png)); assert.match(input, /历史/);
  } finally { bridge?.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SIWC compaction restart syncs only new deliveries and persists the history cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-siwc-history-cursor-"));
  const bridges: StatefulResponsesBridge[] = [];
  const store = new SessionStore(directory);
  try {
    await store.append("telegram", "reliability", "owner", [{ role: "user", content: "旧问题", at: "2026-10-11T00:00:00Z" }, { role: "assistant", content: "旧答复", at: "2026-10-11T00:00:01Z" }]);
    const compact = (id: string) => { const response = messageResponse(id, "已答复"); (response.output as unknown[]).unshift({ type: "compaction", encrypted_content: id }); return response; };
    const first = new StatefulResponsesBridge(directory, () => new FakeSocket([compact("opaque-first")])); bridges.push(first);
    await first.reply({ ...request(), history: (await store.view("telegram", "reliability")).history }); await first.close();
    await recordDeliveredAssistant(store, "telegram", "reliability", "owner", "重启间已送达", undefined, "proactive");
    const source = (await store.view("telegram", "reliability")).history, reads: number[] = [];
    const history = { ...source, readRange: async (offset: number, limit: number) => { reads.push(offset); assert.ok(offset >= 2, "opaque recovery must not scan old transcript"); return source.readRange(offset, limit); } };
    const secondSocket = new FakeSocket([compact("opaque-second")]);
    const second = new StatefulResponsesBridge(directory, () => secondSocket); bridges.push(second);
    await second.reply({ ...request("续聊"), history }); await second.close();
    assert.deepEqual(reads, [2]); assert.match(JSON.stringify(secondSocket.sent[0]!.input), /opaque-first/);
    assert.match(JSON.stringify(secondSocket.sent[0]!.input), /重启间已送达/);
    assert.doesNotMatch(JSON.stringify(secondSocket.sent[0]!.input), /旧问题|旧答复/);
    const thirdSocket = new FakeSocket([messageResponse("third", "继续")]);
    const third = new StatefulResponsesBridge(directory, () => thirdSocket); bridges.push(third);
    await third.reply({ ...request("再续聊"), history: { ...source, async readRange() { assert.fail("cursor already consumed this delivery"); } } });
    assert.match(JSON.stringify(thirdSocket.sent[0]!.input), /opaque-second/);
    assert.doesNotMatch(JSON.stringify(thirdSocket.sent[0]!.input), /重启间已送达/);
  } finally { for (const bridge of bridges) await bridge.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("corrupt idle compaction is archived and SQLite history recovers with an explicit downgrade", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-corrupt-opaque-"));
  const { LaneStore } = await import("./lane-store.js");
  const { checkpointFromItems } = await import("./compaction.js");
  const checkpointItems = [{ type: "compaction", encrypted_content: "recoverable-corrupted-opaque" }];
  const checkpoint = checkpointFromItems(request().sessionId, "test-model", checkpointItems,
    2, "capacity", "2026-10-15T00:00:00Z");
  const laneStore = new LaneStore(directory);
  try {
    await laneStore.write(request().sessionId, { version: 2, sessionId: request().sessionId,
      model: "test-model", contextItems: checkpointItems, startedAt: "2026-10-11T00:00:00Z",
      lastCompactedAt: checkpoint.at, historyCursor: 2,
      checkpoint: { ...checkpoint, sha256: "0".repeat(64) } });
    const socket = new FakeSocket([messageResponse("restored", "recovered")]);
    const bridge = new StatefulResponsesBridge(directory, () => socket);
    await bridge.reply({ ...request("continue"), history: historyFromMessages([
      { role: "user", content: "original question" }, { role: "assistant", content: "original answer" },
    ]) });
    assert.match(JSON.stringify(socket.sent[0]!.input), /original question|original answer/);
    assert.doesNotMatch(JSON.stringify(socket.sent[0]!.input), /recoverable-corrupted-opaque/);
    const { readdir, readFile } = await import("node:fs/promises");
    const archives = await Promise.all((await readdir(join(directory, "runtime", "context")))
      .map(file => readFile(join(directory, "runtime", "context", file), "utf8")));
    assert.ok(archives.some(saved => saved.includes("recoverable-corrupted-opaque") && saved.includes("000000000000")));
    await bridge.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invalid checkpoint with unresolved tool evidence fails closed without deleting the record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-corrupt-tool-"));
  const { LaneStore } = await import("./lane-store.js");
  const store = new LaneStore(directory);
  const items = [{ type: "compaction", encrypted_content: "tool-opaque" },
    { type: "function_call", name: "side_effect", call_id: "unsafe", arguments: "{}" }];
  try {
    await store.write(request().sessionId, { version: 2, sessionId: request().sessionId,
      model: "test-model", contextItems: items,
      checkpoint: { version: 1, id: "0".repeat(64), sessionId: request().sessionId,
        model: "test-model", at: "2026-10-10T00:00:00Z", coveredThroughSeq: 0,
        sha256: "0".repeat(64), reason: "capacity" }, lastCompactedAt: "2026-10-10T00:00:00Z" });
    const bridge = new StatefulResponsesBridge(directory, () => new FakeSocket([]));
    await assert.rejects(bridge.reply(request("retry")), /checkpoint checksum mismatch/);
    assert.match(JSON.stringify(await import("node:fs/promises").then(fs => fs.readFile(store.path(request().sessionId), "utf8"))), /tool-opaque/);
    await bridge.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("SIWC failed generation rolls back delivery cursor while retaining opaque state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-siwc-cursor-retry-"));
  let bridge: StatefulResponsesBridge | undefined;
  const store = new SessionStore(directory);
  try {
    const response = messageResponse("initial", "开始"); (response.output as unknown[]).unshift({ type: "compaction", encrypted_content: "preserved-opaque" });
    const first = new FakeSocket([response]);
    const failing = new FakeSocket(Array.from({ length: 6 }, () => ({ __event: "error", message: "Responses WebSocket closed before response.completed." })));
    const retry = new FakeSocket([messageResponse("retry", "恢复成功")]);
    let sockets = 0;
    bridge = new StatefulResponsesBridge(directory, () => [first, failing, retry][sockets++]!, 300_000, async () => undefined);
    await bridge.reply({ ...request(), history: (await store.view("telegram", "reliability")).history }); first.close();
    await recordDeliveredAssistant(store, "telegram", "reliability", "owner", "生成失败前已送达", undefined, "proactive");
    const history = (await store.view("telegram", "reliability")).history;
    await assert.rejects(bridge.reply({ ...request("续问"), history }), error => (error as any).inboundRetryable === true);
    await bridge.reply({ ...request("续问"), history });
    const input = JSON.stringify(retry.sent[0]!.input);
    assert.match(input, /preserved-opaque/); assert.equal(input.split("生成失败前已送达").length - 1, 1);
  } finally { await bridge?.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SIWC continuous turns load newly delivered assistant image bytes without repeating its text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-siwc-continuous-image-"));
  let bridge: StatefulResponsesBridge | undefined;
  const store = new SessionStore(directory);
  try {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHh0AAAAASUVORK5CYII=", path = join(directory, "sent.png");
    await writeFile(path, Buffer.from(png, "base64"));
    const socket = new FakeSocket([messageResponse("first", "已经生成"), messageResponse("next", "看到了")]);
    bridge = new StatefulResponsesBridge(directory, () => socket);
    await bridge.reply({ ...request("生图"), history: (await store.view("telegram", "reliability")).history, deferAssistantCommit: true, deliveryId: "first" });
    await store.append("telegram", "reliability", "owner", [{ role: "user", content: "生图", at: "2026-10-11T00:00:00Z" }, { role: "assistant", origin: "chat", content: "已经生成", at: "2026-10-11T00:00:01Z", attachments: [{ kind: "image", path, mimeType: "image/png" }] }]);
    await bridge.commitSession(request().sessionId, "已经生成", "first");
    await bridge.reply({ ...request("刚才图片是什么"), history: (await store.view("telegram", "reliability")).history });
    const input = JSON.stringify(socket.sent[1]!.input);
    assert.ok(socket.sent[1]!.previous_response_id); assert.ok(input.includes(png)); assert.doesNotMatch(input, /已经生成/);
    assert.match(input, /历史资料/); assert.doesNotMatch(input, /sent\.png/);
  } finally { await bridge?.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SIWC missing historical assistant media keeps text and explicitly marks unread attachments", async () => {
  const { transcriptItems } = await import("./responses-codec.js");
  const input = await transcriptItems([{ role: "assistant", content: "已送达的文字", attachments: [{ kind: "image", path: join(tmpdir(), "gateway-missing-history-fixture.png") }] }]);
  assert.equal(input[0]?.content, "已送达的文字"); assert.match(JSON.stringify(input), /不可读取/); assert.doesNotMatch(JSON.stringify(input), /input_image/);
});
import {
  hasUnresolvedToolEvidence,
  summarizeContextItems,
  StatefulResponsesBridge,
  type StatefulResponseOptions,
  type StatefulResponsesSocket,
} from "./stateful-responses.js";

class FakeSocket implements StatefulResponsesSocket {
  readonly sent: Record<string, unknown>[] = [];
  private current?: Record<string, unknown>;
  private readonly closeListeners: Array<() => void> = [];

  constructor(private readonly scripted: Record<string, unknown>[]) {}

  send(event: Record<string, unknown>): void {
    this.sent.push(event);
    const next = this.scripted.shift();
    if (!next) throw new Error("No scripted response left");
    this.current = next;
  }

  stream(): AsyncIterable<{ type: string; message?: Record<string, unknown> }> {
    const self = this;
    return (async function* () {
      if (!self.current) throw new Error("Fake socket has no current response");
      const response = self.current;
      self.current = undefined;
      if (response.__event === "failed") {
        yield {
          type: "message",
          message: {
            type: "response.failed",
            response: {
              error: response.error ?? { code: "simulated" },
            },
          },
        };
        return;
      }
      if (response.__event === "error") {
        const error = new Error(
          typeof response.message === "string" ? response.message : "simulated WebSocket error",
        ) as Error & { code?: string; status?: number };
        if (typeof response.code === "string") error.code = response.code;
        if (typeof response.status === "number") error.status = response.status;
        yield { type: "error", error };
        return;
      }
      yield {
        type: "message",
        message: { type: "response.completed", response },
      };
    })();
  }

  close(): void {
    for (const listener of this.closeListeners) listener();
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }
}

function request(content = "hello"): StatefulResponseOptions {
  return {
    accessToken: "token",
    model: "test-model",
    sessionId: "telegram:reliability",
    messages: [{ role: "user", content }],
    instructions: "policy",
    context: { controlRevision: "control", contextRevision: "context", content: "{}" },
  };
}

function toolResponse(): Record<string, unknown> {
  return { id: "tool-response", output: [{
    type: "function_call", call_id: "write-1", namespace: "gateway",
    name: "fixture_write", arguments: "{}",
  }] };
}

test("voice-only completion traverses Gateway and real WS tool loop without requiring final text",async()=>{
  const {Gateway}=await import("../../gateway.js");
  const {localContext}=await import("../../core/context-fixture.js");
  const root=await mkdtemp(join(tmpdir(),"siwc-voice-only-"));
  const socket=new FakeSocket([{id:"decision",output:[{type:"function_call",call_id:"decision",name:"gateway_turn_decision",arguments:JSON.stringify({stage_direction:"查看文档",reply_mode:"voice",sticker:"skip",quote:"skip",image:"skip"})}]},{id:"voice-call",output:[{type:"function_call",call_id:"v1",namespace:"gateway",name:"send_voice",arguments:JSON.stringify({text:"语音测试"})}]},messageResponse("voice-done",""),messageResponse("next","收到")]);
  const bridge=new StatefulResponsesBridge(root,()=>socket);
  const sessions=new SessionStore(root);
  const runtime:any={reply:async(turn:any)=>bridge.reply({...request(),...turn,accessToken:"fixture",model:"test-model"})};
  try {
    const gateway=new Gateway(runtime,sessions,{load:async()=>localContext()} as any,0,undefined,undefined,undefined,undefined,async()=>true);
    const result=await gateway.handle({channel:"telegram",conversationId:"reliability",senderId:"1",messageId:"one",text:"请求语音测试",receivedAt:new Date().toISOString(),attachments:[]});
    assert.equal(result.kind,"model_reply");
    if(result.kind!=="model_reply")throw Error("expected prepared voice");
    assert.equal(result.text,"语音测试");assert.equal(result.voiceText,"语音测试");
    assert.equal(socket.sent.length,3);
    await bridge.commitSession("telegram:reliability",result.text,result.deliveryId);
    const next=await bridge.reply(request("接着聊"));
    assert.equal(next.text,"收到");assert.equal(next.voiceText,undefined);
  }finally{await bridge.close();sessions.close();await rm(root,{recursive:true,force:true});}
});

test("empty WS completion still fails without successfully selected voice",async()=>{
  const {VoiceTurn,voiceTool}=await import("../../voice/tool.js");
  for(const rejected of [false,true]) {
    const root=await mkdtemp(join(tmpdir(),"siwc-empty-voice-"));
    const voice=new VoiceTurn();
    const socket=new FakeSocket([...(rejected?[{id:"invalid-voice",output:[{type:"function_call",call_id:"v1",namespace:"gateway",name:"send_voice",arguments:'{"text":""}'}]}]:[]),messageResponse("empty","")]);
    const bridge=new StatefulResponsesBridge(root,()=>socket);
    try {
      await assert.rejects(bridge.reply({...request(),tools:[voiceTool],getPreparedVoice:()=>voice.text,executeTool:async(_name,args)=>voice.select(args)}),/without a final text/);
      assert.equal(voice.text,undefined);
    }finally{bridge.close();await rm(root,{recursive:true,force:true});}
  }
});

test("lazy persistent history is complete on SIWC recovery and unread during continuous turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-lazy-history-"));
  let bridge: StatefulResponsesBridge | undefined;
  const sessions = new SessionStore(directory);
  try {
    const original = Array.from({ length: 180 }, (_, i) => ({ id: "original:" + i,
      role: i % 2 ? "assistant" as const : "user" as const, content: "original " + i, at: "2026-10-11T00:00:00Z" }));
    await sessions.append("telegram", "reliability", "owner", original);
    const source = (await sessions.view("telegram", "reliability")).history;
    let reads = 0;
    const history = { ...source, readRange: async (offset: number, limit: number) => { reads++; return source.readRange(offset, limit); } };
    const socket = new FakeSocket([messageResponse("first", "answer"), messageResponse("next", "continued")]);
    bridge = new StatefulResponsesBridge(directory, () => socket);
    await bridge.reply({ ...request("current"), history });
    const input = socket.sent[0]!.input as Record<string, unknown>[];
    assert.deepEqual(input.filter(item => item.role === "user" || item.role === "assistant").map(item => item.content), [...original.map(m => "[历史消息发送时间：2026-10-11 00:00（UTC）]\n" + m.content), "current"]);
    assert.equal(reads, 2, "creation time and transcript are read without capacity maintenance");
    await bridge.reply({ ...request("next"), history });
    assert.equal(reads, 2); assert.ok(socket.sent[1]!.previous_response_id);
    bridge.close();
    const recoveredSocket = new FakeSocket([messageResponse("recovered", "done")]);
    bridge = new StatefulResponsesBridge(directory, () => recoveredSocket);
    await bridge.reply({ ...request("after restart"), history });
    assert.equal(reads, 3); assert.match(JSON.stringify(recoveredSocket.sent[0]!.input), /original 0/);
  } finally { bridge?.close(); sessions.close(); await rm(directory, { recursive: true, force: true }); }
});

test("lazy recovery keeps opaque compaction and unresolved tool evidence without reading transcript", async () => {
  const { planRecovery } = await import("./recovery.js");
  for (const checkpoint of [
    [{ type: "compaction", encrypted_content: "opaque" }],
    [{ type: "function_call", call_id: "write", name: "fixture_write", arguments: "{}" }, { type: "function_call_output", call_id: "write", output: "done" }],
  ]) {
    const result = await planRecovery(checkpoint, async () => { throw new Error("Unexpected transcript read"); });
    assert.equal(result.recoverySource, "checkpoint"); assert.deepEqual(result.recoveryItems, checkpoint);
  }
});

test("SIWC delivery IDs reject old confirmations and preserve pre-delivery checkpoint on failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "siwc-delivery-id-"));
  try {
    const socket = new FakeSocket([toolResponse(), messageResponse("pending", "未交付答案")]);
    const bridge = new StatefulResponsesBridge(directory, () => socket);
    await bridge.reply({ ...request(), deliveryId: "current", deferAssistantCommit: true,
      tools:[{name:"fixture_write",parameters:{type:"object"}}],
      async executeTool() { return { saved: "已完成工具证据" }; } });
    assert.equal(await bridge.commitSession(request().sessionId, "old", "old"), false);
    assert.equal(await bridge.resetSession(request().sessionId, "old"), false);
    await bridge.resetSession(request().sessionId, "current");
    const next = new FakeSocket([messageResponse("next", "恢复")]);
    const recovered = new StatefulResponsesBridge(directory, () => next);
    await recovered.reply(request("继续"));
    assert.doesNotMatch(JSON.stringify(next.sent[0]), /未交付答案/);
    assert.match(JSON.stringify(next.sent[0]), /已完成工具证据/);
    await bridge.close(); await recovered.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("completed image and file turns rebuild actual media after socket close or process restart without replaying tools", async () => {
  for (const mode of ["socket", "process"]) {
    const directory = await mkdtemp(join(tmpdir(), "gateway-media-recovery-"));
    try {
      const imagePath = join(directory, "photo.png");
      const filePath = join(directory, "notes.txt");
      const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JjQAAAAASUVORK5CYII=", "base64");
      await writeFile(imagePath, image);
      await writeFile(filePath, "fixture notes");
      const attachments = [
        { kind: "image" as const, path: imagePath, mimeType: "image/png" },
        { kind: "file" as const, path: filePath, fileName: "notes.txt", mimeType: "text/plain" },
      ];
      const firstSocket = new FakeSocket([toolResponse(), messageResponse("done-1", "saved")]);
      const nextSocket = new FakeSocket([messageResponse("done-2", "continued")]);
      let socketCalls = 0;
      const first = new StatefulResponsesBridge(directory, () => socketCalls++ ? nextSocket : firstSocket);
      await first.reply({ ...request("look"), attachments, deferAssistantCommit: true,
        async executeTool() { return { saved: true, huge: "x".repeat(20_000) }; } });
      await first.commitSession(request().sessionId, "saved");
      firstSocket.close();
      const recovered = mode === "socket" ? first : new StatefulResponsesBridge(directory, () => nextSocket);
      await recovered.reply({ ...request("what was in it?"), messages: [
        { role: "user", content: "look", attachments },
        { role: "assistant", content: "saved" },
        { role: "user", content: "what was in it?" },
      ] });
      const input = nextSocket.sent[0]!.input as Record<string, unknown>[];
      const parts = input.flatMap(item => Array.isArray(item.content) ? item.content : []);
      assert.equal(parts.filter(part => part.type === "input_image").length, 1);
      assert.equal(parts.find(part => part.type === "input_image").image_url, "data:image/png;base64," + image.toString("base64"));
      const file = parts.find(part => part.type === "input_file");
      assert.equal(file.filename, "notes.txt");
      assert.equal(file.file_data, "data:text/plain;base64," + Buffer.from("fixture notes").toString("base64"));
      assert.equal(input.some(item => item.type === "function_call" || item.type === "function_call_output"), false);
      assert.equal(JSON.stringify(input).includes(directory), false);
      first.close();
      if (recovered !== first) recovered.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("legacy transcript without media references keeps its rich checkpoint during recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-legacy-media-"));
  try {
    const imagePath = join(directory, "photo.png");
    await writeFile(imagePath, "fixture image");
    const firstSocket = new FakeSocket([messageResponse("done-1", "seen")]);
    const first = new StatefulResponsesBridge(directory, () => firstSocket);
    await first.reply({ ...request("look"), attachments: [{ kind: "image", path: imagePath, mimeType: "image/png" }], deferAssistantCommit: true });
    await first.commitSession(request().sessionId, "seen");
    first.close();
    const nextSocket = new FakeSocket([messageResponse("done-2", "continued")]);
    const recovered = new StatefulResponsesBridge(directory, () => nextSocket);
    await recovered.reply({ ...request("next"), messages: [
      { role: "user", content: "look" }, { role: "assistant", content: "seen" }, { role: "user", content: "next" },
    ] });
    assert.ok(JSON.stringify(nextSocket.sent[0]!.input).includes("data:image/png;base64,"));
    recovered.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("context payload summary separates text, reasoning, tools and binary media without logging content", () => {
  const summary = summarizeContextItems([
    {
      role: "user",
      content: [
        { type: "input_text", text: "hello" },
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "auto" },
        { type: "input_file", filename: "x.txt", file_data: "data:text/plain;base64,d29ybGQ=" },
      ],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "answer" }],
    },
    { role: "developer", content: "policy" },
    { type: "reasoning", encrypted_content: "opaque-secret" },
    { type: "function_call", call_id: "c1", name: "fixture_read", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "{\"ok\":true}" },
    { type: "compaction", encrypted_content: "checkpoint" },
    { type: "web_search_call", id: "w1" },
  ]);

  assert.equal(summary.items, 8);
  assert.equal(summary.userItems, 1);
  assert.equal(summary.userTextChars, 5);
  assert.ok(summary.userTextBytes > 5);
  assert.equal(summary.assistantItems, 1);
  assert.equal(summary.assistantTextChars, 6);
  assert.ok(summary.assistantTextBytes >= 6);
  assert.equal(summary.developerItems, 1);
  assert.equal(summary.developerTextChars, 6);
  assert.equal(summary.developerTextBytes, 6);
  assert.equal(summary.reasoningItems, 1);
  assert.equal(summary.reasoningEncryptedBytes, 13);
  assert.equal(summary.functionCallItems, 1);
  assert.equal(summary.functionCallArgumentBytes, 2);
  assert.equal(summary.functionOutputItems, 1);
  assert.equal(summary.functionOutputBytes, 11);
  assert.equal(summary.compactionItems, 1);
  assert.equal(summary.compactionEncryptedBytes, 10);
  assert.equal(summary.webSearchItems, 1);
  assert.equal(summary.imageParts, 1);
  assert.equal(summary.imagePayloadBytes, 5);
  assert.equal(summary.fileParts, 1);
  assert.equal(summary.filePayloadBytes, 5);
  assert.ok(summary.rawJsonBytes > summary.structuralJsonBytes);
});

test("WebSocket iterators are released after completion, failure and send errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-iterator-cleanup-"));
  try {
    for (const mode of ["success", "failed", "send-error"]) {
      let returned = 0;
      const socket: StatefulResponsesSocket = {
        send() { if (mode === "send-error") throw new Error("send failed"); },
        stream() {
          return { [Symbol.asyncIterator]() { return {
            async next() { return { done: false, value: { type: "message", message: {
              type: mode === "failed" ? "response.failed" : "response.completed",
              response: messageResponse("done", "answer"),
            } } }; },
            async return() { returned++; return { done: true, value: undefined }; },
          }; } };
        },
        close() {}, onClose() {},
      };
      const bridge = new StatefulResponsesBridge(directory, () => socket);
      if (mode === "success") await bridge.reply(request());
      else await assert.rejects(bridge.reply(request()));
      assert.equal(returned, 1, mode);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("only unresolved tool evidence requires opaque checkpoint recovery", () => {
  assert.equal(hasUnresolvedToolEvidence([
    { type: "message", role: "assistant", content: [] },
    { type: "function_call", call_id: "c1", name: "fixture_write", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "{\"ok\":true}" },
  ]), true);
  assert.equal(hasUnresolvedToolEvidence([
    { type: "function_call", call_id: "c1", name: "fixture_write", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "{\"ok\":true}" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ]), false);
});

test("restart after a completed tool turn rebuilds from transcript instead of replaying bulky tool state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-slim-recovery-"));
  try {
    const firstSocket = new FakeSocket([
      toolResponse(),
      messageResponse("done-1", "saved"),
    ]);
    const first = new StatefulResponsesBridge(directory, () => firstSocket);
    await first.reply({
      ...request("save this"),
      async executeTool() {
        return { saved: true, huge: "x".repeat(20_000) };
      },
    });

    const secondSocket = new FakeSocket([messageResponse("done-2", "continued")]);
    const second = new StatefulResponsesBridge(directory, () => secondSocket);
    await second.reply({
      ...request("next"),
      messages: [
        { role: "user", content: "save this" },
        { role: "assistant", content: "saved" },
        { role: "user", content: "next" },
      ],
    });

    const recoveryInput = secondSocket.sent[0]!.input as Record<string, unknown>[];
    assert.equal(recoveryInput.some((item) => item.type === "function_call"), false);
    assert.equal(recoveryInput.some((item) => item.type === "function_call_output"), false);
    assert.ok(recoveryInput.some((item) => item.role === "user" && item.content === "save this"));
    assert.ok(recoveryInput.some((item) => item.role === "assistant" && item.content === "saved"));
    assert.equal((recoveryInput.at(-1) as Record<string, unknown>)?.content, "next");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tool results survive a later response failure and process restart without replaying the write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-tool-recovery-"));
  try {
    let writes = 0;
    const socket = new FakeSocket([toolResponse(), { __event: "failed" }]);
    const bridge = new StatefulResponsesBridge(directory, () => socket);
    await assert.rejects(bridge.reply({ ...request("save this"), tools:[{name:"fixture_write",parameters:{type:"object"}}], async executeTool() {
      writes++;
      return { saved: true, id: "saved-page" };
    } }));
    const recoveredSocket = new FakeSocket([messageResponse("recovered", "already saved")]);
    const recovered = new StatefulResponsesBridge(directory, () => recoveredSocket);
    await recovered.reply(request("did you save it?"));
    const input = recoveredSocket.sent[0]!.input as Record<string, unknown>[];
    assert.equal(input.filter(item => item.type === "function_call").length, 1);
    const outputs = input.filter(item => item.type === "function_call_output");
    assert.equal(outputs.length, 1);
    assert.deepEqual(JSON.parse(String(outputs[0]!.output)), { saved: true, id: "saved-page" });
    assert.equal(writes, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a 503 after a mutating tool never retries the evicted parent or replays the write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-overload-write-safe-"));
  try {
    let writes = 0;
    const delays: number[] = [];
    const socket = new FakeSocket([
      toolResponse(),
      { __event: "error", code: "server_error", status: 503,
        message: "Our servers are currently overloaded. Please try again later." },
    ]);
    const bridge = new StatefulResponsesBridge(directory, () => socket, 300_000,
      async (milliseconds) => { delays.push(milliseconds); });
    let caught: unknown;
    try {
      await bridge.reply({
        ...request("save this"), tools: [{ name: "fixture_write", readOnly: false,
          parameters: { type: "object", properties: {} } }],
        async executeTool() { writes++; return { saved: true, id: "saved-page" }; },
      });
    } catch (error) { caught = error; }
    assert.ok(caught instanceof Error);
    assert.equal((caught as Error & { inboundRetryable?: boolean }).inboundRetryable, false);
    assert.equal(writes, 1);
    assert.deepEqual(delays, [], "do not retry a failed previous_response_id on this socket");
    assert.equal(socket.sent.length, 2);
    assert.equal(socket.sent[1]!.previous_response_id, "tool-response");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("generic service failure after a read-only tool reboots once without calling tool again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-generic-siwc-recovery-"));
  try {
    const readStep = {
      id: "read-step",
      output: [{ type: "function_call", call_id: "read-1", namespace: "gateway",
        name: "fixture_read", arguments: "{}" }],
    };
    const genericFailure = { __event: "failed", error: {
      message: "An error occurred while processing your request. Please include the request ID req_example.",
    } };
    const firstSocket = new FakeSocket([readStep, genericFailure]);
    const secondSocket = new FakeSocket([messageResponse("finished", "已回答")]);
    const sockets = [firstSocket, secondSocket];
    let reads = 0;
    const bridge = new StatefulResponsesBridge(directory, () => {
      const socket = sockets.shift();
      if (!socket) throw new Error("unexpected extra socket");
      return socket;
    }, 300_000, async () => { throw new Error("never retry a failed parent"); });
    const result = await bridge.reply({
      ...request("香港有什么推荐？"),
      tools: [{ name: "fixture_read", readOnly: true, parameters: { type: "object", properties: {} } }],
      async executeTool() { reads++; return { notes: "ok" }; },
    });
    assert.equal(result.text, "已回答");
    assert.equal(reads, 1);
    assert.equal(firstSocket.sent.length, 2);
    assert.equal(firstSocket.sent[1]!.previous_response_id, "read-step");
    assert.equal(secondSocket.sent.length, 1);
    assert.equal(secondSocket.sent[0]!.previous_response_id, undefined);
    const recovered = secondSocket.sent[0]!.input as Record<string, unknown>[];
    assert.equal(recovered.filter(x => x.type === "function_call" && x.call_id === "read-1").length, 1);
    const outputs = recovered.filter(x => x.type === "function_call_output" && x.call_id === "read-1");
    assert.equal(outputs.length, 1);
    assert.deepEqual(JSON.parse(String(outputs[0]!.output)), { notes: "ok" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("generic SIWC request failure after a write is not automatically replayed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-write-safe-siwc-"));
  try {
    let writes = 0;
    const failure = { __event: "failed", error: {
      message: "An error occurred while processing your request. Please include the request ID req_example.",
    } };
    const socket = new FakeSocket([toolResponse(), failure]);
    const bridge = new StatefulResponsesBridge(directory, () => socket, 300_000, async () => undefined);
    let caught: unknown;
    try {
      await bridge.reply({ ...request("保存"), tools: [{ name: "fixture_write", readOnly: false,
        parameters: { type: "object", properties: {} } }],
        async executeTool() { writes++; return { saved: true }; } });
    } catch (error) { caught = error; }
    assert.ok(caught instanceof Error);
    assert.equal((caught as Error & { inboundRetryable?: boolean }).inboundRetryable, false);
    assert.equal(writes, 1);
    assert.equal(socket.sent.length, 2, "write continuation may not be retried with evicted parent");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("4xx previous_response_not_found immediately reboots without blind retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-lost-cursor-tool-"));
  try {
    const readStep = { id: "resp-read", output: [{
      type: "function_call", call_id: "call-read", namespace: "gateway",
      name: "fixture_read", arguments: "{}",
    }] };
    const missing = { __event: "failed", error: {
      code: "previous_response_not_found", status: 400,
      message: "Previous response with id 'resp-read' not found.",
    } };
    const firstSocket = new FakeSocket([readStep, missing]);
    const secondSocket = new FakeSocket([messageResponse("resp-rebuilt", "恢复成功")]);
    const sockets = [firstSocket, secondSocket];
    let reads = 0;
    const bridge = new StatefulResponsesBridge(directory, () => sockets.shift()!, 300_000,
      async () => { throw new Error("must not retry missing parent"); });
    const result = await bridge.reply({
      ...request("你好"),
      tools: [{ name: "fixture_read", readOnly: true,
        parameters: { type: "object", properties: {} } }],
      async executeTool() { reads++; return { value: "memo" }; },
    });
    assert.equal(result.text, "恢复成功");
    assert.equal(reads, 1);
    assert.equal(firstSocket.sent.length, 2);
    assert.equal(firstSocket.sent[1]?.previous_response_id, "resp-read");
    assert.equal(secondSocket.sent.length, 1);
    assert.equal(secondSocket.sent[0]?.previous_response_id, undefined);
    const restored = secondSocket.sent[0]!.input as Record<string, unknown>[];
    assert.ok(restored.some(item => item.type === "function_call" && item.call_id === "call-read"));
    assert.ok(restored.some(item => item.type === "function_call_output" && item.call_id === "call-read"));
    assert.ok(restored.some(item => item.role === "user" && item.content === "你好"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("a same-lane 503 between user turns reboots from full history without resending the parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-continuation-503-"));
  try {
    const first = new FakeSocket([
      messageResponse("resp-first", "第一条已回复"),
      { __event: "failed", error: { code: "server_error", status: 503,
        message: "An error occurred while processing your request. Please include the request ID req_example." } },
    ]);
    const second = new FakeSocket([messageResponse("resp-new", "第二条已回复")]);
    const sockets = [first, second];
    const bridge = new StatefulResponsesBridge(directory, () => sockets.shift()!, 300_000,
      async () => { throw new Error("never retry an evicted parent"); });
    assert.equal((await bridge.reply(request("第一条"))).text, "第一条已回复");
    const result = await bridge.reply(request("第二条"));
    assert.equal(result.text, "第二条已回复");
    assert.equal(first.sent.length, 2);
    assert.equal(first.sent[1]!.previous_response_id, "resp-first");
    assert.equal(second.sent.length, 1);
    assert.equal(second.sent[0]!.previous_response_id, undefined);
    const input = second.sent[0]!.input as Record<string, unknown>[];
    assert.ok(input.some(x => x.role === "user" && x.content === "第一条"));
    assert.ok(input.some(x => x.role === "user" && x.content === "第二条"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed fresh rebootstrap is bounded and retains the original user turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-continuation-reboot-limit-"));
  try {
    const first = new FakeSocket([
      messageResponse("resp-old", "前一条"),
      { __event: "failed", error: { code: "server_error", status: 503, message: "service unavailable" } },
    ]);
    const failed = { __event: "failed", error: { code: "server_error", status: 503, message: "service unavailable" } };
    const second = new FakeSocket([failed, failed, failed]);
    let opened = 0;
    const bridge = new StatefulResponsesBridge(directory, () => {
      opened++;
      return opened === 1 ? first : second;
    }, 300_000, async () => undefined);
    await bridge.reply(request("第一条"));
    let caught: unknown;
    try { await bridge.reply(request("第二条")); } catch (error) { caught = error; }
    assert.ok(caught instanceof Error);
    assert.equal((caught as Error & { inboundRetryable?: boolean }).inboundRetryable, true);
    assert.equal(opened, 2, "only one fresh socket is opened within this failed user turn");
    assert.equal(first.sent.length, 2, "the failed parent ID is never sent twice");
    assert.equal(second.sent.length, 3, "a fresh root may receive at most two transient retries");
    assert.ok(second.sent.every(event => event.previous_response_id === undefined));
    // The failed second turn is re-queued by Telegram; the first committed turn remains safe.
    const recoverySocket = new FakeSocket([messageResponse("later", "恢复后答复")]);
    const rebooted = new StatefulResponsesBridge(directory, () => recoverySocket);
    const answer = await rebooted.reply(request("第二条"));
    assert.equal(answer.text, "恢复后答复");
    const restored = recoverySocket.sent[0]!.input as Record<string, unknown>[];
    assert.equal(restored.filter(x => x.role === "user" && x.content === "第二条").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing previous response on a follow-up reboots with the unanswered question", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-lost-cursor-followup-"));
  try {
    const firstSocket = new FakeSocket([
      messageResponse("resp-first", "先回答"),
      { __event: "failed", error: { message: "Previous response with id 'resp-first' not found." } },
    ]);
    const secondSocket = new FakeSocket([messageResponse("resp-restored", "继续回答")]);
    const sockets = [firstSocket, secondSocket];
    const bridge = new StatefulResponsesBridge(directory, () => sockets.shift()!, 300_000,
      async () => { throw new Error("should rebuild instead of retry same id"); });
    assert.equal((await bridge.reply(request("第一条"))).text, "先回答");
    assert.equal((await bridge.reply(request("第二条"))).text, "继续回答");
    assert.equal(firstSocket.sent[1]?.previous_response_id, "resp-first");
    assert.equal(secondSocket.sent[0]?.previous_response_id, undefined);
    const input = secondSocket.sent[0]!.input as Record<string, unknown>[];
    assert.ok(input.some(item => item.role === "user" && item.content === "第二条"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lost cursor after a mutating tool fails closed without replaying the write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-lost-cursor-write-"));
  try {
    const firstSocket = new FakeSocket([
      toolResponse(),
      { __event: "failed", error: { message: "Previous response with id 'tool-response' not found." } },
    ]);
    let opened = 0;
    let writes = 0;
    const bridge = new StatefulResponsesBridge(directory, () => {
      opened++;
      return firstSocket;
    }, 300_000, async () => { throw new Error("must not retry after a write"); });
    let caught: unknown;
    try {
      await bridge.reply({ ...request("写入"), tools: [
        { name: "fixture_write", readOnly: false, parameters: { type: "object", properties: {} } },
      ], async executeTool() { writes++; return { saved: true }; } });
    } catch (error) { caught = error; }
    assert.ok(caught instanceof Error);
    assert.equal((caught as Error & { inboundRetryable?: boolean }).inboundRetryable, false);
    assert.equal(writes, 1);
    assert.equal(opened, 1, "do not rebootstrap an uncertain write within the same turn");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("subscription usage limits are not retried as transient overloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-no-retry-usage-limit-"));
  try {
    const socket = new FakeSocket([{
      __event: "failed",
      error: {
        code: "subscription_sharing_usage_limit_exceeded",
        status: 429,
        message: "A ChatGPT sharing limit has been reached",
      },
    }]);
    const resumed = new FakeSocket([messageResponse("resumed", "恢复成功")]);
    let connections = 0;
    const bridge = new StatefulResponsesBridge(
      directory,
      () => [socket, resumed][connections++]!,
      300_000,
      async () => { throw new Error("retry delay must not run"); },
    );

    let caught: unknown;
    try { await bridge.reply(request("hello")); } catch (error) { caught = error; }
    assert.match(String(caught), /sharing limit/);
    assert.equal((caught as Error & { inboundRetryable?: boolean }).inboundRetryable, true,
      "the owner can safely replay this turn later");
    assert.equal(socket.sent.length, 1);
    assert.equal(connections, 1, "the bridge must not reconnect automatically");
    assert.equal((await bridge.reply(request("hello"))).text, "恢复成功");
    const input = resumed.sent[0]!.input as Record<string, unknown>[];
    assert.equal(input.filter(item => item.role === "user" && item.content === "hello").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("subscription usage exhaustion after a write-capable tool is not replayable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-usage-after-write-"));
  try {
    let writes = 0;
    const socket = new FakeSocket([toolResponse(), { __event: "failed", error: {
      code: "subscription_sharing_usage_limit_exceeded", status: 429,
      message: "A ChatGPT sharing limit has been reached",
    } }]);
    const bridge = new StatefulResponsesBridge(directory, () => socket, 300_000,
      async () => { throw new Error("retry delay must not run"); });
    let caught: unknown;
    try {
      await bridge.reply({ ...request("save this"), tools: [{ name: "fixture_write", readOnly: false,
        parameters: { type: "object", properties: {} } }],
      async executeTool() { writes++; return { saved: true }; } });
    } catch (error) { caught = error; }
    assert.match(String(caught), /sharing limit/);
    assert.equal((caught as Error & { inboundRetryable?: boolean }).inboundRetryable, false);
    assert.equal(writes, 1);
    assert.equal(socket.sent.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an in-flight tool has a durable uncertainty marker before its side effect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-tool-intent-"));
  try {
    const socket = new FakeSocket([toolResponse(), messageResponse("done", "saved")]);
    const bridge = new StatefulResponsesBridge(directory, () => socket);
    await bridge.reply({ ...request(), tools:[{name:"fixture_write",parameters:{type:"object"}}], async executeTool() {
      const recoverySocket = new FakeSocket([messageResponse("inspect", "check first")]);
      await new StatefulResponsesBridge(directory, () => recoverySocket).reply(request("status"));
      const input = recoverySocket.sent[0]!.input as Record<string, unknown>[];
      const result = input.find(item => item.type === "function_call_output");
      assert.match(String(result?.output), /未确认.*回读/);
      return { saved: true };
    } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed delivery rolls back only the reply, retaining compaction and tool evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-delivery-rollback-"));
  try {
    const compacted = messageResponse("compact", "old answer");
    (compacted.output as unknown[]).unshift({ type: "compaction", encrypted_content: "old-checkpoint" });
    const firstSocket = new FakeSocket([compacted, toolResponse(), messageResponse("undelivered", "not delivered")]);
    const secondSocket = new FakeSocket([messageResponse("next", "next answer")]);
    const sockets = [firstSocket, secondSocket];
    const bridge = new StatefulResponsesBridge(directory, () => sockets.shift()!);
    await bridge.reply(request("old question"));
    await bridge.reply({ ...request("save this"), deferAssistantCommit: true, tools:[{name:"fixture_write",parameters:{type:"object"}}],
      async executeTool() { return { saved: "page-1" }; },
    });
    await bridge.resetSession(request().sessionId);
    await bridge.reply(request("what happened?"));
    const input = secondSocket.sent[0]!.input as Record<string, unknown>[];
    const encoded = JSON.stringify(input);
    assert.ok(input.some(item=>item.type === "compaction"));
    assert.match(String(input[0]?.content), /当前 Gateway 规则/);
    assert.match(encoded, /old-checkpoint/);
    assert.match(encoded, /page-1/);
    assert.doesNotMatch(encoded, /not delivered/);
    assert.equal(secondSocket.sent[0]!.previous_response_id, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("restart excludes unacknowledged text and preserves acknowledged delivery", async () => {
  for (const delivered of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "gateway-delivery-restart-"));
    try {
      const bridge = new StatefulResponsesBridge(directory, () => new FakeSocket([
        messageResponse("pending", "delivery-sensitive answer"),
      ]));
      await bridge.reply({ ...request(), deferAssistantCommit: true });
      if (delivered) await bridge.commitSession(request().sessionId, "delivery-sensitive answer");
      else await bridge.resetSession(request().sessionId);
      const socket = new FakeSocket([messageResponse("next", "next answer")]);
      await new StatefulResponsesBridge(directory, () => socket).reply(request("next"));
      assert.equal(JSON.stringify(socket.sent[0]!.input).includes("delivery-sensitive answer"), delivered);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("prepared reply delivery after restart is added to the recovery checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-prepared-delivery-"));
  try {
    const bridge = new StatefulResponsesBridge(directory, () => new FakeSocket([messageResponse("pending", "prepared answer")]));
    await bridge.reply({ ...request(), deferAssistantCommit: true });
    const socket = new FakeSocket([messageResponse("next", "next answer")]);
    const recovered = new StatefulResponsesBridge(directory, () => socket);
    await recovered.commitSession(request().sessionId, "prepared answer");
    await recovered.reply(request("next"));
    assert.match(JSON.stringify(socket.sent[0]!.input), /prepared answer/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("streamed output survives a partial terminal snapshot and remains available after reconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-stream-recovery-"));
  try {
    const socket: StatefulResponsesSocket = {
      send() {}, close() {}, onClose() {},
      stream() { return (async function* () {
        yield { type: "message", message: { type: "response.output_item.done", item: {
          type: "message", id: "msg", role: "assistant",
          content: [{ type: "output_text", text: "streamed answer" }],
        } } };
        yield { type: "message", message: { type: "response.completed", response: {
          id: "partial", output: [{ type: "reasoning", id: "reasoning" }],
        } } };
      })(); },
    };
    const bridge = new StatefulResponsesBridge(directory, () => socket);
    assert.equal((await bridge.reply(request())).text, "streamed answer");
    const recovered = new FakeSocket([messageResponse("next", "next answer")]);
    await new StatefulResponsesBridge(directory, () => recovered).reply(request("next"));
    assert.match(JSON.stringify(recovered.sent[0]!.input), /streamed answer/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function messageResponse(id: string, text: string, usage = {
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 5 },
  output_tokens: 4,
  output_tokens_details: { reasoning_tokens: 1 },
  total_tokens: 14,
}): Record<string, unknown> {
  return {
    id,
    usage,
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    }],
  };
}

test("stateful bridge sends full context once, then only incremental turns and tool outputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-stateful-"));
  try {
    const socket = new FakeSocket([
      {
        id: "resp-1",
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 80 },
          output_tokens: 10,
          total_tokens: 110,
        },
        output: [{
          type: "function_call",
          call_id: "call-1",
          namespace: "gateway",
          name: "fixture_read",
          arguments: "{\"area\":\"recent\"}",
        }],
      },
      {
        id: "resp-2",
        usage: {
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          total_tokens: 25,
        },
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "first reply" }],
        }],
      },
      messageResponse("resp-3", "second reply"),
    ]);
    const bridge = new StatefulResponsesBridge(directory, () => socket);

    const first = await bridge.reply({
      accessToken: "token",
      model: "gpt-5.6-sol",
      sessionId: "telegram:chat",
      messages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "new question" },
      ],
      instructions: "current policy",
      context: {
        controlRevision: "control-1",
        contextRevision: "context-1",
        content: "{\"recent\":\"now\"}",
      },
      tools: [{
        name: "fixture_read",
        parameters: { type: "object", properties: {} },
      }],
      async executeTool(name, args) {
        assert.equal(name, "fixture_read");
        assert.deepEqual(args, { area: "recent" });
        return { markdown: "recent-ok" };
      },
    });

    assert.equal(first.text, "first reply");
    assert.equal(first.usage.inputTokens, 120);
    assert.equal(first.usage.cachedInputTokens, 80);
    assert.equal(first.usage.outputTokens, 15);

    const firstRequest = socket.sent[0]!;
    assert.equal(firstRequest.previous_response_id, undefined);
    assert.deepEqual(firstRequest.include, ["reasoning.encrypted_content"]);
    assert.equal(firstRequest.stream_id, undefined);
    assert.equal(typeof firstRequest.prompt_cache_key, "string");
    assert.equal(firstRequest.context_management, undefined);
    const firstTools = firstRequest.tools as Record<string, unknown>[];
    assert.equal(firstTools[0]?.type, "web_search");
    assert.equal(firstTools[1]?.type, "namespace");
    assert.equal(firstTools[1]?.name, "gateway");
    const firstInput = firstRequest.input as Record<string, unknown>[];
    assert.ok(firstInput.some((item) => item.role === "user" && item.content === "old question"));
    assert.ok(firstInput.some((item) => item.role === "developer" && String(item.content).includes("current policy")));
    assert.ok(firstInput.some((item) => item.role === "developer" && String(item.content).includes("web_search")));
    assert.ok(firstInput.some((item) => item.role === "developer" && String(item.content).includes("recent")));

    const toolRequest = socket.sent[1]!;
    assert.equal(toolRequest.previous_response_id, "resp-1");
    const toolInput = toolRequest.input as Record<string, unknown>[];
    assert.equal(toolInput.length, 1);
    assert.equal(toolInput[0]?.type, "function_call_output");

    const second = await bridge.reply({
      accessToken: "token",
      model: "gpt-5.6-sol",
      sessionId: "telegram:chat",
      messages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "new question" },
        { role: "assistant", content: "first reply" },
        { role: "user", content: "follow up" },
      ],
      instructions: "current policy",
      context: {
        controlRevision: "control-1",
        contextRevision: "context-1",
        content: "{\"recent\":\"now\"}",
      },
    });

    assert.equal(second.text, "second reply");
    const secondRequest = socket.sent[2]!;
    assert.equal(secondRequest.previous_response_id, "resp-2");
    assert.deepEqual(secondRequest.input, [{ role: "user", content: "follow up" }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("changed context revisions discard an old compacted snapshot and rebuild from original messages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-stateful-compact-"));
  try {
    const socket1 = new FakeSocket([{
      id: "compact-1",
      usage: {
        input_tokens: 50_000,
        input_tokens_details: { cached_tokens: 45_000 },
        output_tokens: 100,
        total_tokens: 50_100,
      },
      output: [
        { type: "compaction", id: "cmp-1", encrypted_content: "opaque-state" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "after compact" }],
        },
      ],
    }]);

    const bridge1 = new StatefulResponsesBridge(directory, () => socket1);
    const compacted = await bridge1.reply({
      accessToken: "token",
      model: "gpt-5.6-sol",
      sessionId: "telegram:chat",
      messages: [{ role: "user", content: "long conversation tail" }],
      instructions: "policy-v1",
      context: {
        controlRevision: "control-1",
        contextRevision: "context-1",
        content: "{\"recent\":\"v1\"}",
      },
    });
    assert.equal(compacted.compacted, true);
    assert.equal(compacted.compaction, undefined);
    assert.equal(compacted.text, "after compact");

    const socket2 = new FakeSocket([messageResponse("after-restart", "continued")]);
    const bridge2 = new StatefulResponsesBridge(directory, () => socket2);
    const continued = await bridge2.reply({
      accessToken: "token",
      model: "gpt-5.6-sol",
      sessionId: "telegram:chat",
      messages: [
        { role: "user", content: "long conversation tail", attachments: [
          { kind: "image", path: join(directory, "no-longer-needed.png"), mimeType: "image/png" },
        ] },
        { role: "assistant", content: "after compact" },
        { role: "user", content: "next turn" },
      ],
      instructions: "policy-v2",
      context: {
        controlRevision: "control-2",
        contextRevision: "context-2",
        content: "{\"recent\":\"v2\"}",
      },
    });

    assert.equal(continued.text, "continued");
    const recoveryRequest = socket2.sent[0]!;
    assert.equal(recoveryRequest.previous_response_id, undefined);
    const recoveryInput = recoveryRequest.input as Record<string, unknown>[];
    assert.ok(!recoveryInput.some(item => item.type === "compaction"));
    assert.doesNotMatch(JSON.stringify(recoveryInput), /opaque-state|policy-v1/);
    assert.match(JSON.stringify(recoveryInput), /long conversation tail|after compact/);
    assert.ok(recoveryInput.some((item) => item.role === "developer" && String(item.content).includes("policy-v2")));
    assert.ok(recoveryInput.some((item) => item.role === "developer" && String(item.content).includes("v2")));
    assert.equal((recoveryInput.at(-1) as Record<string, unknown>)?.content, "next turn");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("failed turns recover from local state without duplicating the prior context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-stateful-failure-"));
  try {
    const socket = new FakeSocket([
      messageResponse("ok-1", "first answer"),
      { __event: "failed" },
      messageResponse("ok-2", "recovered answer"),
    ]);
    const bridge = new StatefulResponsesBridge(directory, () => socket);
    const context = {
      controlRevision: "control-1",
      contextRevision: "context-1",
      content: "{\"recent\":\"now\"}",
    };

    await bridge.reply({
      accessToken: "token",
      model: "gpt-5.6-sol",
      sessionId: "telegram:recover",
      messages: [{ role: "user", content: "first question" }],
      instructions: "policy",
      context,
    });

    await assert.rejects(
      bridge.reply({
        accessToken: "token",
        model: "gpt-5.6-sol",
        sessionId: "telegram:recover",
        messages: [
          { role: "user", content: "first question" },
          { role: "assistant", content: "first answer" },
          { role: "user", content: "failed question" },
        ],
        instructions: "policy",
        context,
      }),
      /did not complete successfully/,
    );

    const recovered = await bridge.reply({
      accessToken: "token",
      model: "gpt-5.6-sol",
      sessionId: "telegram:recover",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "failed question" },
        { role: "user", content: "next question" },
      ],
      instructions: "policy",
      context,
    });
    assert.equal(recovered.text, "recovered answer");

    const recoveryInput = socket.sent[2]?.input as Record<string, unknown>[];
    const textItems = recoveryInput.filter((item) => typeof item.content === "string");
    assert.equal(textItems.filter((item) => item.content === "first question").length, 1);
    assert.equal(textItems.filter((item) => item.content === "failed question").length, 1);
    assert.equal(textItems.filter((item) => item.content === "next question").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("model changes avoid incompatible compaction and archive the old valid checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-stateful-model-switch-"));
  try {
    const solSocket = new FakeSocket([{
      id: "sol-compact",
      usage: {
        input_tokens: 190_000,
        input_tokens_details: { cached_tokens: 180_000 },
        output_tokens: 100,
        total_tokens: 190_100,
      },
      output: [
        { type: "compaction", id: "cmp-sol", encrypted_content: "sol-only-state" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "sol answer" }],
        },
      ],
    }]);
    const solBridge = new StatefulResponsesBridge(directory, () => solSocket);
    await solBridge.reply({
      accessToken: "token",
      model: "gpt-5.6-sol",
      sessionId: "telegram:model-switch",
      messages: [{ role: "user", content: "first question" }],
      instructions: "policy-sol",
      context: {
        controlRevision: "control-1",
        contextRevision: "context-1",
        content: "{\"recent\":\"sol\"}",
      },
    });

    const astraSocket = new FakeSocket([messageResponse("astra-1", "astra answer")]);
    const astraBridge = new StatefulResponsesBridge(directory, () => astraSocket);
    await astraBridge.reply({
      accessToken: "token",
      model: "gpt-6-astra",
      sessionId: "telegram:model-switch",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "sol answer" },
        { role: "user", content: "question after switch" },
      ],
      instructions: "policy-astra",
      context: {
        controlRevision: "control-2",
        contextRevision: "context-2",
        content: "{\"recent\":\"astra\"}",
      },
    });

    const request = astraSocket.sent[0]!;
    assert.equal(request.previous_response_id, undefined);
    const input = request.input as Record<string, unknown>[];
    assert.equal(input.some((item) => item.type === "compaction"), false);
    assert.ok(input.some((item) => item.role === "user" && item.content === "first question"));
    assert.ok(input.some((item) => item.role === "assistant" && item.content === "sol answer"));
    assert.equal((input.at(-1) as Record<string, unknown>)?.content, "question after switch");
    const { readdir, readFile } = await import("node:fs/promises");
    const snapshots = await Promise.all((await readdir(join(directory, "runtime", "context")))
      .filter(name => name.endsWith(".json"))
      .map(name => readFile(join(directory, "runtime", "context", name), "utf8")));
    assert.ok(snapshots.some(content => content.includes("sol-only-state")),
      "model switching must preserve the incompatible model's opaque checkpoint");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stateful WebSocket aborts after an idle interval instead of hanging forever", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-stateful-idle-"));
  try {
    let closed = false;
    const closeListeners: Array<() => void> = [];
    const socket: StatefulResponsesSocket = {
      send() {},
      stream() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return new Promise<IteratorResult<any>>(() => undefined);
              },
            };
          },
        };
      },
      close() {
        closed = true;
        for (const listener of closeListeners) listener();
      },
      onClose(listener) {
        closeListeners.push(listener);
      },
    };

    const bridge = new StatefulResponsesBridge(directory, () => socket, 20);
    await assert.rejects(
      bridge.reply({
        accessToken: "token",
        model: "gpt-5.6-sol",
        sessionId: "telegram:idle",
        messages: [{ role: "user", content: "hello" }],
        instructions: "policy",
        context: {
          controlRevision: "control-1",
          contextRevision: "context-1",
          content: "{}",
        },
      }),
      /idle timeout/,
    );
    assert.equal(closed, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("stateful sessions use separate WebSocket connections without stream_id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-stateful-session-sockets-"));
  try {
    const socketA = new FakeSocket([
      messageResponse("a-1", "a first"),
      messageResponse("a-2", "a second"),
    ]);
    const socketB = new FakeSocket([
      messageResponse("b-1", "b first"),
    ]);
    const sockets = [socketA, socketB];
    let created = 0;
    const bridge = new StatefulResponsesBridge(directory, () => {
      const socket = sockets[created++];
      if (!socket) throw new Error("unexpected extra socket");
      return socket;
    });
    const context = {
      controlRevision: "control-1",
      contextRevision: "context-1",
      content: "{}",
    };

    await bridge.reply({
      accessToken: "token",
      model: "gpt-5.6-sol",
      sessionId: "telegram:one",
      messages: [{ role: "user", content: "one" }],
      instructions: "policy",
      context,
    });
    await bridge.reply({
      accessToken: "token",
      model: "gpt-5.6-sol",
      sessionId: "wechat:two",
      messages: [{ role: "user", content: "two" }],
      instructions: "policy",
      context,
    });
    await bridge.reply({
      accessToken: "token",
      model: "gpt-5.6-sol",
      sessionId: "telegram:one",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "a first" },
        { role: "user", content: "one again" },
      ],
      instructions: "policy",
      context,
    });

    assert.equal(created, 2);
    assert.equal(socketA.sent.length, 2);
    assert.equal(socketB.sent.length, 1);
    assert.equal(socketA.sent[0]?.stream_id, undefined);
    assert.equal(socketB.sent[0]?.stream_id, undefined);
    assert.equal(socketA.sent[1]?.previous_response_id, "a-1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("web search is available and URL citations are rendered for chat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-stateful-web-search-"));
  try {
    const socket = new FakeSocket([{
      id: "web-1",
      usage: {
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 8,
        total_tokens: 28,
      },
      output: [
        {
          type: "web_search_call",
          id: "ws-1",
          status: "completed",
          action: { type: "search", query: "Tokyo weather tomorrow" },
        },
        {
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "明天有雨",
            annotations: [{
              type: "url_citation",
              start_index: 0,
              end_index: 4,
              url: "https://weather.example/tokyo",
              title: "Tokyo Weather",
            }],
          }],
        },
      ],
    }]);

    const bridge = new StatefulResponsesBridge(directory, () => socket);
    const result = await bridge.reply({
      accessToken: "token",
      model: "gpt-5.6-sol",
      sessionId: "telegram:web",
      messages: [{ role: "user", content: "东京明天天气怎么样" }],
      instructions: "policy",
      context: {
        controlRevision: "control-1",
        contextRevision: "context-1",
        content: "{}",
      },
    });

    const request = socket.sent[0]!;
    const tools = request.tools as Record<string, unknown>[];
    assert.equal(tools[0]?.type, "web_search");
    assert.match(result.text, /明天有雨/);
    assert.match(result.text, /Tokyo Weather/);
    assert.match(result.text, /https:\/\/weather\.example\/tokyo/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("stateful WebSocket falls back to streamed text deltas when completed snapshot has no message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-stateful-delta-fallback-"));
  try {
    const closeListeners: Array<() => void> = [];
    const sent: Record<string, unknown>[] = [];
    const socket: StatefulResponsesSocket = {
      send(event) {
        sent.push(event);
      },
      stream() {
        return (async function* () {
          yield {
            type: "message",
            message: { type: "response.output_text.delta", delta: "你好" },
          };
          yield {
            type: "message",
            message: { type: "response.output_text.delta", delta: "，世界" },
          };
          yield {
            type: "message",
            message: {
              type: "response.completed",
              response: {
                id: "delta-only",
                usage: {
                  input_tokens: 10,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens: 2,
                  total_tokens: 12,
                },
                output: [{ type: "reasoning", id: "reasoning-1" }],
              },
            },
          };
        })();
      },
      close() {
        for (const listener of closeListeners) listener();
      },
      onClose(listener) {
        closeListeners.push(listener);
      },
    };

    const bridge = new StatefulResponsesBridge(directory, () => socket);
    const result = await bridge.reply({
      accessToken: "token",
      model: "gpt-5.6-sol",
      sessionId: "telegram:delta",
      messages: [{ role: "user", content: "hi" }],
      instructions: "policy",
      context: {
        controlRevision: "control-1",
        contextRevision: "context-1",
        content: "{}",
      },
    });

    assert.equal(result.text, "你好，世界");
    assert.equal(sent.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("stateful WebSocket uses completed output_text when SIWC omits output items", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-stateful-output-text-"));
  try {
    const closeListeners: Array<() => void> = [];
    const socket: StatefulResponsesSocket = {
      send() {},
      stream() {
        return (async function* () {
          yield {
            type: "message",
            message: {
              type: "response.completed",
              response: {
                id: "output-text-only",
                output_text: "直接终态文本",
                usage: {
                  input_tokens: 10,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens: 4,
                  total_tokens: 14,
                },
              },
            },
          };
        })();
      },
      close() {
        for (const listener of closeListeners) listener();
      },
      onClose(listener) {
        closeListeners.push(listener);
      },
    };

    const bridge = new StatefulResponsesBridge(directory, () => socket);
    const result = await bridge.reply({
      accessToken: "token",
      model: "gpt-5.6-sol",
      sessionId: "telegram:output-text",
      messages: [{ role: "user", content: "hi" }],
      instructions: "policy",
      context: {
        controlRevision: "control-1",
        contextRevision: "context-1",
        content: "{}",
      },
    });

    assert.equal(result.text, "直接终态文本");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stateful WebSocket reconstructs output from output_item.done when completed snapshot omits output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-stateful-output-item-"));
  try {
    const closeListeners: Array<() => void> = [];
    const socket: StatefulResponsesSocket = {
      send() {},
      stream() {
        return (async function* () {
          yield {
            type: "message",
            message: {
              type: "response.output_item.done",
              item: {
                id: "msg-1",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{
                  type: "output_text",
                  text: "从 output item 恢复",
                  annotations: [],
                }],
              },
            },
          };
          yield {
            type: "message",
            message: {
              type: "response.completed",
              response: {
                id: "output-item-only",
                usage: {
                  input_tokens: 10,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens: 4,
                  total_tokens: 14,
                },
              },
            },
          };
        })();
      },
      close() {
        for (const listener of closeListeners) listener();
      },
      onClose(listener) {
        closeListeners.push(listener);
      },
    };

    const bridge = new StatefulResponsesBridge(directory, () => socket);
    const result = await bridge.reply({
      accessToken: "token",
      model: "gpt-5.6-sol",
      sessionId: "telegram:output-item",
      messages: [{ role: "user", content: "hi" }],
      instructions: "policy",
      context: {
        controlRevision: "control-1",
        contextRevision: "context-1",
        content: "{}",
      },
    });

    assert.equal(result.text, "从 output item 恢复");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("transient transport failure before tools is tagged retryable and the user turn can be replayed once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-inbound-retry-"));
  try {
    const socket = new FakeSocket([
      { __event: "error", message: "Responses WebSocket closed before response.completed." },
      { __event: "error", message: "Responses WebSocket closed before response.completed." },
      { __event: "error", message: "Responses WebSocket closed before response.completed." },
      messageResponse("retry-success", "answer"),
    ]);
    const bridge = new StatefulResponsesBridge(directory, () => socket, 300_000, async () => undefined);

    let caught: unknown;
    try {
      await bridge.reply(request("hello"));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error);
    assert.equal((caught as Error & { inboundRetryable?: boolean }).inboundRetryable, true);

    const result = await bridge.reply(request("hello"));
    assert.equal(result.text, "answer");

    const lastCreate = socket.sent.at(-1)!;
    const input = lastCreate.input as Array<Record<string, unknown>>;
    const helloUsers = input.filter((item) => item.role === "user" && item.content === "hello");
    assert.equal(helloUsers.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("ProviderRuntime returning from OpenRouter rebuilds real SIWC WebSocket input without a stale compaction checkpoint", async () => {
  const { ProviderRuntime } = await import("../providers.js");
  const directory = await mkdtemp(join(tmpdir(), "gateway-provider-ws-"));
  const firstResponse = messageResponse("old-response", "first answer");
  (firstResponse.output as unknown[]).unshift({ type: "compaction", encrypted_content: "stale-before-openrouter" });
  const firstSocket = new FakeSocket([firstResponse]);
  const nextSocket = new FakeSocket([messageResponse("new-response", "continued answer")]);
  let connections = 0;
  const bridge = new StatefulResponsesBridge(directory, () => connections++ ? nextSocket : firstSocket);
  try {
    const siwc = {
      async getSession() { return { status: "connected", sharing: true }; },
      async getModelSelection() { return { mode: "pinned", model: "test-model", resolvedModel: "test-model" }; },
      async reply(turn: any) { return bridge.reply({ ...request(), ...turn, accessToken: "fixture", model: "test-model" }); },
      async commitSession(id: string, text: string, deliveryId?: string) { return bridge.commitSession(id, text, deliveryId); },
    };
    const openrouter = { ...siwc, async reply() { return { text: "middle answer" }; }, async commitSession() {} };
    let providers = new ProviderRuntime(directory, { siwc, openrouter } as any);
    const id = "telegram:reliability";
    const first = await providers.reply({ purpose: "chat", sessionId: id, messages: [{ role: "user", content: "first question" }], stateful: true, deferAssistantCommit: true });
    await providers.commitSession(id, "first answer", first.deliveryId);
    await providers.selectProvider("openrouter");
    await providers.reply({ purpose: "chat", sessionId: id, text: "middle question" });
    await providers.selectProvider("siwc");
    // Simulate Gateway wrapper restart while the old bridge checkpoint remains on disk.
    providers = new ProviderRuntime(directory, { siwc, openrouter } as any);
    await providers.reply({ purpose: "chat", sessionId: id, messages: [
      { role: "user", content: "first question" }, { role: "assistant", content: "first answer" },
      { role: "user", content: "middle question" }, { role: "assistant", content: "middle answer" },
      { role: "user", content: "continue" },
    ], stateful: true, context: { controlRevision: "new-control", contextRevision: "new-context", content: '{"recent":"latest"}' } });
    const sent = nextSocket.sent[0]!;
    assert.equal(sent.previous_response_id, undefined);
    const input = sent.input as Record<string, unknown>[];
    assert.ok(input.some(item => item.role === "user" && item.content === "middle question"));
    assert.ok(input.some(item => item.role === "assistant" && item.content === "middle answer"));
    assert.equal(input.some(item => item.type === "compaction"), false);
    assert.doesNotMatch(JSON.stringify(sent), /stale-before-openrouter/);
    assert.match(JSON.stringify(sent), /latest/);
  } finally { bridge.close(); await rm(directory, { recursive: true, force: true }); }
});

test("independent image tool runs through the real SIWC WebSocket loop while preserving the same session and next-turn context",async()=>{
  const {ProviderRuntime}=await import("../providers.js");
  const root=await mkdtemp(join(tmpdir(),"gateway-siwc-image-tool-"));
  const socket=new FakeSocket([{id:"image-tool",output:[{type:"function_call",call_id:"img-1",namespace:"gateway",
    name:"gateway_generate_image",arguments:'{"prompt":"a cat"}'}]},messageResponse("image-done","已生成猫的示例图片"),messageResponse("continued","还是刚才那只猫")]);
  const bridge=new StatefulResponsesBridge(root,()=>socket);
  let imageCalls=0;
  const image={kind:"image" as const,path:"fixture",size:1,width:1,height:1,sha256:"fixture",prompt:"a cat",model:"image-model"};
  const siwc={async reply(turn:any){return bridge.reply({...request(),...turn,accessToken:"fixture",model:"test-model"});},
    async commitSession(id:string,text:string,deliveryId?:string){await bridge.commitSession(id,text,deliveryId);}};
  const or={async getImageSettings(){return {route:"openrouter",proactive:true,model:"image-model"};},
    async canGenerateImage(){return true;},async generateImage(req:any){
      assert.deepEqual(Object.keys(req).sort(),["autonomous","operationId","prompt"]);
      assert.equal(req.prompt,"a cat");imageCalls++;return {text:"",images:[image]};}};
  const runtime=new ProviderRuntime(root,{siwc,openrouter:or} as any);
  try {
    const first=await runtime.reply({purpose:"chat",sessionId:"telegram:image",operationId:"turn1",imageOutputAllowed:true,stateful:true,
      deferAssistantCommit:true,messages:[{role:"user",content:"你好"}],instructions:"PRIVATE_POLICY",
      context:{controlRevision:"control",contextRevision:"context",content:"PRIVATE_CONTEXT"}});
    assert.equal(first.images?.length,1);assert.equal(imageCalls,1);
    await runtime.commitSession("telegram:image","已生成猫的示例图片",first.deliveryId);
    await runtime.reply({purpose:"chat",sessionId:"telegram:image",operationId:"turn2",stateful:true,
      messages:[{role:"user",content:"你好"},{role:"assistant",content:"已生成猫的示例图片"},{role:"user",content:"这是什么猫"}],
      instructions:"PRIVATE_POLICY",context:{controlRevision:"control",contextRevision:"context",content:"PRIVATE_CONTEXT"}});
    assert.equal(socket.sent[2]!.previous_response_id,"image-done");
    assert.equal(imageCalls,1);assert.equal(await runtime.getProvider(),"siwc");
  } finally {bridge.close();await rm(root,{recursive:true,force:true});}
});

test("completed diagnostic lane can be reset and its socket released", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-cli-diagnostic-clean-"));
  try {
    let closed = 0;
    const socket = new FakeSocket([messageResponse("diag-id", "diagnostic-ready")]);
    socket.onClose(() => { closed++; });
    const bridge = new StatefulResponsesBridge(directory, () => socket);
    const result = await bridge.reply({
      ...request("diagnostic"),
      sessionId: "cli-isolation-fixture",
    });
    assert.equal(result.text, "diagnostic-ready");
    await bridge.resetSession("cli-isolation-fixture");
    assert.ok(closed >= 1, "diagnostic WebSocket must close after cleanup");
    bridge.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("idle SIWC socket rotates before the 60-minute server limit and next turn rebuilds history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-socket-rotation-"));
  const first = new FakeSocket([messageResponse("old", "已回答")]);
  const next = new FakeSocket([messageResponse("new", "连接已恢复")]);
  const sockets = [first, next];
  const bridge = new StatefulResponsesBridge(directory, () => sockets.shift()!, 300_000,
    async () => undefined, 20);
  try {
    await bridge.reply(request("上个问题"));
    await new Promise(resolve => setTimeout(resolve, 70));
    const result = await bridge.reply(request("下个问题"));
    assert.equal(result.text, "连接已恢复");
    assert.equal(first.sent.length, 1);
    assert.equal(next.sent.length, 1);
    assert.equal(next.sent[0]?.previous_response_id, undefined);
    const restored = JSON.stringify(next.sent[0]?.input);
    assert.match(restored, /上个问题/);
    assert.match(restored, /下个问题/);
  } finally {
    await bridge.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("closing a bridge cancels the SIWC socket expiry timer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-socket-shutdown-"));
  const socket = new FakeSocket([messageResponse("old", "完成")]);
  const bridge = new StatefulResponsesBridge(directory, () => socket, 300_000,
    async () => undefined, 20);
  try {
    await bridge.reply(request());
    await bridge.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(socket.sent.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SIWC >48K completed chat keeps previous_response_id without a proactive rebase", async () => {
  const { historyFromMessages } = await import("../history.js");
  const directory = await mkdtemp(join(tmpdir(), "gateway-window-rebase-"));
  const first = new FakeSocket([{
    ...messageResponse("large", "first answer"),
    usage: { input_tokens: 49_000, output_tokens: 100, total_tokens: 49_100 },
  }, messageResponse("continued", "second answer")]);
  const bridge = new StatefulResponsesBridge(directory, () => first);
  try {
    await bridge.reply({ ...request("first question"), history: historyFromMessages([]),
      deferAssistantCommit: true, deliveryId: "delivered-first" });
    await bridge.commitSession(request().sessionId, "first answer", "delivered-first");
    await bridge.reply({ ...request("second question"), history: historyFromMessages([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]) });
    assert.equal(first.sent.length, 2);
    assert.equal(first.sent[1]?.previous_response_id, "large");
    assert.doesNotMatch(JSON.stringify(first.sent[1]?.input), /first question|first answer/);
    assert.match(JSON.stringify(first.sent[1]?.input), /second question/);
    assert.equal(first.sent[1]?.context_management, undefined);
  } finally { await bridge.close(); await rm(directory, {recursive: true, force: true}); }
});


test("no weekly or capacity requests are scheduled; legacy server checkpoints remain recoverable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-weekly-fallback-"));
  let now = Date.parse("2026-10-01T00:00:00Z");
  const compacted = messageResponse("server-compact", "after server compaction");
  (compacted.output as Record<string, unknown>[]).unshift({ type: "compaction", encrypted_content: "verified-server-opaque" });
  const socket = new FakeSocket([
    messageResponse("first", "first answer"),
    messageResponse("unsupported", "still not compacted"),
    compacted,
    messageResponse("later", "still within new seven days"),
  ]);
  let attempted = 0;
  const bridge = new StatefulResponsesBridge(directory, () => socket, 300_000,
    async () => undefined, 50 * 60_000, () => new Date(now),
    async () => { attempted++; throw Object.assign(new Error("unsupported"), { status: 404 }); });
  try {
    await bridge.reply(request("first"));
    now += 7 * 24 * 60 * 60_000;
    const failed = await bridge.reply(request("due"));
    assert.equal(failed.compaction, undefined);
    assert.equal(attempted, 0);
    assert.equal(socket.sent[1]!.context_management, undefined);
    const actual = await bridge.reply(request("server auto compacted"));
    assert.equal(actual.compaction, undefined);
    assert.equal(attempted, 0);
    now += 2 * 24 * 60 * 60_000;
    await bridge.reply(request("within new window"));
    assert.equal(attempted, 0);
    assert.equal(socket.sent[3]!.context_management, undefined);
  } finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SIWC does not rebase a sub-threshold active conversation", async () => {
  const { historyFromMessages } = await import("../history.js");
  const directory = await mkdtemp(join(tmpdir(), "gateway-window-no-rebase-"));
  const socket = new FakeSocket([
    { ...messageResponse("normal", "first answer"), usage: { input_tokens: 47_000, output_tokens: 200 } },
    messageResponse("continued", "second answer"),
  ]);
  const bridge = new StatefulResponsesBridge(directory, () => socket);
  try {
    await bridge.reply({ ...request("first question"), history: historyFromMessages([]) });
    await bridge.reply({ ...request("second question"), history: historyFromMessages([
      { role:"user",content:"first question" },
      { role:"assistant",content:"first answer" },
    ]) });
    assert.equal(socket.sent[1]?.previous_response_id, "normal");
  } finally { await bridge.close(); await rm(directory, {recursive: true, force: true}); }
});


for(const kind of ["none","read","voice","write","image"] as const) test("SIWC terminal model error permits only safe manual replay: "+kind,async()=>{
  const directory=await mkdtemp(join(tmpdir(),"siwc-manual-retry-"));
  const {voiceTool,VoiceTurn}=await import("../../voice/tool.js");
  const voice=new VoiceTurn();const safe=["none","read","voice"].includes(kind);
  const tool=kind==="voice"?voiceTool:{name:kind,parameters:{type:"object"},readOnly:kind==="read"};
  const first=new FakeSocket([
    ...(kind==="none"?[]:[{id:"selected",output:[{type:"function_call",call_id:"first",name:tool.name,arguments:JSON.stringify(kind==="voice"?{text:"你好",instruction:"自然表达"}:{})}]}]),
    {__event:"failed",error:{code:"invalid_request_error",message:"fixture terminal model failure"}},
  ]);
  const bridge=new StatefulResponsesBridge(directory,()=>first,300_000,async()=>assert.fail("no automatic retries"));
  try{
    let calls=0;
    await assert.rejects(bridge.reply({...request("保留原问题"),tools:kind==="none"?[]:[tool],executeTool:async(_name,args)=>{calls++;return kind==="voice"?voice.select(args):{success:true};}}),
      (error:any)=>{assert.equal(error.inboundRetryable,false);assert.equal(error.inboundManualRetryable,safe);return true;});
    assert.equal(calls,Number(kind!=="none"));assert.equal(first.sent.length,kind==="none"?1:2);
    if(safe){
      await bridge.close();
      const next=new FakeSocket([messageResponse("ok","恢复成功")]);
      const restarted=new StatefulResponsesBridge(directory,()=>next);
      try{
        assert.equal((await restarted.reply(request("保留原问题"))).text,"恢复成功");
        const input=next.sent[0]!.input as any[];
        assert.equal(input.filter(item=>item.role==="user"&&item.content==="保留原问题").length,1);
        assert.equal(input.some(item=>item.type==="function_call"),false,"discard only safe turn-scoped work before retry");
      }finally{await restarted.close();}
    }
  }finally{await bridge.close();await rm(directory,{recursive:true,force:true});}
});

test('SIWC prepares information before its required final decision without delivering preparation text',async()=>{
 const root=await mkdtemp(join(tmpdir(),'prepared-decision-'));
 let decided=false,reads=0;const recorded:string[]=[];
 const fn=(id:string,name:string)=>({type:'function_call',call_id:id,name,arguments:'{}'});
 const socket=new FakeSocket([
  {id:'prepare',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Preparation text must not be delivered'}]},fn('read','sample_read')]},
  {id:'decision',output:[fn('decide','sample_decision'),{type:'message',role:'assistant',content:[{type:'output_text',text:'Decision-round text must not be delivered'}]}]},
  messageResponse('final','Sample document checked'),
 ]);
 const bridge=new StatefulResponsesBridge(root,()=>socket);
 try{
  const result=await bridge.reply({...request(),ephemeral:true,requiredToolTiming:'before_reply',requiredTool:()=>decided?undefined:'sample_decision',
   tools:['sample_read','sample_decision'].map(name=>({name,readOnly:true,parameters:{type:'object'}})),
   recordReplyText:text=>recorded.push(text),executeTool:async name=>{if(name==='sample_read'){reads++;assert.equal(decided,false);}else decided=true;return {ok:true};}});
  assert.equal(reads,1);assert.equal(result.text,'Sample document checked');assert.ok(recorded.every(text=>!text.includes('must not')));
  assert.equal(socket.sent.length,3);
  assert.ok((socket.sent[0]!.tools as any[]).some(t=>t.name==='sample_read'||t.tools?.some((f:any)=>f.name==='sample_read')));
 }finally{await bridge.close();await rm(root,{recursive:true,force:true});}
});
