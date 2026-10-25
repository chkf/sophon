import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiRuntime } from "./api.js";
import { ResponsesTransport } from "./siwc/responses-transport.js";
import { StatefulResponsesBridge } from "./siwc/stateful-responses.js";
import type { ResponseSnapshot, SocketStreamMessage, StatefulResponsesSocket } from "./siwc/stateful-types.js";
import type { RuntimeTraceObserver, TraceStepFinish, TraceStepStart } from "../observability/types.js";

function recorder(captureContent = true) {
  const starts: Array<TraceStepStart & {id: string}> = [];
  const finishes = new Map<string, TraceStepFinish>();
  const observer: RuntimeTraceObserver = {
    captureContent,
    start(event) { const id = "step-" + starts.length; starts.push(structuredClone({...event,id})); return id; },
    finish(id, event) { if(id) finishes.set(id, structuredClone(event)); },
  };
  return { observer, starts, finishes };
}

async function temporary(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sophon-provider-trace-"));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("API trace follows actual model/tool rounds, preserves missing usage and excludes hidden reasoning", () => temporary(async root => {
  const trace=recorder();let requests=0,executions=0;
  const replies=[
    { choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,
      reasoning:"hidden-reasoning-value",reasoning_details:[{text:"hidden-detail-value"}],
      tool_calls:[{id:"call-1",type:"function",function:{name:"read_document",arguments:'{"id":"sample"}'}}]}}],
      usage:{prompt_tokens:12,completion_tokens:4}},
    {choices:[{finish_reason:"stop",message:{role:"assistant",content:"Document checked."}}]},
  ];
  const runtime=new ApiRuntime({dataDir:root,baseUrl:"https://fixture.example/v1",apiKey:"fixture-credential",defaultModel:"fixture-model",stream:false,heartbeat:true,
    fetch:async()=>{requests++;return new Response(JSON.stringify(replies.shift()),{headers:{"content-type":"application/json"}});}});
  const request={purpose:"heartbeat_decision" as const,sessionId:"heartbeat",operationId:"trace-fixture",text:"Check a document.",trace:trace.observer,
    tools:[{name:"read_document",parameters:{type:"object"},readOnly:true}],
    executeTool:async()=>{executions++;return {text:"Document content."};}};
  try {
    assert.equal((await runtime.reply(request)).text,"Document checked.");
    assert.equal(requests,2);assert.equal(executions,1);
    assert.deepEqual(trace.starts.map(s=>s.kind),["model","tool","model"]);
    assert.equal(trace.starts[1].parentId,trace.starts[0].id);
    assert.deepEqual(trace.finishes.get(trace.starts[0].id)?.usage,{inputTokens:12,outputTokens:4});
    assert.equal(trace.finishes.get(trace.starts[2].id)?.usage,undefined,"missing usage is not zero");
    const serialized=JSON.stringify([trace.starts,[...trace.finishes]]);
    assert.doesNotMatch(serialized,/hidden-reasoning-value|hidden-detail-value|fixture-credential/);
    assert.match(serialized,/Document content/);
    await runtime.reply(request);
    assert.equal(requests,2);assert.equal(trace.starts.length,3,"journal replay is not a new model call");
  } finally { await runtime.close(); }
}));

test("observer failures do not change a completed API call or trigger another request", () => temporary(async root => {
  let requests=0;
  const runtime=new ApiRuntime({dataDir:root,baseUrl:"https://fixture.example/v1",defaultModel:"fixture-model",stream:false,heartbeat:true,
    fetch:async()=>{requests++;return new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{role:"assistant",content:"SILENT"}}]}));}});
  try {
    const result=await runtime.reply({purpose:"heartbeat_decision",sessionId:"heartbeat",operationId:"observer-failure",text:"Check.",
      trace:{start(){throw new Error("recorder unavailable");},finish(){throw new Error("recorder unavailable");}}});
    assert.equal(result.text,"SILENT");assert.equal(requests,1);
  } finally { await runtime.close(); }
}));

