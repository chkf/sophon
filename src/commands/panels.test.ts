import { seedPersonaDatabase } from "../../scripts/testing/expression-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramPanels, type PanelView } from "../channels/telegram/panels.js";
import { TelegramAdapter } from "../channels/telegram/adapter.js";
import { creditSummary } from "./credits.js";
import { readLogEvents } from "./host-logs.js";
import { DiagnosticRegistry } from "./diagnostics.js";
import { CommandPanels } from "./panels.js";
import { GatewayCommandRouter } from "./router.js";
import { ExpressionStore } from "../expression/store.js";

async function temp(fn:(dir:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),"command-panels-"));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
const message=(text:string)=>({channel:"telegram" as const,conversationId:"1",senderId:"1",messageId:"1",text,attachments:[]});
const click=(v:PanelView,label:string)=>v.rows.flat().find(b=>b.text.includes(label))!.run!();

test("public commands direct configuration to authenticated panels and do not launch host scripts",async()=>{
  const router=new GatewayCommandRouter({} as any,{} as any);
  for(const command of ["/model 2","/expression formal","/proactive wechat","/test runtime:test","/logs all"])
    assert.match((await router.handle(message(command)))!,/面板/);
  assert.match((await router.handle(message("npm run test")))!,/诊断面板/);
  assert.match((await router.handle(message("/update")))!,/不提供远程自动更新/);
});

test("credit query distinguishes account balance, no key limit and failure; never leaks credentials",async()=>{
  const requests:string[]=[];
  const fetcher=async(url:any)=>{requests.push(String(url));return new Response(JSON.stringify({data:String(url).endsWith("credits")?{total_credits:10,total_usage:4}:{usage:2,limit_remaining:null}}));};
  const result=await creditSummary("secret","management",fetcher as any);
  assert.match(result,/账户余额：\$6.0000/);assert.match(result,/未设限额/);assert.match(result,/Key 累计用量：\$2/);assert.equal(requests.length,2);
  const fail=await creditSummary("secret",undefined,(async()=>{throw Error("secret");}) as any);
  assert.match(fail,/暂时不可用/);assert.doesNotMatch(fail,/secret/);
});

test("recent gateway logs exclude old, undated, unrelated files and normal exits",()=>temp(async dir=>{
  const now=Date.parse("2026-10-21T12:00:00Z");
  await writeFile(join(dir,"gateway.log"),[
    "legacy error without a timestamp","2026-10-20T11:00:00Z error timeout","2026-10-21T11:50:00Z error timeout",
    "2026-10-21T11:51:00Z error timeout","2026-10-21T11:52:00Z exited code=0","2026-10-21T11:53:00Z failed OPENROUTER_API_KEY=secret"
  ].join("\n"));
  await writeFile(join(dir,"unrelated.log"),"2026-10-21T11:54:00Z error timeout\n");
  const logs=await readLogEvents(dir,{now});assert.equal(logs.length,2);
  assert.equal(logs.find(x=>x.source==="gateway"&&x.text.includes("timeout"))!.count,2);
  assert.doesNotMatch(JSON.stringify(logs),/secret|legacy|code=0|2026-10-20/);
  assert.deepEqual(await readLogEvents(dir,{now:now+3600000}),[]);
  assert.equal((await readLogEvents(dir,{now,source:"gateway"})).length,2);
}));

test("panel callback authorization, token expiry, private binding and single use",async()=>{
  const calls:any[]=[];let changes=0;
  const api:any={call:async(method:string,body:any)=>{calls.push({method,body});return {message_id:99};}};
  const ui=new TelegramPanels(api,"1",async()=>{});
  const view:PanelView={text:"select",rows:[[{text:"switch",run:async()=>{changes++;return {text:"done",rows:[]};}}]]};
  await ui.open("1",view);
  const data=calls.find(c=>c.method==="editMessageText").body.reply_markup.inline_keyboard[0][0].callback_data;
  const query={id:"q",from:{id:1},message:{message_id:99,date:1,chat:{id:1,type:"private"}},data};
  await ui.callback({...query,from:{id:2}});assert.equal(changes,0);
  await ui.callback({...query,message:{...query.message,chat:{id:1,type:"group"}}});assert.equal(changes,0);
  await ui.callback(query);assert.equal(changes,1);
  await ui.callback(query);assert.equal(changes,1);
  const expired=new TelegramPanels(api,"1",async()=>{});await expired.callback(query);assert.equal(changes,1);
});

