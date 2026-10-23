import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderRuntime } from "../runtime/providers.js";
import { HeartbeatRunner } from "./runner.js";
import { localContext } from "../core/context-fixture.js";

test("heartbeat consumes an attempted proactive send before delivery and never retries an uncertain send", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-heartbeat-"));
  try {
    let runtimeCalls = 0;
    const runtime = {
      async reply(request: any) {
        assert.ok(request.instructions.includes("测试专用本地 Core"));
        assert.ok(request.instructions.includes("本地 Core"));
        assert.ok(request.instructions.includes("当前本地时间：2026-10-04 10:30"));
        assert.ok(request.instructions.includes("明天继续处理测试任务"));
        assert.equal(request.tools?.length ?? 0, 0);
        runtimeCalls += 1;
        return { text: "收到，稍后继续" };
      },
    };

    const sessions = {
      async latestActivityAt() {
        return "2026-10-03T23:00:00.000Z";
      },
      async latestConversation(channel: string) {
        return {
          channel,
          conversationId: "123",
          senderId: "123",
          updatedAt: "2026-10-03T23:00:00.000Z",
        };
      },
      async get() {
        return {
          channel: "telegram",
          conversationId: "123",
          senderId: "123",
          updatedAt: "2026-10-03T23:00:00.000Z",
          messages: [
            { role: "user", content: "明天继续处理测试任务", at: "2026-10-03T23:00:00.000Z" },
          ],
        };
      },
    };

    const gateway = {
      async load() {
        return {
          available: true,
          loadedAt: "2026-10-04T04:00:00.000Z",
          data: localContext().data,
        };
      },
    };

    let sends = 0;
    const router = {
      async resolve() {
        return { channel: "telegram" as const, target: "123" };
      },
      async isActive(channel: string) {
        return channel === "telegram";
      },
      async sendIfActive(channel: string, target: string, text: string) {
        assert.equal(channel, "telegram");
        assert.equal(target, "123");
        assert.equal(text, "收到，稍后继续");
        sends += 1;
        throw new Error("simulated ambiguous Telegram send failure");
      },
    };

    const config = {
      enabled: true,
      channel: "telegram" as const,
      timezone: "Asia/Shanghai",
      quietStart: "23:00",
      quietEnd: "08:00",
      cooldownMinutes: 180,
      dailyCap: 4,
      minIntervalMinutes: 60,
      maxIntervalMinutes: 120,
    };

    const first = new HeartbeatRunner(
      root,
      config,
      runtime as any,
      sessions as any,
      gateway as any,
      router as any,
    );

    const firstNow = new Date("2026-10-04T02:30:00.000Z");
    await first.tick(firstNow);
    assert.equal(runtimeCalls, 1);
    assert.equal(sends, 1);

    const statePath = join(root, "heartbeat", "state.json");
    const attempted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(attempted.pending, undefined);
    assert.equal(attempted.sentToday, 1);
    assert.equal(attempted.recent.at(-1).text, "收到，稍后继续");

    const restarted = new HeartbeatRunner(
      root,
      config,
      {
        async reply() {
          runtimeCalls += 1;
          throw new Error("model must not rerun before the next scheduled check");
        },
      } as any,
      sessions as any,
      gateway as any,
      router as any,
    );

    await restarted.tick(new Date("2026-10-04T02:31:00.000Z"));
    assert.equal(runtimeCalls, 1);
    assert.equal(sends, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("heartbeat drops a pending proactive message after active channel changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sophon-heartbeat-switch-"));
  try {
    const config = {
      enabled: true,
      channel: "telegram" as const,
      timezone: "Asia/Shanghai",
      quietStart: "23:00",
      quietEnd: "08:00",
      cooldownMinutes: 0,
      dailyCap: 4,
      minIntervalMinutes: 60,
      maxIntervalMinutes: 120,
    };
    const now = new Date("2026-10-04T06:00:00.000Z");
    const statePath = join(root, "heartbeat", "state.json");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(root, "heartbeat"), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      dateKey: "2026-10-04",
      sentToday: 0,
      recent: [],
      pending: {
        fingerprint: "x",
        text: "旧渠道消息",
        target: "123",
        channel: "telegram",
        at: now.toISOString(),
      },
    }));

    let sends = 0;
    const router = {
      async resolve() { return { channel: "wechat" as const, target: "wx" }; },
      async isActive() { return false; },
      async sendIfActive() {
        sends += 1;
        throw new Error("send must not run after channel switch");
      },
    };
    const runner = new HeartbeatRunner(
      root,
      config,
      { async reply() { throw new Error("model should not run"); } } as any,
      { async latestActivityAt() { return undefined; } } as any,
      { async load() { throw new Error("context should not load"); } } as any,
      router as any,
    );
    await runner.tick(now);
    assert.equal(sends, 0);
    const completed = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(completed.pending, undefined);
    assert.equal(completed.sentToday, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("proactive image pending is consumed before photo network, survives restart preparation and never retries failure",async()=>{
  const root=await mkdtemp(join(tmpdir(),"gateway-heartbeat-image-"));
  try {
    const {writeJsonAtomic}=await import("../util/atomic-json.js");
    const statePath=join(root,"heartbeat","state.json");
    const image={kind:"image",path:"fixture",size:1,width:1,height:1,sha256:"fixture",prompt:"cat",model:"image"};
    await writeJsonAtomic(statePath,{dateKey:"2026-10-08",sentToday:0,recent:[],pending:{
      fingerprint:"image",text:"cat",target:"123",channel:"telegram",at:"2026-10-08T02:00:00Z",images:[image]}});
    let attempts=0;
    const router={async isActive(){return true;},async sendImagesIfActive(){
      assert.equal(JSON.parse(await readFile(statePath,"utf8")).pending,undefined);
      attempts++;throw new Error("uncertain photo");
    },async sendIfActive(){assert.fail("text cannot follow failed photo");}};
    const config={enabled:true,timezone:"Asia/Shanghai",quietStart:"23:00",quietEnd:"08:00",cooldownMinutes:180,dailyCap:4,minIntervalMinutes:60,maxIntervalMinutes:120};
    const runtime={async reply(){assert.fail("prepared image must not regenerate");}};
    const first=new HeartbeatRunner(root,config,runtime,{} as any,{} as any,router as any);
    const now=new Date("2026-10-08T02:00:00Z");await first.tick(now);
    const restarted=new HeartbeatRunner(root,config,runtime,{} as any,{} as any,router as any);
    const state=JSON.parse(await readFile(statePath,"utf8"));
    assert.equal(state.sentToday,1);assert.equal(state.pending,undefined);assert.equal(attempts,1);
    await (restarted as any).flushPending(state,now);assert.equal(attempts,1);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("fresh heartbeat can choose an image-only reply and prepare a durable typed photo",async()=>{
  const root=await mkdtemp(join(tmpdir(),"gateway-heartbeat-image-fresh-"));
  try {
    const image={kind:"image" as const,path:"fixture",size:1,width:1,height:1,sha256:"fixture",prompt:"cat",model:"image"};
    let photos=0;
    const runtime={async reply(request:any){assert.equal(request.imageOutputAllowed,true);return {text:"",images:[image]};}};
    const sessions={async latestActivityAt(){return undefined;},async latestConversation(){return undefined;}};
    const router={async resolve(){return {channel:"telegram",target:"123"};},async isActive(){return true;},
      async sendImagesIfActive(channel:string,target:string,images:any[],id:string){
        assert.equal(channel,"telegram");assert.equal(target,"123");assert.equal(images[0].sha256,"fixture");
        assert.match(id,/heartbeat:/);photos++;return true;
      },async sendIfActive(){assert.fail("SILENT must not be sent as text");}};
    const gateway={async load(){return {available:true,data: localContext().data};}};
    const config={enabled:true,timezone:"Asia/Shanghai",quietStart:"23:00",quietEnd:"08:00",cooldownMinutes:180,dailyCap:4,minIntervalMinutes:60,maxIntervalMinutes:120};
    const runner=new HeartbeatRunner(root,config,runtime,sessions as any,gateway as any,router as any);
    await runner.tick(new Date("2026-10-08T02:00:00Z"));assert.equal(photos,1);
    const state=JSON.parse(await readFile(join(root,"heartbeat","state.json"),"utf8"));
    assert.equal(state.pending,undefined);assert.equal(state.sentToday,1);
  } finally {await rm(root,{recursive:true,force:true});}
});


test("planned heartbeat schedules once, sends only when due, persists text, and replans after owner activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-heartbeat-plan-integration-"));
  try {
    const messages: any[] = [{ role: "user", content: "明天有一项任务", at: "2026-10-10T22:00:00Z" }];
    const recorded: any[] = [];
    let planCalls = 0;
    let decisions = 0;
    let sends = 0;
    const sessions = {
      async latestActivityAt() { return messages.at(-1)?.at; },
      async latestConversation() { return { conversationId: "123" }; },
      async get() { return { messages }; },
      async append(_channel: string, _conversationId: string, _sender: string, added: any[]) {
        recorded.push(...added);
        messages.push(...added);
      },
    };
    const runtime = { async reply(request: any) {
      if (request.sessionId === "heartbeat-planner") {
        planCalls++;
        assert.equal(request.imageOutputAllowed, true);
        assert.equal(request.purpose, "heartbeat_plan");
        assert.ok(request.text.trim());
        // Planning uses local context without a required external service.
        assert.match(request.instructions, /根据可靠的本地 Recent、近期对话/);
        assert.match(request.instructions, /无任务闲聊/);
        assert.match(request.instructions, /用户已有回答或刚问过不要重复问/);
        assert.match(request.instructions, /缺少记录不代表空闲/);
        assert.equal(request.tools?.length ?? 0, 0);
        return { text: JSON.stringify({ wakes: planCalls === 1 ? [
          { time: "10:30", intent: "任务前提醒" },
          { time: "14:00", intent: "旧候选" },
        ] : [{ time: "16:00", intent: "新的日程状态提醒" }] }) };
      }
      decisions++;
      assert.equal(request.sessionId, "heartbeat");
      assert.match(request.instructions, /避免重复询问用户状态/);
      assert.match(request.instructions, /避免重复询问用户状态或发送无意义的连续消息/);
      assert.ok(request.instructions.includes(planCalls === 1 ? "任务前提醒" : "新的日程状态提醒"));
      return { text: decisions === 1 ? "任务顺利完成" : "计划已更新" };
    } };
    const router = {
      async resolve() { return { channel: "telegram", target: "123" }; },
      async isActive() { return true; },
      async sendIfActive(_channel: string, _target: string, _text: string) { sends++; return true; },
    };
    const gateway = { async load() { return { available: true, data: localContext().data }; } };
    const config = {
      enabled: true, planningEnabled: true, timezone: "Asia/Shanghai",
      quietStart: "23:00", quietEnd: "08:00", cooldownMinutes: 180,
      dailyCap: 4, minIntervalMinutes: 60, maxIntervalMinutes: 120,
    };
    const runner = new HeartbeatRunner(root, config, runtime as any, sessions as any,
      gateway as any, router as any);
    await runner.tick(new Date("2026-10-11T00:00:00Z")); // 08:00 local
    assert.equal(planCalls, 1);
    assert.equal(decisions, 0);
    await runner.tick(new Date("2026-10-11T02:29:00Z"));
    assert.equal(sends, 0);
    await runner.tick(new Date("2026-10-11T02:30:00Z")); // 10:30 local
    assert.equal(sends, 1);
    assert.equal(recorded[0]?.content, "任务顺利完成");
    assert.equal(recorded[0]?.role, "assistant");
    assert.match(recorded[0]?.id, /^heartbeat:.*:text:assistant$/);
    await runner.tick(new Date("2026-10-11T02:31:00Z"));
    assert.equal(sends, 1);
    // A real user follow-up invalidates the old 14:00 candidate.
    messages.push({ role: "user", content: "我改计划了，晚点出门", at: "2026-10-11T02:40:00Z" });
    await runner.tick(new Date("2026-10-11T03:00:00Z")); // 11:00 local
    assert.equal(planCalls, 2);
    const state = JSON.parse(await readFile(join(root, "heartbeat", "state.json"), "utf8"));
    assert.deepEqual(state.plan.wakes.map((wake: any) => wake.time), ["16:00"]);
    await runner.tick(new Date("2026-10-11T06:00:00Z")); // old 14:00
    assert.equal(sends, 1);
    await runner.tick(new Date("2026-10-11T08:00:00Z")); // new 16:00
    assert.equal(sends, 2);
    assert.equal(decisions, 2);
    const restarted = new HeartbeatRunner(root, config,
      { async reply() { assert.fail("restarting must not replay consumed planned wakes"); } } as any,
      sessions as any, gateway as any, router as any);
    await restarted.tick(new Date("2026-10-11T08:01:00Z"));
    assert.equal(sends, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("planned heartbeat never asks a model when local Core is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-heartbeat-unavailable-"));
  try {
    const runner = new HeartbeatRunner(root, {
      enabled: true, planningEnabled: true, timezone: "Asia/Shanghai", quietStart: "23:00",
      quietEnd: "08:00", cooldownMinutes: 0, dailyCap: 4, minIntervalMinutes: 60, maxIntervalMinutes: 120,
    }, { async reply() { assert.fail("Core unavailable"); } } as any,
    { async latestConversation() { return undefined; } } as any,
    { async load() { return { available: false }; } } as any,
    { async resolve() { return { channel: "telegram", target: "123" }; } } as any);
    await runner.tick(new Date("2026-10-11T00:00:00Z"));
    await assert.rejects(readFile(join(root, "heartbeat", "state.json"), "utf8"), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("heartbeat can deliver configured Telegram sticker and text with at-most-once persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-heartbeat-sticker-"));
  try {
    const sends: string[] = [];
    const saved: any[] = [];
    const runtime = { async reply() { return { text: "给你发个贴纸\n[STICKER:1]" }; } };
    const router = {
      async resolve() { return { channel: "telegram", target: "123" }; },
      async isActive() { return true; },
      availableStickers() { return 1; },
      async sendIfActive(_channel: string, _target: string, text: string) {
        sends.push("text:" + text); return true;
      },
      async sendStickerIfActive(_channel: string, _target: string, index: number) {
        sends.push("sticker:" + index); return true;
      },
    };
    const sessions = {
      async latestActivityAt() { return undefined; },
      async latestConversation() { return undefined; },
      async append(_channel: string, _conversationId: string, _senderId: string, entries: any[]) {
        saved.push(...entries);
      },
    };
    const runner = new HeartbeatRunner(root, {
      enabled: true, timezone: "Asia/Shanghai", quietStart: "23:00", quietEnd: "08:00",
      cooldownMinutes: 0, dailyCap: 4, minIntervalMinutes: 60, maxIntervalMinutes: 120,
    }, runtime as any, sessions as any,
    { async load() { return { available: true, data: localContext().data }; } } as any, router as any);
    await runner.tick(new Date("2026-10-11T03:00:00Z"));
    assert.deepEqual(sends, ["text:给你发个贴纸", "sticker:1"]);
    assert.deepEqual(saved.map(entry => entry.content), ["给你发个贴纸", "[贴纸]"]);
    const state = JSON.parse(await readFile(join(root, "heartbeat", "state.json"), "utf8"));
    assert.equal(state.pending, undefined);
    assert.equal(state.sentToday, 1);
    await runner.tick(new Date("2026-10-11T03:01:00Z"));
    assert.equal(sends.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("pending proactive evening message expires instead of sending after overnight quiet hours", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-heartbeat-overnight-"));
  try {
    const { writeJsonAtomic } = await import("../util/atomic-json.js");
    const statePath = join(root, "heartbeat", "state.json");
    await writeJsonAtomic(statePath, {
      dateKey: "2026-10-11", sentToday: 0, recent: [],
      pending: { fingerprint: "old", text: "计划中的测试提醒", target: "123",
        channel: "telegram", at: "2026-10-10T14:55:00Z" },
    });
    const runner = new HeartbeatRunner(root, {
      enabled: true, planningEnabled: true, timezone: "Asia/Shanghai",
      quietStart: "23:00", quietEnd: "08:00", cooldownMinutes: 0,
      dailyCap: 4, minIntervalMinutes: 60, maxIntervalMinutes: 120,
    }, { async reply() { assert.fail("no new decision"); } } as any, {} as any, {} as any,
    { async isActive() { return true; }, async sendIfActive() { assert.fail("old text must not send"); } } as any);
    await runner.tick(new Date("2026-10-11T00:00:00Z")); // 08:00 after overnight quiet hours
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.pending, undefined);
    assert.equal(state.sentToday, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("daily plan is first generated by the heartbeat at or after 07:00, not at midnight", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-heartbeat-0700-"));
  try {
    let plans = 0;
    let decisions = 0;
    const runner = new HeartbeatRunner(root, {
      enabled: true, planningEnabled: true, timezone: "Asia/Shanghai",
      quietStart: "01:00", quietEnd: "07:00", cooldownMinutes: 60,
      dailyCap: 8, minIntervalMinutes: 60, maxIntervalMinutes: 120,
    }, {
      async reply(request: any) {
        if (request.sessionId === "heartbeat-planner") {
          plans += 1;
          return { text: '{"wakes":[{"time":"08:30","intent":"自然问候"}]}' };
        }
        decisions += 1;
        assert.match(request.instructions, /自然问候/);
        return { text: "SILENT" };
      },
    } as any, {
      async latestConversation() { return undefined; },
      async latestActivityAt() { return undefined; },
    } as any, {
      async load() { return { available: true, data: localContext().data }; },
    } as any, {
      async resolve() { return { channel: "telegram", target: "123" }; },
      async sendIfActive() { assert.fail("SILENT must never send a message"); },
    } as any);

    await runner.tick(new Date("2026-10-10T16:30:00Z")); // 00:30 local, otherwise allowed
    await runner.tick(new Date("2026-10-10T22:59:00Z")); // 06:59 local
    assert.equal(plans, 0);
    assert.equal(decisions, 0);
    await runner.tick(new Date("2026-10-10T23:00:00Z")); // 07:00 local
    assert.equal(plans, 1);
    assert.equal(decisions, 0);
    const saved = JSON.parse(await readFile(join(root, "heartbeat", "state.json"), "utf8"));
    assert.equal(saved.plan.generatedAt, "2026-10-10T23:00:00.000Z");
    assert.deepEqual(saved.plan.wakes.map((wake: any) => wake.time), ["08:30"]);
    await runner.tick(new Date("2026-10-10T23:01:00Z"));
    assert.equal(plans, 1);
    await runner.tick(new Date("2026-10-11T00:30:00Z")); // 08:30 local
    assert.equal(plans, 1);
    assert.equal(decisions, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("morning heartbeat replaces a persisted pre-07 plan without waiting for legacy throttle", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-heartbeat-legacy-morning-"));
  try {
    const { writeJsonAtomic } = await import("../util/atomic-json.js");
    const statePath = join(root, "heartbeat", "state.json");
    await writeJsonAtomic(statePath, {
      dateKey: "2026-10-11",
      sentToday: 0,
      recent: [],
      // This plan was created during the former midnight-to-01:00 planning window.
      plan: {
        date: "2026-10-11", channel: "telegram",
        generatedAt: "2026-10-10T16:30:00Z",
        wakes: [{ time: "07:30", intent: "outdated intent" }],
      },
      // Simulate a pre-07 failed planning attempt; this must not postpone 07:00.
      planAttemptAt: "2026-10-10T22:59:00Z",
    });
    let plans = 0;
    const runner = new HeartbeatRunner(root, {
      enabled: true, planningEnabled: true, timezone: "Asia/Shanghai",
      quietStart: "01:00", quietEnd: "07:00", cooldownMinutes: 60,
      dailyCap: 8, minIntervalMinutes: 60, maxIntervalMinutes: 120,
    }, {
      async reply(request: any) {
        assert.equal(request.sessionId, "heartbeat-planner");
        plans += 1;
        return { text: '{"wakes":[{"time":"09:00","intent":"新的早晨计划"}]}' };
      },
    } as any, {
      async latestConversation() { return undefined; },
    } as any, {
      async load() { return { available: true, data: localContext().data }; },
    } as any, {
      async resolve() { return { channel: "telegram", target: "123" }; },
    } as any);

    await runner.tick(new Date("2026-10-10T22:59:00Z")); // 06:59
    assert.equal(plans, 0);
    await runner.tick(new Date("2026-10-10T23:00:00Z")); // 07:00
    assert.equal(plans, 1);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.plan.generatedAt, "2026-10-10T23:00:00.000Z");
    assert.deepEqual(saved.plan.wakes, [{ time: "09:00", intent: "新的早晨计划" }]);
    await runner.tick(new Date("2026-10-10T23:01:00Z"));
    assert.equal(plans, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("Heartbeat Decision exposes paid image tool only with authorized route and budget",async()=>{
  for(const scenario of ["enabled","unauthorized","limit","route","wechat","plan"]){
    const root=await mkdtemp(join(tmpdir(),"heartbeat-image-tools-"));
    try{
      let generated=0,sent=0,decisions=0;
      const enabled=scenario==="enabled";
      const runtime=new ProviderRuntime(root,{
        siwc:{reply:async(request:any)=>{
          decisions++;
          assert.equal((request.tools ?? []).some((t:any)=>t.name==="gateway_generate_image"),enabled);
          if(enabled){
            const first=await request.executeTool("gateway_generate_image",{prompt:"窗边的橘猫，柔和日光"});
            assert.equal(first.success,true);
            assert.equal((await request.executeTool("gateway_generate_image",{prompt:"不应重复付费"})).success,false);
          }
          return {text:scenario==="plan"?'{"wakes":[]}':"（查看示例）这是本次生成的示例图片。"};
        }},
        openrouter:{getImageSettings:async()=>({route:scenario==="route"?"provider":"openrouter"}),
          canGenerateImage:async(autonomous:boolean)=>{assert.equal(autonomous,true);return !["unauthorized","limit"].includes(scenario);},
          generateImage:async()=>{generated++;return {text:"",images:[{path:"fixture-only",sha256:"fixture",model:"image",mimeType:"image/png",size:1}]};},
          reply:async()=>assert.fail("no paid chat fallback")},
      } as any);
      const runner=new HeartbeatRunner(root,{enabled:true,planningEnabled:scenario==="plan",timezone:"Asia/Shanghai",quietStart:"23:00",quietEnd:"08:00",cooldownMinutes:0,dailyCap:4,minIntervalMinutes:1,maxIntervalMinutes:2},
        runtime,{latestActivityAt:async()=>undefined,latestConversation:async()=>undefined,append:async()=>{}} as any,
        {load:async()=>localContext()} as any,
        {resolve:async()=>({channel:scenario==="wechat"?"wechat":"telegram",target:"1"}),isActive:async()=>true,
          sendIfActive:async()=>true,sendImagesIfActive:async()=>{sent++;return true;}} as any);
      await runner.tick(new Date("2026-10-23T04:00:00Z"));
      assert.equal(decisions,1);assert.equal(generated,Number(enabled));assert.equal(sent,Number(enabled));
    }finally{await rm(root,{recursive:true,force:true});}
  }
});