class Socket implements StatefulResponsesSocket {
  sent: Record<string,unknown>[]=[];
  current?: ResponseSnapshot | Error;
  constructor(private readonly replies:Array<ResponseSnapshot|Error>) {}
  send(event:Record<string,unknown>) {this.sent.push(event);this.current=this.replies.shift();}
  async *stream():AsyncIterable<SocketStreamMessage> {
    if(this.current instanceof Error){yield {type:"error",error:this.current};return;}
    yield {type:"message",message:{type:"response.completed",response:this.current}};
  }
  close() {}
  onClose() {}
}
const response=(id:string,text:string):ResponseSnapshot=>({id,output:[{type:"message",role:"assistant",content:[{type:"output_text",text}]}]});

test("SIWC transport records each actual retry and does not expose encrypted reasoning",async()=>{
  const trace=recorder();
  const retry=Object.assign(new Error("Service temporarily unavailable"),{status:503,code:"server_error"});
  const final=response("complete","SILENT");
  final.output!.unshift({type:"reasoning",encrypted_content:"opaque-secret",summary:[{text:"hidden summary"}]});
  final.usage={input_tokens:20,output_tokens:2};
  const socket=new Socket([retry,final]);
  const result=await new ResponsesTransport(1000,async()=>{}).completedResponseWithRetry(socket,
    {type:"response.create",model:"fixture-model",input:[{type:"reasoning",encrypted_content:"prior-opaque-secret"},{role:"user",content:"Check."}]},trace.observer);
  assert.equal(result.retries,1);assert.equal(socket.sent.length,2);assert.equal(trace.starts.length,2);
  assert.deepEqual([...trace.finishes.values()].map(s=>s.status),["failed","completed"]);
  assert.equal(result.traceStepId,trace.starts[1].id);
  assert.deepEqual(trace.finishes.get(result.traceStepId!)?.usage,{inputTokens:20,outputTokens:2});
  assert.doesNotMatch(JSON.stringify([trace.starts,[...trace.finishes]]),/opaque-secret|hidden summary/);
});

test("SIWC local tools link to the model round that requested them",()=>temporary(async root=>{
  const trace=recorder();
  const socket=new Socket([{id:"tool",output:[{type:"function_call",call_id:"call-1",name:"read_document",arguments:'{"id":"sample"}'}]},response("final","Done.")]);
  const bridge=new StatefulResponsesBridge(root,()=>socket);
  let executions=0;
  try {
    const result=await bridge.reply({accessToken:"fixture-access-token",model:"fixture-model",sessionId:"background-fixture",messages:[{role:"user",content:"Read a document."}],
      trace:trace.observer,tools:[{name:"read_document",parameters:{type:"object"},readOnly:true}],
      executeTool:async()=>{executions++;return {text:"Sample document."};}});
    assert.equal(result.text,"Done.");assert.equal(executions,1);
    assert.deepEqual(trace.starts.map(s=>s.kind),["model","tool","model"]);
    assert.equal(trace.starts[1].parentId,trace.starts[0].id);
    assert.equal(trace.finishes.get(trace.starts[1].id)?.status,"completed");
    assert.doesNotMatch(JSON.stringify(trace.starts),/fixture-access-token/);
  } finally {await bridge.close();}
}));