test("expired panels delete silently; stale render clicks and strangers cannot delete live panels",async t=>{
  let now=1000;t.mock.method(Date,"now",()=>now);
  const calls:any[]=[];const deadlines:(number|undefined)[]=[];
  const api:any={call:async(method:string,body:any)=>{calls.push({method,body});return {message_id:99};}};
  const ui=new TelegramPanels(api,"1",async(_chat,_ids,duration)=>{deadlines.push(duration);});
  await ui.open("1",{text:"select",rows:[[{text:"next",run:async()=>({text:"new",rows:[]})}]]});
  const data=calls.find(c=>c.method==="editMessageText").body.reply_markup.inline_keyboard[0][0].callback_data;
  const query={id:"q",from:{id:1},message:{message_id:99,date:1,chat:{id:1,type:"private"}},data};
  await ui.callback(query);await ui.callback(query);
  assert.equal(calls.filter(c=>c.method==="deleteMessage").length,0);
  assert.deepEqual(deadlines,[86400000,86400000]);
  now+=86400001;
  await ui.callback({...query,from:{id:2}});
  assert.equal(calls.filter(c=>c.method==="deleteMessage").length,0);
  await ui.callback(query);
  assert.equal(calls.filter(c=>c.method==="deleteMessage").length,1);
  assert.ok(!calls.some(c=>String(c.body.text).includes("过期")));
  const restarted=new TelegramPanels(api,"1",async()=>{});
  await restarted.callback(query);
  assert.equal(calls.filter(c=>c.method==="deleteMessage").length,2);
  await restarted.callback({...query,data:"voice:other"});
  assert.equal(calls.filter(c=>c.method==="deleteMessage").length,2);
});

test("panel deadlines refresh once, survive restart, and remove in-memory actions",()=>temp(async dir=>{
  const calls:any[]=[];
  const api:any={call:async(method:string,body:any)=>{calls.push({method,body});return {message_id:99};}};
  const config={token:"test",ownerId:"1",dataDir:dir,mediaStore:{} as any,api};
  const first:any=new TelegramAdapter(config);
  await first.panels.open("1",{text:"panel",rows:[]});
  assert.equal(first.state.commandReplyDeletions.length,1);
  assert.ok(first.state.commandReplyDeletions[0].expiresAtMs>Date.now()+86300000);
  await first.scheduleCommandReplyDeletion("1",[99],0);
  assert.equal(first.state.commandReplyDeletions.length,1);
  // Simulate shutdown before the timer fires, then load durable state.
  await first.stop();
  const second:any=new TelegramAdapter(config);
  second.state=await second.store.load();
  second.panels=first.panels;
  second.resumeCommandReplyDeletions();
  await new Promise(r=>setTimeout(r,40));
  assert.equal(calls.filter(c=>c.method==="deleteMessage").length,1);
  assert.equal(second.panels.panels.size,0);
  assert.equal(second.state.commandReplyDeletions,undefined);
  await second.stop();
}));

test("persona input requires explicit reply, can be cancelled and stays out of ordinary chat",async()=>{
  const calls:any[]=[];let inputs=0;
  const api:any={call:async(method:string,body:any)=>{calls.push({method,body});return {message_id:99};}};
  const ui=new TelegramPanels(api,"1",async()=>{});
  await ui.open("1",{text:"reply here",rows:[[{text:"取消",run:async()=>({text:"cancelled",rows:[]})}]],input:async()=>{inputs++;return {text:"saved",rows:[]};}});
  assert.equal(await ui.input({message_id:100,date:1,text:"normal",chat:{id:1,type:"private"}}),false);
  const data=calls.find(c=>c.method==="editMessageText").body.reply_markup.inline_keyboard[0][0].callback_data;
  const m={message_id:99,date:1,chat:{id:1,type:"private"}};
  await ui.callback({id:"q",from:{id:1},message:m,data});
  assert.equal(await ui.input({message_id:101,date:1,text:"late",chat:m.chat,reply_to_message:m}),false);assert.equal(inputs,0);
});

test("diagnostics launch in background, cancellation waits for worker, and one task at a time",async()=>{
  let finish!:(s:string)=>void;const pending=new Promise<string>(r=>{finish=r;});let signal!:AbortSignal;
  const item={id:"x",group:"g",label:"test",description:"test",cancellable:true,run:async(s:AbortSignal)=>{signal=s;return pending;}};
  const registry=new DiagnosticRegistry([item]);const back=()=>registry.menu();
  const running=await registry.launch(item,back);assert.match(running.text,/正在运行/);
  assert.match((await registry.launch(item,back)).text,/已有诊断/);
  await click(running,"停止");assert.equal(signal.aborted,true);
  assert.match((await registry.launch(item,back)).text,/已有诊断/);
  finish("exit");assert.match((await running.follow!).text,/已停止/);
});

