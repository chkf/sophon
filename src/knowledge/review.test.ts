import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeGateway } from "../setup.js";
import { SessionStore } from "../sessions/store.js";
import { LocalCoreContextProvider } from "../core/context.js";
import { LocalKnowledgeStore } from "./store.js";
import { RecentReview, parseReview } from "./review.js";
import { mainPath, openDatabase, getState } from "../state/database.js";
import { validateSixSchema } from "../state/schema.js";
import type { ChatRequest, ChatResponse } from "../runtime/types.js";

const owner = "70001";
const scope = "formal:telegram:" + owner;
const epoch = Date.parse("2030-01-02T09:00:00Z");
const time = (minutes = 0) => new Date(epoch + minutes * 60_000);
const empty = { changes: [], creates: [], deletes: [] };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "sophon-review-"));
  const data = join(root, "state");
  await initializeGateway(data);
  const sessions = new SessionStore(data);
  const knowledge = new LocalKnowledgeStore(data, "formal");
  t.after(async () => { knowledge.close(); sessions.close(); await rm(root, { recursive: true, force: true }); });
  const calls: ChatRequest[] = [];
  let responder: (request: ChatRequest) => Promise<ChatResponse> = async () => ({ text: JSON.stringify(empty) });
  const create = () => new RecentReview(data, owner, { reply: async request => { calls.push(request); return responder(request); } },
    sessions, knowledge, new LocalCoreContextProvider(data));
  const append = (texts: string[], channel: "telegram" | "wechat" = "telegram", id = owner) => sessions.append(channel, id, id,
    texts.map((content, index) => ({ role: "user" as const, content, at: new Date(epoch + index).toISOString() })));
  return { data, sessions, knowledge, calls, create, review: create(), append,
    respond: (fn: typeof responder) => { responder = fn; } };
}

test("review atomically creates, updates and deletes without writing a chat reply", async t => {
  const f = await fixture(t);
  const current = f.knowledge.createRecent({ body: "Document A: draft", conversationState: "Ongoing" });
  const duplicate = f.knowledge.createRecent({ body: "Duplicate document note" });
  await f.append(["Document A has been checked.", "Track the remaining formatting work."]);
  f.respond(async () => ({ text: JSON.stringify({
    changes: [{ id: current.id, expectedRevision: 1, body: "Document A: checked" }],
    creates: [{ body: "Formatting work remains", conversationState: "Pending", stateDate: "2030-01-02" }],
    deletes: [{ id: duplicate.id, expectedRevision: 1 }],
  }) }));
  assert.equal(await f.review.tick(time()), "committed");
  assert.equal(f.knowledge.getReviewCursor(scope), 1);
  assert.equal(f.knowledge.getRecent(current.id)?.body, "Document A: checked");
  assert.equal(f.knowledge.getRecent(duplicate.id), undefined);
  assert.equal(f.knowledge.listRecent().length, 2);
  assert.equal((await f.sessions.view("telegram", owner)).history.count, 2);
  assert.equal(await f.create().tick(time(5)), "idle");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.purpose, "recent_review");
  assert.equal(f.calls[0]?.imageOutputAllowed, false);
  assert.deepEqual(f.calls[0]?.tools, []);
  const db = openDatabase(mainPath(f.data));
  try { validateSixSchema(db); } finally { db.close(); }
});

test("a late validation failure rolls back deletions, edits, creates and cursor together", async t => {
  const f = await fixture(t);
  const a = f.knowledge.createRecent({ body: "Specification draft" });
  const b = f.knowledge.createRecent({ body: "Redundant note" });
  await f.append(["Review the specification."]);
  const proposal = { changes: [{ id: a.id, expectedRevision: 1, body: "Revised specification" }],
    deletes: [{ id: b.id, expectedRevision: 1 }],
    creates: [{ body: "Additional review", conversationState: "Pending", stateDate: "2030-02-30" }] };
  f.respond(async () => ({ text: JSON.stringify(proposal) }));
  assert.equal(await f.review.tick(time()), "failed");
  assert.equal(f.knowledge.getRecent(a.id)?.body, "Specification draft");
  assert.equal(f.knowledge.getRecent(b.id)?.revision, 1);
  assert.equal(f.knowledge.listRecent().length, 2);
  assert.equal(f.knowledge.getReviewCursor(scope), -1);
  assert.equal(await f.create().tick(time(14)), "waiting");
  f.respond(async () => ({ text: JSON.stringify({ ...proposal, creates: [{ body: "Additional review" }] }) }));
  assert.equal(await f.create().tick(time(15)), "committed");
  assert.notEqual(f.calls[0]?.operationId, f.calls[1]?.operationId);
});

test("uncertain runtime calls reuse their operation across restart and backoff", async t => {
  const f = await fixture(t);
  await f.append(["Prepare the release checklist."]);
  f.respond(async () => { throw new Error("simulated upstream interruption"); });
  assert.equal(await f.review.tick(time()), "failed");
  assert.equal(await f.create().tick(time(1)), "waiting");
  assert.equal(await f.create().tick(time(15)), "failed");
  assert.equal(f.calls[0]?.operationId, f.calls[1]?.operationId);
  assert.equal(f.knowledge.getReviewCursor(scope), -1);
});

test("invalid received proposals have a bounded retry count", async t => {
  const f = await fixture(t);
  await f.append(["Check the document format."]);
  f.respond(async () => ({ text: "invalid JSON" }));
  for (const minutes of [0, 15, 30]) assert.equal(await f.create().tick(time(minutes)), "failed");
  assert.equal(await f.create().tick(time(45)), "proposal_blocked");
  assert.equal(f.calls.length, 3);
  assert.equal(new Set(f.calls.map(call => call.operationId)).size, 3);
  assert.equal(f.knowledge.getReviewCursor(scope), -1);
});

