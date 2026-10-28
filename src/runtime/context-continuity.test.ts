import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApiRuntime } from "./api.js";
import { OpenRouterRuntime } from "./openrouter.js";
import { createHistory, historyFromMessages } from "./history.js";
import { ToolGroups } from "./tool-groups.js";
import { DECISION_TOOL_NAME, TurnDecisionState } from "./turn-decision.js";
import type { ChatMessage, RuntimeTool } from "./types.js";
import { buildMemoryRebase, validMemoryRebase } from "./siwc/memory-rebase.js";

type ModelMessage = { role: string; content: string | Array<{ type: string; text: string }>; tool_call_id?: string };
type SubmittedRequest = { messages: ModelMessage[]; tools?: Array<{ function: RuntimeTool }>; max_tokens?: number };
const content = (message: ModelMessage) => typeof message.content === "string" ? message.content : message.content.map(part => part.text).join("");
const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
function replyResponse(stream: boolean, text: string, calls?: ReturnType<typeof call>[]): Response {
  const message = { role: "assistant", content: text, ...(calls ? { tool_calls: calls } : {}) };
  if (!stream) return Response.json({ choices: [{ message, finish_reason: calls ? "tool_calls" : "stop" }] });
  const delta = { ...message, ...(calls ? { tool_calls: calls.map((value, index) => ({ ...value, index })) } : {}) };
  return new Response("data: " + JSON.stringify({ choices: [{ delta, finish_reason: calls ? "tool_calls" : "stop" }] }) +
    "\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

for (const provider of ["api", "openrouter"] as const) {
  test(`${provider} preserves full text history through tool loading without local context or output caps`, async t => {
    const root = await mkdtemp(join(tmpdir(), "sophon-context-continuity-"));
    const history: ChatMessage[] = Array.from({ length: 280 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user", content: `Sample record ${index}: ` + "Document details. ".repeat(50),
    }));
    const source = structuredClone(history), reads: number[] = [];
    const current = "Current sample question. ".repeat(2_000);
    const resultText = "Sample answer. ".repeat(1_000);
    const toolResult = "Synthetic document field. ".repeat(3_000);
    const remoteName = "mcp_sample_" + "c".repeat(24);
    const groups = new ToolGroups([{ name: remoteName, description: "Read a sample document.", readOnly: true,
      parameters: { type: "object", properties: { key: { type: "string", description: "Sample field. ".repeat(500) } } },
    }]);
    const decision = new TurnDecisionState({ voice: false, sticker: false, quote: false, image: false }, undefined);
    groups.tools.push(decision.tool);
    const submitted: SubmittedRequest[] = [];
    let executions = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "sample-model", name: "Sample model",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["tools"], context_length: 8192,
      }] });
      assert.ok(String(url).endsWith("/chat/completions"));
      const body = JSON.parse(String(init?.body));
      submitted.push(body);
      if (submitted.length === 3) return replyResponse(body.stream, "", [call("select", DECISION_TOOL_NAME, {
        stage_direction: "Reviewing the sample document.", reply_mode: "text",
        sticker: "skip", quote: "skip", image: "skip",
      })]);
      if (submitted.length === 1) return replyResponse(body.stream, "", [call("load", "gateway_load_tools", {groups:["mcp_sample"]})]);
      if (submitted.length === 2) return replyResponse(body.stream, "", [call("read", remoteName, { key: "sample" })]);
      assert.equal(submitted.length, 4);
      return replyResponse(body.stream, resultText);
    };
    const runtime = provider === "api"
      ? new ApiRuntime({ dataDir: root, baseUrl: "https://api.example/v1", defaultModel: "sample-model", stream: false, fetch: fetcher })
      : new OpenRouterRuntime({ dataDir: root, apiKey: "synthetic-key", defaultModel: "sample-model", fetch: fetcher });
    t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
    const request = {
      purpose: "chat" as const, sessionId: "sample-conversation", operationId: "sample-operation", text: current,
      history: createHistory(history.length, async (offset, length) => { reads.push(offset); return history.slice(offset, offset + length); }),
      requiredToolTiming: "before_reply" as const, tools: groups.tools, getTools: () => groups.tools, requiredTool: () => decision.current ? undefined : DECISION_TOOL_NAME,
      executeTool: async (name: string, args: Record<string, unknown>) => {
        if (name === "gateway_load_tools") return groups.execute(args);
        if (name === DECISION_TOOL_NAME) return decision.select(args);
        assert.equal(name, remoteName); executions++; return { value: toolResult };
      },
    };
    const response = await runtime.reply(request);
    assert.equal(response.text, resultText.trim());
    assert.equal(response.contextEffect, "none");
    assert.deepEqual(reads, [0, 256]);
    assert.deepEqual(submitted[0]!.messages.slice(1).map(content), [...history.map(message => message.content), current]);
    assert.ok(submitted[0]!.tools?.some(tool => tool.function.name === "gateway_load_tools"));
    assert.ok(submitted[1]!.tools?.some(tool => tool.function.name === remoteName));
    assert.equal(JSON.parse(content(submitted[2]!.messages.at(-1)!)).value, toolResult);
    for (const body of submitted) assert.equal(Object.hasOwn(body, "max_tokens"), false);
    assert.equal(executions, 1);
    assert.deepEqual(history, source);
    assert.equal((await runtime.reply(request)).text, resultText.trim());
    assert.equal(submitted.length, 4, "a completed operation is not billed or executed again");
  });
}

