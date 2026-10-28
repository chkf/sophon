import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeGateway } from "../setup.js";
import { mainPath, openDatabase } from "../state/database.js";
import { validateSixSchema } from "../state/schema.js";
import { TaskTraceStore, sanitizeTrace } from "./store.js";

async function fixture(work:(root:string)=>Promise<void>) {
  const parent=await mkdtemp(join(tmpdir(),"sophon-trace-"));
  const root=join(parent,"data");
  try {await initializeGateway(root);await work(root);} finally {await rm(parent,{recursive:true,force:true});}
}

test("task traces retain actual steps and unknown usage without altering the six-table schema",()=>fixture(async root=>{
  const store=new TaskTraceStore(root);
  try {
    const id=store.begin({kind:"heartbeat_decision",trigger:"scheduled_check"});
    const observer=store.observer(id);
    const model=observer.start({kind:"model",name:"request",provider:"api",input:{messages:[{role:"user",content:"检查任务"}]}});
    observer.finish(model,{status:"completed",output:{tool_calls:[{name:"read_history"}]},usage:{inputTokens:12}});
    const tool=observer.start({kind:"tool",name:"read_history",parentId:model,input:{query:"文档"}});
    observer.finish(tool,{status:"completed",output:{matches:1}});
    store.finish(id,{status:"silent",reason:"model_returned_silent"});
    const run=store.get(id)!;
    assert.equal(run.status,"silent");assert.equal(run.steps[1].parentId,run.steps[0].id);
    assert.deepEqual(run.usage,{inputTokens:12});assert.equal(run.steps[0].usage?.cachedInputTokens,undefined);
    assert.equal(store.list().runs[0].stepCount,2);assert.equal("steps" in store.list().runs[0],false);
    const db=openDatabase(mainPath(root));try {validateSixSchema(db);} finally {db.close();}
  } finally {store.close();}
}));

test("trace redaction happens before persistence and excludes opaque reasoning, secrets and binary payloads",()=>fixture(async root=>{
  const secret="fixture-only-sensitive-secret";
  const store=new TaskTraceStore(root,{secrets:[secret]});
  try {
    const id=store.begin({kind:"heartbeat_plan",trigger:"daily_plan"});
    const step=store.start(id,{kind:"model",name:"request",input:{authorization:"Bearer abc.def.ghi",api_key:secret,encrypted_content:"opaque_fixture",reasoning:"hidden_fixture",messages:[{content:"token="+secret}],image:"data:image/png;base64,AAAA"}});
    store.finishStep(id,step,{status:"failed",error:"request failed "+secret});
    store.finish(id,{status:"failed"});
    const db=openDatabase(mainPath(root),true);
    try {
      const raw=String((db.prepare("SELECT value FROM gateway_state WHERE key=?").get("observability/tasks/"+id) as {value:string}).value);
      for(const value of [secret,"opaque_fixture","hidden_fixture","abc.def.ghi","base64,AAAA"])assert.equal(raw.includes(value),false,value);
      assert.match(raw,/redacted/);
    } finally {db.close();}
  } finally {store.close();}
}));

test("unfinished model and delivery attempts are visibly interrupted after restart",()=>fixture(async root=>{
  let store=new TaskTraceStore(root);
  const a=store.begin({kind:"heartbeat_plan",trigger:"daily_plan"});store.start(a,{kind:"model",name:"pending model"});
  const b=store.begin({kind:"heartbeat_decision",trigger:"scheduled_check"});store.start(b,{kind:"delivery",name:"pending send"});
  store.close();store=new TaskTraceStore(root);
  assert.equal(store.get(a)?.status,"running","opening read view must not reconcile another owner");
  store.recoverInterrupted();
  try {
    assert.equal(store.get(a)?.status,"interrupted");assert.equal(store.get(a)?.steps[0].status,"interrupted");
    assert.equal(store.get(b)?.status,"delivery_unknown");
    assert.equal(store.get(b)?.reason,"process_interrupted");
  } finally {store.close();}
}));

test("trace retention, page cursors and payload bounds are enforced",()=>fixture(async root=>{
  const store=new TaskTraceStore(root,{maxRuns:10});
  try {
    for(let i=0;i<12;i++) {const id=store.begin({kind:"heartbeat_check",trigger:"scheduler_gate"});store.finish(id,{status:"skipped",reason:"cooldown"});await new Promise(r=>setTimeout(r,2));}
    const first=store.list({limit:4});assert.equal(first.runs.length,4);assert.ok(first.nextBefore);
    const second=store.list({limit:10,before:first.nextBefore!});assert.equal(second.runs.length,6);
    assert.equal(new Set([...first.runs,...second.runs].map(r=>r.id)).size,10);
    assert.throws(()=>store.list({before:"../escape"}));assert.equal(store.get("../escape"),undefined);
    const id=store.begin({kind:"heartbeat_decision",trigger:"scheduled_check"});
    for(let i=0;i<100;i++){const step=store.start(id,{kind:"tool",name:"read",input:{content:"内容".repeat(10000)}});store.finishStep(id,step,{status:"completed",output:{content:"结果".repeat(10000)}});}
    const run=store.get(id)!;assert.equal(run.steps.length,80);assert.equal(run.droppedSteps,20);assert.equal(run.truncated,true);
    assert.ok(Buffer.byteLength(JSON.stringify(run))<=512*1024);
  } finally {store.close();}
}));

test("sanitizeTrace handles cycles and keeps plain numeric task data",()=>{
  const cyclic:{value:number;self?:unknown}={value:3};cyclic.self=cyclic;
  assert.equal(sanitizeTrace(cyclic).truncated,true);
  assert.deepEqual(sanitizeTrace({inputTokens:42,cache:0}).value,{inputTokens:42,cache:0});
});

test("metadata stays bounded text and partial usage remains distinguishable",()=>fixture(async root=>{
  const store=new TaskTraceStore(root);
  try {
    const id=store.begin({kind:"heartbeat_decision",trigger:"触发".repeat(10000)});
    const first=store.start(id,{kind:"model",name:"请求".repeat(10000)});
    store.finishStep(id,first,{status:"completed",usage:{inputTokens:10}});
    store.start(id,{kind:"model",name:"second model"});
    store.finish(id,{status:"failed",reason:"原因".repeat(10000)});
    const run=store.get(id)!;
    assert.equal(typeof run.trigger,"string");assert.ok(run.trigger.length<=120);
    assert.equal(typeof run.reason,"string");assert.ok(run.reason!.length<=512);
    assert.equal(run.steps[1].status,"interrupted");
    assert.equal(run.modelStepCount,2);assert.equal(run.usageReportedModelSteps,1);
    assert.deepEqual(run.usage,{inputTokens:10});assert.deepEqual(run.usageCompleteFields,[]);
  } finally {store.close();}
}));
