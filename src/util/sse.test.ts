import test from "node:test";
import assert from "node:assert/strict";
import { readSseData } from "./sse.js";

test("SSE preserves split UTF-8, CR/LF, multiline data and final unterminated event", async () => {
  const bytes = new TextEncoder().encode(': comment\r\ndata: 中文\r\ndata: 第二行\r\n\r\ndata: final');
  const response = new Response(new ReadableStream({ start(c) {
    for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close();
  } }));
  const values: string[] = [];
  for await (const value of readSseData(response)) values.push(value);
  assert.deepEqual(values, ["中文\n第二行", "final"]);
  assert.equal(response.body!.locked, false);
});

test("early SSE consumer termination cancels and releases the reader", async () => {
  let canceled = 0;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: one\n\ndata: two\n\n")); }, cancel() { canceled++; } }));
  for await (const data of readSseData(response)) { assert.equal(data, "one"); break; }
  assert.equal(canceled, 1); assert.equal(response.body!.locked, false);
});

test("SSE limit failures release the reader before protocol errors propagate", async () => {
  const response = new Response("data: oversized\n\n");
  await assert.rejects(async () => { for await (const _data of readSseData(response, { maxBytes: 2 })) {} }, /limit/);
  assert.equal(response.body!.locked, false);
});
