import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeGateway } from "../setup.js";
import { SessionStore } from "../sessions/store.js";
import { localContext } from "../core/context-fixture.js";
import { TaskTraceStore } from "../observability/store.js";
import { HeartbeatRunner } from "./runner.js";
import { readJsonFile } from "../util/atomic-json.js";
import type { HeartbeatState } from "./policy.js";
import type { ChatResponse } from "../runtime/types.js";

const now=new Date("2026-10-25T10:00:00Z");
const config={enabled:true,planningEnabled:false,timezone:"UTC",quietStart:"01:00",quietEnd:"07:00",cooldownMinutes:60,dailyCap:8,minIntervalMinutes:60,maxIntervalMinutes:60};
async function setup(work:(context:{root:string;sessions:SessionStore;traces:TaskTraceStore})=>Promise<void>){
  const parent=await mkdtemp(join(tmpdir(),"sophon-heartbeat-trace-"));const root=join(parent,"data");
  await initializeGateway(root);const sessions=new SessionStore(root),traces=new TaskTraceStore(root);
  try {await work({root,sessions,traces});} finally {sessions.close();traces.close();await rm(parent,{recursive:true,force:true});}
}

for(const outcome of ["silent","disabled","confirmed","uncertain"] as const){
  test(`heartbeat trace distinguishes ${outcome} without changing delivery attempts`,()=>setup(async({root,sessions,traces})=>{
    let calls=0,sends=0;
    const response:ChatResponse=outcome==="silent"?{text:"SILENT"}:outcome==="disabled"?{text:"SILENT",skipped:"background_disabled"}:{text:"文档处理完成。"};
    const runtime={async reply(request:any){calls++;assert.ok(request.trace);return response;}};
    const router={async resolve(){return{channel:"telegram",target:"owner"};},async isActive(){return true;},async sendIfActive(){sends++;if(outcome==="uncertain")throw new Error("simulated network loss");return true;}};
    const runner=new HeartbeatRunner(root,config,runtime as never,sessions,{load:async()=>localContext()} as never,router as never,undefined,undefined,undefined,undefined,undefined,traces);
    await runner.tick(now);
    const summary=traces.list().runs.find(r=>r.kind==="heartbeat_decision")!;
    assert.equal(summary.status,{silent:"silent",disabled:"skipped",confirmed:"delivered",uncertain:"delivery_unknown"}[outcome]);
    assert.equal(calls,1);assert.equal(sends,["confirmed","uncertain"].includes(outcome)?1:0);
    const state=await readJsonFile<HeartbeatState>(join(root,"heartbeat/state.json"),{dateKey:"",sentToday:0,recent:[]});
    assert.equal(state.sentToday,sends);assert.equal(state.pending,undefined);
    const delivery=traces.get(summary.id)!.steps.find(s=>s.kind==="delivery");
    if(outcome==="confirmed")assert.deepEqual(delivery?.output,{acknowledged:true});
    if(outcome==="uncertain")assert.deepEqual(delivery?.output,{acknowledged:false,result:"unknown"});
    await runner.tick(new Date(now.getTime()+60_000));assert.equal(calls,1);assert.equal(sends,["confirmed","uncertain"].includes(outcome)?1:0);
  }));
}

test("scheduler gates are visible, coalesced and never invoke the model",()=>setup(async({root,sessions,traces})=>{
  const runtime={async reply(){assert.fail("quiet hours must not call provider");}};
  const runner=new HeartbeatRunner(root,{...config,planningEnabled:true},runtime as never,sessions,{load:async()=>localContext()} as never,{} as never,undefined,undefined,undefined,undefined,undefined,traces);
  await runner.tick(new Date("2026-10-25T03:00:00Z"));await runner.tick(new Date("2026-10-25T03:01:00Z"));
  const runs=traces.list().runs;assert.equal(runs.length,1);assert.equal(runs[0].status,"skipped");assert.equal(runs[0].reason,"planning_window_closed");
}));

test("planning trace includes parsed candidate times and only completes after persistence",()=>setup(async({root,sessions,traces})=>{
  const runtime={async reply(request:any){assert.ok(request.trace);assert.equal(request.purpose,"heartbeat_plan");return{text:'{"wakes":[{"time":"11:00","intent":"检查文档处理进度"}]}'};}};
  const router={async resolve(){return{channel:"telegram",target:"owner"};}};
  const runner=new HeartbeatRunner(root,{...config,planningEnabled:true},runtime as never,sessions,{load:async()=>localContext()} as never,router as never,undefined,undefined,undefined,undefined,undefined,traces);
  await runner.tick(now);
  const runs=traces.list().runs;assert.equal(runs.length,1);assert.equal(runs[0].kind,"heartbeat_plan");assert.equal(runs[0].status,"completed");
  const run=traces.get(runs[0].id)!;assert.ok(run.steps.some(s=>s.name==="解析候选计划"));
  const state=await readJsonFile<HeartbeatState>(join(root,"heartbeat/state.json"),{dateKey:"",sentToday:0,recent:[]});assert.equal(state.plan?.wakes[0].time,"11:00");
}));

test("trace storage failure cannot cause duplicate delivery or fail a normal heartbeat",()=>setup(async({root,sessions,traces})=>{
  let sends=0;
  traces.begin=()=>{throw new Error("trace disk unavailable");};
  const runtime={async reply(request:any){assert.equal(request.trace,undefined);return{text:"已完成检查。"};}};
  const router={async resolve(){return{channel:"telegram",target:"owner"};},async isActive(){return true;},async sendIfActive(){sends++;return true;}};
  const runner=new HeartbeatRunner(root,config,runtime as never,sessions,{load:async()=>localContext()} as never,router as never,undefined,undefined,undefined,undefined,undefined,traces);
  await runner.tick(now);await runner.tick(new Date(now.getTime()+60_000));assert.equal(sends,1);
}));
