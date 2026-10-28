import { createHash } from "node:crypto";
import { formatLocalTimestamp } from "../util/time-context.js";
import type { DailyWakePlan } from "../heartbeat/planner.js";
import type { Reminder } from "./store.js";

export const REMINDER_GAP_MS=30*60_000;
export function reminderRevision(items:Reminder[]):string {
  return createHash("sha256").update(JSON.stringify(items.filter(r=>!["cancelled","expired"].includes(r.status))
    .map(r=>[r.id,r.dueAt,r.text]).sort((a,b)=>a[0]!.localeCompare(b[0]!)))).digest("hex");
}
function reservedTimes(item:Reminder):number[] {
  return ["cancelled","expired"].includes(item.status)?[]:[Date.parse(item.dueAt),
    ...(["delivered","sending","unknown"].includes(item.status)?[Date.parse(item.updatedAt)]:[])];
}
export function reminderBlocks(items:Reminder[],now:Date):boolean {
  return items.some(r=>r.status==="pending" && Date.parse(r.dueAt)<=now.getTime() ||
    reservedTimes(r).some(at=>Math.abs(at-now.getTime())<=REMINDER_GAP_MS));
}
/** Compare local calendar minutes, including reminders across midnight. Runtime uses actual instants. */
export function avoidReminderWakes(plan:DailyWakePlan,items:Reminder[],timezone:string):void {
  plan.wakes=plan.wakes.filter(wake=>wake.consumed || !items.some(r=>reservedTimes(r).some(at=>{
    const local=Date.parse(formatLocalTimestamp(new Date(at),timezone).replace(" ","T")+":00Z");
    const candidate=Date.parse(plan.date+"T"+wake.time+":00Z");
    return Math.abs(local-candidate)<=REMINDER_GAP_MS;
  })));
}
export function reminderPlanningContext(items:Reminder[],timezone:string,now:Date):string {
  const start=Date.parse(formatLocalTimestamp(now,timezone).slice(0,10)+"T00:00:00Z");
  const reserved=items.filter(r=>reservedTimes(r).some(at=>{
    const local=Date.parse(formatLocalTimestamp(new Date(at),timezone).replace(" ","T")+":00Z");
    return local>=start-REMINDER_GAP_MS && local<start+86400_000+REMINDER_GAP_MS;
  }));
  return "用户已约定的定时提醒优先；以下时间前后各 30 分钟不要安排主动聊天，也不要在 Heartbeat 重复发送提醒。修改或取消提醒后按新列表重新规划，其余意图仍遵循 Core。\n"+
    (reserved.map(r=>formatLocalTimestamp(r.dueAt,timezone)+"："+r.text.slice(0,120)+"（"+r.status+"）").join("\n")||"当前没有定时提醒。");
}

