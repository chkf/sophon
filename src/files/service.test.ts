import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeGateway } from "../setup.js";
import type { InboundMessage } from "../channels/types.js";
import { FileService, MAX_FILE_BYTES, type OutboundDocument } from "./service.js";

const owner = "70001";
const message = (id = "request-1", text = "请处理测试文档"): InboundMessage => ({
  channel: "telegram", conversationId: owner, senderId: owner, messageId: id, text,
  receivedAt: "2030-01-02T09:00:00Z", attachments: [],
});
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "sophon-files-"));
  const data = join(root, "state");
  await initializeGateway(data);
  t.after(() => rm(root, { recursive: true, force: true }));
  const sent: OutboundDocument[] = [];
  let now = Date.parse("2030-01-02T09:00:00Z");
  const sender = async (file: OutboundDocument) => { sent.push(file); return sent.length; };
  const generated = join(root, "generated");
  const create = (send = sender) => new FileService(data, generated, owner, send, () => now);
  return { root, data, generated, sent, create, service: create(), advance: (ms: number) => { now += ms; } };
}
const run = (service: FileService, name: string, args: Record<string, unknown>, input = message()) => service.execute(name, args, input);

test("directory pages, metadata and text windows use bounded synthetic files", async t => {
  const f = await fixture(t);
  const path = join(f.root, "report.txt");
  await writeFile(path, "abcdef");
  const page = await run(f.service, "gateway_file_list", { path: f.root, limit: 1 });
  assert.equal((page.items as unknown[]).length, 1);
  assert.equal(page.nextOffset, 1);
  assert.equal((await run(f.service, "gateway_file_info", { path })).bytes, 6);
  assert.deepEqual(await run(f.service, "gateway_file_read", { path, offset: 2, maxChars: 2 }), { path, content: "cd", totalChars: 6, nextOffset: 4 });
  await assert.rejects(run(f.service, "gateway_file_read", { path, maxChars: 12001 }), /pagination/);
  await writeFile(path, Buffer.from([255, 254, 0]));
  await assert.rejects(run(f.service, "gateway_file_read", { path }));
});

test("save, generated delivery and filename collisions retain actual paths", async t => {
  const f = await fixture(t);
  const args = { mode: "generate", filename: "report.csv", content: "item,count\nA,2\n" };
  const first = await run(f.service, "telegram_send_document", args);
  const second = await run(f.service, "telegram_send_document", args, message("request-2"));
  assert.notEqual(first.path, second.path);
  assert.equal(await readFile(first.path as string, "utf8"), args.content);
  assert.equal(await readFile(second.path as string, "utf8"), args.content);
  assert.deepEqual(f.sent.map(file => file.filename), ["report.csv", "report.csv"]);
  const path = join(f.root, "notes.md");
  const save = { mode: "save", filename: "notes.md", path, content: "# Document\n" };
  const saved = await run(f.service, "telegram_send_document", save, message("request-3"));
  assert.equal(saved.path, path);
  assert.equal(saved.delivered, undefined);
  assert.deepEqual(await run(f.create(), "telegram_send_document", save, message("request-3")), saved);
  await assert.rejects(run(f.service, "telegram_send_document", save, message("request-4")), /EEXIST/);
  assert.equal(f.sent.length, 2);
});

test("concurrent document requests and restart reuse confirmed delivery receipts", async t => {
  const f = await fixture(t);
  const args = { mode: "generate", filename: "说明.txt", content: "合成文档内容" };
  const [a, b] = await Promise.all([run(f.service, "telegram_send_document", args), run(f.service, "telegram_send_document", args)]);
  assert.deepEqual(a, b);
  assert.deepEqual(await run(f.create(), "telegram_send_document", args), a);
  assert.equal(f.sent.length, 1);
  await assert.rejects(run(f.service, "telegram_send_document", { ...args, content: "changed" }), /different content/);
});

test("uncertain sends remain consumed after restart and require a new user request", async t => {
  const f = await fixture(t);
  let calls = 0;
  const failed = f.create(async () => { calls++; throw new Error("simulated connection interruption"); });
  const args = { mode: "generate", filename: "output.json", content: "{}" };
  await assert.rejects(run(failed, "telegram_send_document", args), /interruption/);
  const recovered = await run(f.create(), "telegram_send_document", args);
  assert.equal(recovered.uncertain, true);
  assert.equal(calls, 1);
  assert.equal(f.sent.length, 0);
  await run(f.service, "telegram_send_document", args, message("new-request"));
  assert.equal(f.sent.length, 1);
});