test("shared Telegram and WeChat history is reviewed once under the canonical owner key", async t => {
  const f = await fixture(t);
  await f.sessions.bindOwnerSession(owner, "fixture-route");
  await f.append(["Document A needs a table."]);
  await f.append(["Use two columns for that table."], "wechat", "fixture-route");
  assert.equal(await f.review.tick(time()), "committed");
  const input = JSON.parse(f.calls[0]!.text!);
  assert.deepEqual(input.messages.map((item: any) => item.seq), [0, 1]);
  assert.equal(input.messages[1].content, "Use two columns for that table.");
  assert.equal(f.knowledge.getReviewCursor(scope), 1);
  assert.equal(f.sessions.sessionKey("wechat", "fixture-route"), "telegram:" + owner);
  assert.equal(await f.create().tick(time(5)), "idle");
});

test("bounded batches advance only over complete message content", async t => {
  const f = await fixture(t);
  await f.append(Array.from({ length: 41 }, (_, i) => "Checklist item " + i));
  assert.equal(await f.review.tick(time()), "committed");
  assert.equal(f.knowledge.getReviewCursor(scope), 39);
  assert.equal(await f.create().tick(time(5)), "committed");
  assert.equal(f.knowledge.getReviewCursor(scope), 40);
  assert.equal(JSON.parse(f.calls[1]!.text!).messages[0].seq, 40);
  await f.append(["x".repeat(24_001)]);
  assert.equal(await f.review.tick(time(10)), "failed");
  assert.equal(f.knowledge.getReviewCursor(scope), 40);
  assert.equal(f.calls.length, 2);
});

test("provider background opt-out and empty transcripts never advance review", async t => {
  const f = await fixture(t);
  assert.equal(await f.review.tick(time()), "idle");
  assert.equal(f.calls.length, 0);
  await f.append(["Verify the sample output."]);
  f.respond(async () => ({ text: "SILENT", skipped: "background_disabled" }));
  assert.equal(await f.review.tick(time()), "background_disabled");
  assert.equal(f.knowledge.getReviewCursor(scope), -1);
  const db = openDatabase(mainPath(f.data));
  try { assert.equal(JSON.parse(getState(db, "runtime/recent-review")!.value).status, "background_disabled"); }
  finally { db.close(); }
});

test("revision changes during model evaluation cannot overwrite a newer entry", async t => {
  const f = await fixture(t);
  const row = f.knowledge.createRecent({ body: "Initial specification" });
  await f.append(["Review the latest specification."]);
  f.respond(async () => {
    f.knowledge.updateRecent({ id: row.id, expectedRevision: 1, body: "Independent update" });
    return { text: JSON.stringify({ ...empty, deletes: [{ id: row.id, expectedRevision: 1 }] }) };
  });
  assert.equal(await f.review.tick(time()), "failed");
  assert.equal(f.knowledge.getRecent(row.id)?.body, "Independent update");
  assert.equal(f.knowledge.getReviewCursor(scope), -1);
});

test("proposal parsing rejects unadvertised targets, repeated mutations and extra authority fields", () => {
  const entries = [{ id: "entry-a", revision: 1, body: "Sample task", conversationState: null, stateDate: null, eventAt: null, sourceId: null, updatedAt: "2030-01-02T09:00:00Z" }];
  for (const proposal of [
    { ...empty, creates: [{ body: "New task", sourceId: "external-identity" }] },
    { ...empty, deletes: [{ id: "not-shown", expectedRevision: 1 }] },
    { ...empty, changes: [{ id: "entry-a", expectedRevision: 1, body: "Updated task" }], deletes: [{ id: "entry-a", expectedRevision: 1 }] },
    { ...empty, core: "replacement" },
    { ...empty, creates: [{ body: null }] },
  ]) assert.throws(() => parseReview(JSON.stringify(proposal), entries));
  assert.deepEqual(parseReview("```json\n" + JSON.stringify(empty) + "\n```", entries), empty);
});

test('Recent review continues after graph integration and keeps linked ongoing topics visible',async t=>{
 const f=await fixture(t);await f.append(['Track the sample document review.']);
 const {installMemorySchema}=await import("../memory/schema.js");
 const database=openDatabase(mainPath(f.data));try{installMemorySchema(database);}finally{database.close();}
 const graph=f.sessions.enableMemory(owner);
 const {MemoryRecent}=await import('../memory/recent.js');const linked=new MemoryRecent(graph);linked.migrate();
 f.respond(async()=>({text:JSON.stringify({changes:[],creates:[{body:'Sample document review remains open'}],deletes:[]})}));
 const review=new RecentReview(f.data,owner,{reply:async request=>{f.calls.push(request);return {text:JSON.stringify({changes:[],creates:[{body:'Sample document review remains open'}],deletes:[]})};}},
  f.sessions,f.knowledge,new LocalCoreContextProvider(f.data),undefined,()=>{linked.sync();});
 assert.equal(await review.tick(time()),'committed');assert.equal(linked.enabled(),true);
 const entries=f.knowledge.listRecent();assert.equal(entries.length,1);assert.deepEqual(linked.remainingDirectory(entries),entries);
 assert.equal(await review.tick(time(2)),'idle');assert.equal(f.calls.length,1);
 assert.match(f.calls[0]!.instructions!,/事实、偏好和已结束经历交给记忆图/);
});
