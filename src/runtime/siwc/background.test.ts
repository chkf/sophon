import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SiwcRuntime } from "./index.js";
import type { SiwcClient, CredentialEncryptionAdapter } from "./sdk.js";

test("heartbeat plan and decision use authenticated WS lanes, never direct HTTP, then dispose their state", async () => {
  const root = await mkdtemp(join(tmpdir(), "siwc-background-"));
  try {
    const storage = join(root, "chatgpt");
    await mkdir(storage, { recursive: true });
    const tokenState = { version:2, activeProfileId:"fixture", profiles:[{
      id:"fixture", status:"connected", scopes:["chatgpt.tokens.use.direct"],
      credentials:{accessToken:"test-token", expiresAt:Date.now()+3600000},
    }]};
    await writeFile(join(storage,"chatgpt-auth.json"), JSON.stringify({
      version:3,provider:"test",ciphertext:Buffer.from(JSON.stringify(tokenState)).toString("base64"),
    }));
    const encryption = {
      id:"test",
      isAvailable:()=>true,
      encrypt:(s:string)=>Buffer.from(s),
      decrypt:(bytes:Uint8Array)=>Buffer.from(bytes).toString("utf8"),
    } satisfies CredentialEncryptionAdapter;
    const client = {
      signIn:async()=>({status:"connected" as const,sharing:true}),
      getSession:async()=>({status:"connected" as const,sharing:true}),
      listModels:async()=>[{slug:"test-model",displayName:"Test Model"}],
      streamResponse:async()=>{assert.fail("background must not reach generic SIWC streamResponse");return {text:""};},
    } satisfies SiwcClient;
    const runtime = new SiwcRuntime(client,storage,root,encryption,"test-model");
    const calls:{sessionId:string;instructions?:string;accessToken:string;tools?:unknown[]}[]=[];
    const disposed:string[]=[];
    let failNext=false;
    Object.assign(runtime,{statefulResponses:{
      reply:async (value:any)=>{
        assert.equal(value.getPreparedVoice?.(),"fixture voice");
        calls.push({sessionId:value.sessionId,instructions:value.instructions,accessToken:value.accessToken,tools:value.tools});
        if(failNext)throw new Error("fixture network failure");
        return {text:'{"wakes":[]}',usage:{inputTokens:10,cachedInputTokens:0,outputTokens:3},compacted:false};
      },
      resetSession:async(id:string)=>{disposed.push(id);},
      close:async()=>{},
    }});
    const base = {
      sessionId:"heartbeat-planner",purpose:"heartbeat_plan" as const,
      text:"请制定今天的计划",instructions:"今日实时计划",
      tools:[{name:"today_schedule",readOnly:true,parameters:{type:"object",properties:{}}}],
      executeTool:async()=>({results:[]}),
      getPreparedVoice:()=>"fixture voice",
    };
    const a = await runtime.reply(base);
    assert.equal(a.text,'{"wakes":[]}');
    await runtime.reply({...base,purpose:"heartbeat_decision",sessionId:"heartbeat",text:"是否打扰？"});
    assert.equal(calls.length,2);
    assert.ok(calls[0]!.sessionId.startsWith("background:"));
    assert.notEqual(calls[0]!.sessionId,calls[1]!.sessionId);
    assert.deepEqual(calls.map(x=>x.accessToken),["test-token","test-token"]);
    assert.deepEqual(calls.map(x=>x.instructions),["今日实时计划","今日实时计划"]);
    assert.equal(calls[0]!.tools?.length,1);
    assert.deepEqual(disposed,calls.map(x=>x.sessionId));
    failNext=true;
    await assert.rejects(runtime.reply(base),/fixture network failure/);
    assert.equal(disposed[2],calls[2]?.sessionId,"failed background attempts must release state");
  } finally {await rm(root,{recursive:true,force:true});}
});