test("existing binary files retain bytes while oversize and linked files are rejected", async t => {
  const f = await fixture(t);
  const path = join(f.root, "sample.bin");
  await writeFile(path, Buffer.from([0, 1, 2, 255]));
  await run(f.service, "telegram_send_document", { mode: "existing", path });
  assert.deepEqual(Buffer.from(f.sent[0]!.bytes), Buffer.from([0, 1, 2, 255]));
  const linked = join(f.root, "linked.bin");
  await symlink(path, linked);
  await assert.rejects(run(f.service, "telegram_send_document", { mode: "existing", path: linked }, message("link-request")));
  await truncate(path, MAX_FILE_BYTES + 1);
  await assert.rejects(run(f.service, "telegram_send_document", { mode: "existing", path }, message("large-request")), /20 MiB/);
  assert.equal(f.sent.length, 1);
});

test("file tools are limited to the configured owner conversation", async t => {
  const f = await fixture(t);
  for (const input of [{ ...message(), channel: "wechat" as const }, { ...message(), senderId: "70002" }, { ...message(), conversationId: "70002" }]) {
    assert.deepEqual(f.service.tools(input), []);
    await assert.rejects(run(f.service, "telegram_send_document", { mode: "save", filename: "output.txt", content: "data" }, input), /unavailable/);
  }
  await assert.rejects(run(f.service, "unknown_tool", {}), /unavailable/);
  for (const name of ["../output.txt", "a/b.txt", "a\\b.txt", ".", "a\n.txt", "文".repeat(81)]) {
    await assert.rejects(run(f.service, "telegram_send_document", { mode: "generate", filename: name, content: "data" }), /filename/);
  }
});

test("replacement and deletion require exact confirmation from a later message", async t => {
  const f = await fixture(t);
  const path = join(f.root, "draft.txt");
  await writeFile(path, "version one");
  const proposal = await run(f.service, "gateway_file_propose", { action: "replace", path, content: "version two" });
  assert.equal(await readFile(path, "utf8"), "version one");
  assert.equal(proposal.preview, "version two");
  await assert.rejects(run(f.service, "gateway_file_apply", { confirmation: proposal.confirmation }, message("approval", "proceed")), /explicitly confirm/);
  await assert.rejects(run(f.service, "gateway_file_apply", { confirmation: proposal.confirmation }, message("request-1", proposal.instruction as string)), /missing or expired/);
  const approval = message("approval", proposal.instruction as string);
  const result = await run(f.service, "gateway_file_apply", { confirmation: proposal.confirmation }, approval);
  assert.equal(await readFile(path, "utf8"), "version two");
  assert.deepEqual(await run(f.service, "gateway_file_apply", { confirmation: proposal.confirmation }, approval), result);
  const deletion = await run(f.service, "gateway_file_propose", { action: "delete", path }, message("delete-request"));
  await run(f.service, "gateway_file_apply", { confirmation: deletion.confirmation }, message("delete-approval", deletion.instruction as string));
  await assert.rejects(readFile(path), /ENOENT/);
});

test("changed files, expired proposals and restarted confirmation state cannot be applied", async t => {
  const f = await fixture(t);
  const path = join(f.root, "draft.txt");
  await writeFile(path, "initial");
  const proposal = await run(f.service, "gateway_file_propose", { action: "delete", path });
  const approval = message("approval", proposal.instruction as string);
  await assert.rejects(run(f.create(), "gateway_file_apply", { confirmation: proposal.confirmation }, approval), /missing or expired/);
  await writeFile(path, "updated independently");
  await assert.rejects(run(f.service, "gateway_file_apply", { confirmation: proposal.confirmation }, approval), /changed/);
  const newer = await run(f.service, "gateway_file_propose", { action: "replace", path, content: "replacement" }, message("new-proposal"));
  f.advance(15 * 60_000);
  await assert.rejects(run(f.service, "gateway_file_apply", { confirmation: newer.confirmation }, message("new-approval", newer.instruction as string)), /expired/);
  assert.equal(await readFile(path, "utf8"), "updated independently");
});