test("an upstream capacity rejection is not retried with shortened history", async t => {
  const root = await mkdtemp(join(tmpdir(), "sophon-context-rejection-"));
  const messages: ChatMessage[] = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user", content: "Sample capacity record " + i + " ".repeat(2_000),
  }));
  let calls = 0;
  const runtime = new ApiRuntime({ dataDir: root, baseUrl: "https://api.example/v1", defaultModel: "sample-model", stream: false,
    fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as SubmittedRequest;
      assert.deepEqual(body.messages.slice(1, -1).map(content), messages.map(message => message.content));
      return Response.json({ error: { message: "Synthetic provider capacity rejection." } }, { status: 400 });
    },
  });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const request = { purpose: "chat" as const, sessionId: "sample-rejection", text: "Review the sample.", history: historyFromMessages(messages) };
  await assert.rejects(runtime.reply(request), /HTTP 400/);
  await assert.rejects(runtime.reply(request), /HTTP 400/);
  assert.equal(calls, 1);
});

test("an incomplete history snapshot fails before a chat request is submitted", async t => {
  const root = await mkdtemp(join(tmpdir(), "sophon-history-snapshot-"));
  const runtime = new ApiRuntime({ dataDir: root, baseUrl: "https://api.example/v1", defaultModel: "sample-model", stream: false,
    fetch: async () => { assert.fail("An incomplete snapshot must not be submitted."); },
  });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(runtime.reply({ purpose: "chat", sessionId: "sample-snapshot", text: "Review the sample.",
    history: createHistory(3, async () => [{ role: "user", content: "Incomplete sample." }]),
  }), /历史快照发生变化/);
});

test("memory rebasing keeps the complete selected calendar window above the former token budget", async () => {
  const current: ChatMessage[] = Array.from({ length: 300 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user", content: `Sample entry ${index}: ` + "Document details. ".repeat(100),
    at: "2030-01-02T08:00:00Z",
  }));
  const history = historyFromMessages([
    { role: "user", content: "Earlier sample question.", at: "2029-12-28T08:00:00Z" },
    { role: "assistant", content: "Earlier sample answer.", at: "2029-12-28T08:01:00Z" },
    ...current,
  ]);
  const rebuilt = await buildMemoryRebase(history, { ready: true, revision: 1, content: '{"records":[]}' }, "UTC", new Date("2030-01-02T10:00:00Z"));
  assert.equal(rebuilt.metadata.fromSeq, 2);
  assert.equal(rebuilt.metadata.throughSeq, history.count);
  assert.deepEqual(rebuilt.items.slice(1).map(item => String(item.content).split("\n").slice(1).join("\n")), current.map(message => message.content));
  assert.equal(validMemoryRebase(rebuilt.metadata, rebuilt.items, history.count), true);
});
