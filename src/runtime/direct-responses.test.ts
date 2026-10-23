import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDirectResponse } from "./direct-responses.js";

function sse(res: import("node:http").ServerResponse, events: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) res.write("data: " + JSON.stringify(event) + "\n\n");
  res.end();
}

test("direct Responses round-trips Gateway function calls and rich inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-direct-response-"));
  const imagePath = join(directory, "image.png");
  const filePath = join(directory, "notes.txt");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(filePath, "hello file", "utf8");

  let requestCount = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requestCount += 1;

    assert.equal(req.headers.authorization, "Bearer test-token");
    assert.equal(body.store, false);
    assert.equal(body.stream, true);

    if (requestCount === 1) {
      const tools = body.tools as Array<Record<string, unknown>>;
      assert.equal(tools[0]?.type, "namespace");
      assert.equal(tools[0]?.name, "gateway");

      const input = body.input as Array<Record<string, unknown>>;
      const user = input.at(-1) as { content: Array<Record<string, unknown>> };
      assert.ok(user.content.some((part) => part.type === "input_image"));
      assert.ok(user.content.some((part) => part.type === "input_file"));

      sse(res, [
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            namespace: "gateway",
            name: "fixture_read",
            arguments: "{\"area\":\"recent\"}",
          },
        },
        { type: "response.completed" },
      ]);
      return;
    }

    const input = body.input as Array<Record<string, unknown>>;
    const output = input.find((item) => item.type === "function_call_output");
    assert.equal(output?.call_id, "call_1");
    assert.match(String(output?.output), /recent-ok/);

    sse(res, [
      { type: "response.output_text.delta", delta: "final reply" },
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "final reply", annotations: [] }],
        },
      },
      { type: "response.completed" },
    ]);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    let toolCalls = 0;
    const text = await runDirectResponse({
      endpoint: "http://127.0.0.1:" + address.port + "/v1/responses",
      accessToken: "test-token",
      model: "test-model",
      messages: [{ role: "user", content: "read this" }],
      attachments: [
        { kind: "image", path: imagePath, fileName: "image.png", mimeType: "image/png" },
        { kind: "file", path: filePath, fileName: "notes.txt", mimeType: "text/plain" },
      ],
      tools: [{
        name: "fixture_read",
        description: "Read local fixture data.",
        parameters: {
          type: "object",
          properties: { area: { type: "string" } },
          required: ["area"],
        },
        readOnly: true,
      }],
      async executeTool(name, args) {
        toolCalls += 1;
        assert.equal(name, "fixture_read");
        assert.deepEqual(args, { area: "recent" });
        return { markdown: "recent-ok" };
      },
    });
    assert.equal(text, "final reply");
    assert.equal(toolCalls, 1);
    assert.equal(requestCount, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});


test("direct Responses supports unlimited tool rounds when maxToolRounds is 0", async () => {
  let requestCount = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain request body */ }
    requestCount += 1;

    if (requestCount <= 6) {
      sse(res, [
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_" + requestCount,
            call_id: "call_" + requestCount,
            namespace: "gateway",
            name: "fixture_read",
            arguments: "{\"area\":\"recent\"}",
          },
        },
        { type: "response.completed" },
      ]);
      return;
    }

    sse(res, [
      { type: "response.output_text.delta", delta: "finished after many tools" },
      { type: "response.completed" },
    ]);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    let toolCalls = 0;
    const text = await runDirectResponse({
      endpoint: "http://127.0.0.1:" + address.port + "/v1/responses",
      accessToken: "test-token",
      model: "test-model",
      messages: [{ role: "user", content: "do a long task" }],
      tools: [{
        name: "fixture_read",
        parameters: { type: "object", properties: {} },
        readOnly: true,
      }],
      maxToolRounds: 0,
      async executeTool() {
        toolCalls += 1;
        return { ok: true, round: toolCalls };
      },
    });

    assert.equal(text, "finished after many tools");
    assert.equal(toolCalls, 6);
    assert.equal(requestCount, 7);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("direct Responses still enforces a positive configured tool-round limit", async () => {
  let requestCount = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain request body */ }
    requestCount += 1;
    sse(res, [
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_" + requestCount,
          call_id: "call_" + requestCount,
          namespace: "gateway",
          name: "fixture_read",
          arguments: "{\"area\":\"recent\"}",
        },
      },
      { type: "response.completed" },
    ]);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    let toolCalls = 0;
    await assert.rejects(
      runDirectResponse({
        endpoint: "http://127.0.0.1:" + address.port + "/v1/responses",
        accessToken: "test-token",
        model: "test-model",
        messages: [{ role: "user", content: "keep using tools" }],
        tools: [{
          name: "fixture_read",
          parameters: { type: "object", properties: {} },
          readOnly: true,
        }],
        maxToolRounds: 2,
        async executeTool() {
          toolCalls += 1;
          return { ok: true };
        },
      }),
      /configured maximum number of rounds/,
    );

    assert.equal(toolCalls, 2);
    assert.equal(requestCount, 3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