test("metadata-only observers receive actual usage without model or local tool payloads",()=>temporary(async root=>{
  const trace=recorder(false);
  let requests=0;
  const runtime=new ApiRuntime({dataDir:root,baseUrl:"https://fixture.example/v1",defaultModel:"fixture-model",stream:false,heartbeat:true,
    fetch:async()=>new Response(JSON.stringify(++requests===1
      ? {choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:"call-1",type:"function",function:{name:"read_document",arguments:'{"id":"private-document"}'}}]}}],usage:{prompt_tokens:10,completion_tokens:2}}
      : {choices:[{finish_reason:"stop",message:{role:"assistant",content:"Private document checked."}}],usage:{prompt_tokens:12,completion_tokens:3}}))});
  const tool={name:"read_document",parameters:{type:"object"},readOnly:true};
  const executeTool=async()=>({text:"Private document body."});
  const socket=new Socket([{id:"tool",output:[{type:"function_call",call_id:"call-1",name:"read_document",arguments:'{"id":"private-document"}'}]},response("done","Private document checked.")]);
  const bridge=new StatefulResponsesBridge(root,()=>socket);
  try {
    await runtime.reply({purpose:"heartbeat_decision",sessionId:"heartbeat",operationId:"metadata-only",text:"Private request.",instructions:"Private policy.",trace:trace.observer,tools:[tool],executeTool});
    await bridge.reply({accessToken:"fixture-token",model:"fixture-model",sessionId:"metadata-fixture",messages:[{role:"user",content:"Private request."}],instructions:"Private policy.",trace:trace.observer,tools:[tool],executeTool});
    assert.equal(requests,2);assert.equal(socket.sent.length,2);
    assert.deepEqual(trace.starts.map(s=>s.kind),["model","tool","model","model","tool","model"]);
    assert.ok(trace.starts.every(s=>s.input===undefined));
    assert.ok([...trace.finishes.values()].every(s=>s.output===undefined));
    assert.deepEqual(trace.finishes.get(trace.starts[0].id)?.usage,{inputTokens:10,outputTokens:2});
    assert.doesNotMatch(JSON.stringify([trace.starts,[...trace.finishes]]),/Private|private-document|fixture-token/);
  } finally {await runtime.close();await bridge.close();}
}));

test("visible trace projection is bounded for cycles, deep structures and large protocol fields",async()=>{
  const {traceContent}=await import("./trace-content.js");
  const cyclic:Record<string,unknown>={type:"message",content:"visible"};cyclic.output=cyclic;
  const deep:Record<string,unknown>={type:"message"};let cursor=deep;
  for(let i=0;i<20_000;i++){const next:Record<string,unknown>={};cursor.content=next;cursor=next;}
  const longText="合成测试内容".repeat(20_000);
  const input=[cyclic,deep,{type:"message",content:Array.from({length:20_000},()=>({type:"output_text",text:longText}))}];
  const projected=traceContent(input);
  const serialized=JSON.stringify(projected);
  assert.match(serialized,/visible/);assert.match(serialized,/trace projection truncated/);
  assert.ok(Buffer.byteLength(serialized)<64*1024,"projection stays bounded before a recorder sees it");
  const hostile=Object.defineProperty({},"content",{get(){throw new Error("must not escape projection");}});
  assert.doesNotThrow(()=>traceContent(hostile));
  assert.match(JSON.stringify(traceContent(hostile)),/projection unavailable/);
});

test("malformed deep response metadata cannot fail a successful SIWC transport or reach a metadata-only observer",async()=>{
  const normal=response("complete","Completed.");
  const visible=normal.output![0] as Record<string,unknown>;
  const cyclic:Record<string,unknown>={text:"protocol metadata"};cyclic.annotations=cyclic;
  visible.annotations=[cyclic];
  for(const captureContent of [true,false]){
    const trace=recorder(captureContent),socket=new Socket([normal]);
    const result=await new ResponsesTransport(1000,async()=>{}).completedResponseWithRetry(socket,
      {type:"response.create",model:"fixture-model",input:[{role:"user",content:"Check a document."}]},trace.observer);
    assert.equal(result.response.id,"complete");assert.equal(socket.sent.length,1);
    assert.equal((result.response.output![0] as Record<string,unknown>).annotations,visible.annotations,"projection must not rewrite provider output");
    assert.equal(trace.finishes.get(trace.starts[0].id)?.status,"completed");
    if(captureContent)assert.match(JSON.stringify([...trace.finishes]),/trace projection truncated/);
    else {assert.equal(trace.starts[0].input,undefined);assert.equal(trace.finishes.get(trace.starts[0].id)?.output,undefined);}
  }
});