test("model buttons bind selection to provider and credits only queried on OpenRouter switch",()=>temp(async dir=>{
  let provider="siwc",chosen="a",credits=0;let route="provider";
  const runtime:any={getProvider:async()=>provider,getModelSelection:async()=>({model:chosen}),listModels:async()=>[{id:"a",displayName:"A"},{id:"b",displayName:"B"}],selectModel:async(id:string,expected:string)=>{assert.equal(provider,expected);chosen=id;},
    selectProvider:async(p:string)=>{provider=p;},getImageSettings:async()=>({model:"image",route,proactive:false,dailyLimit:10}),selectImageRoute:async(r:string)=>{route=r;}};
  const panel= new CommandPanels(runtime, {} as any, new ExpressionStore(dir), new DiagnosticRegistry([]), dir, "Asia/Shanghai", async()=>{credits++;return "credit";});
  const root=await panel.model();assert.equal(credits,0);
  const models=await click(root,"聊天模型");await click(models,"B");assert.equal(chosen,"b");
  const providers=await click(await panel.model(),"Provider");const confirm=await click(providers,"openrouter");assert.equal(provider,"siwc");assert.equal(credits,0);await click(confirm,"确认切换");assert.equal(credits,1);
  const images=await panel.images();await click(images,"独立 OpenRouter");assert.equal(route,"openrouter");assert.equal(provider,"openrouter");
}));

test("generic API panels confirm paid selections and never query OpenRouter features or credits",()=>temp(async dir=>{
  let provider="siwc",chosen="custom/a",diagnosticCalls=0;
  const runtime:any={getProvider:async()=>provider,getModelSelection:async()=>({model:chosen}),listModels:async()=>[{id:"custom/a",displayName:"Custom A"},{id:"custom/b",displayName:"Custom B"}],
    selectProvider:async(p:string)=>{provider=p;},selectModel:async(id:string,expected:string)=>{assert.equal(expected,"api");chosen=id;},
    getImageSettings:async()=>assert.fail("API views must not query image routes"),
    diagnosticModels:async(p:string)=>{assert.equal(p,"api");return [{id:chosen,displayName:chosen}];},
    diagnosticReply:async(p:string,model:string,kind:string)=>{assert.equal(p,"api");assert.equal(model,"custom/b");assert.equal(kind,"text");diagnosticCalls++;return "ok";}};
  const panel=new CommandPanels(runtime,{} as any,new ExpressionStore(dir),new DiagnosticRegistry([]),dir,"UTC",async()=>assert.fail("API must not query OpenRouter credits"));
  const choice=await click(await panel.providers(),"通用 API");assert.equal(provider,"siwc");assert.match(choice.text,/可能产生费用/);
  await click(choice,"确认切换");assert.equal(provider,"api");
  assert.match((await panel.model()).text,/Provider：通用 API/);
  assert.match((await panel.model()).text,/连接未验证/);
  const modelChoice=await click(await panel.models(),"Custom B");assert.equal(chosen,"custom/a");
  await click(modelChoice,"确认选择");assert.equal(chosen,"custom/b");
  const images=await panel.images();assert.match(images.text,/不支持生图或内置联网搜索/);assert.equal(images.rows.flat().length,1);
  const diagnosticModels=await click(await panel.diagnosticProviders(),"通用 API");assert.ok(!diagnosticModels.rows.flat().some(b=>b.text.includes("生图测试")));
  const unsupported=await panel.diagnosticRun("api","custom/b","image");assert.match(unsupported.text,/不支持/);assert.equal(diagnosticCalls,0);
  const diagnostic=await panel.diagnosticRun("api","custom/b","text");assert.match(diagnostic.text,/可能产生费用/);assert.equal(diagnosticCalls,0);
  const running=await click(diagnostic,"运行测试");await running.follow;assert.equal(diagnosticCalls,1);
}));

test("retry response expires and persisted pause notices clear on resume",()=>temp(async dir=>{
  let id=100;const calls:any[]=[];
  const api:any={call:async(method:string,body:any)=>{calls.push({method,body});return {message_id:++id};}};
  const adapter:any=new TelegramAdapter({token:"test",ownerId:"1",dataDir:dir,mediaStore:{} as any,api,commandReplyAutoDeleteMs:10});
  adapter.handler=async()=>undefined;
  adapter.state.inFlight={chatId:"1",senderId:"1",lastReceivedAtMs:1,parts:[],retryPaused:true};
  await adapter.sendPauseNotice("1","paused");const notice=adapter.state.pauseNotices[0].messageId;
  await adapter.processUpdate({update_id:1,message:{message_id:1,date:1,text:"/retry",from:{id:1},chat:{id:1,type:"private"}}});
  assert.ok(calls.some(c=>c.method==="deleteMessage"&&c.body.message_id===notice));
  assert.equal(adapter.state.inFlight.retryPaused,false);
  const state=JSON.parse(await readFile(join(dir,"channels","telegram.json"),"utf8"));assert.equal(state.commandReplyDeletions.length,1);
  const reply=state.commandReplyDeletions[0].messageIds[0];
  await new Promise(r=>setTimeout(r,35));assert.ok(calls.some(c=>c.method==="deleteMessage"&&c.body.message_id===reply));
  await adapter.stop();
}));
