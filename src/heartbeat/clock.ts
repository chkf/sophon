import type { HeartbeatConfig } from "../config/index.js";
import type { HeartbeatState } from "./policy.js";
import { dateKey, localMinutes, quietMinutes } from "../util/clock-window.js";
import { isCurrentMorningPlan, nextDueWake } from "./planner.js";

/** Find a real instant by local calendar time, including DST gaps and repeated hours. */
function nextMinute(now: Date, timezone: string, accepts: (date: string, minute: number) => boolean): number {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const start = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  for (let at = start; at <= start + 3 * 86400_000; at += 60_000) {
    const p = Object.fromEntries(formatter.formatToParts(at).map(p => [p.type, p.value]));
    if (accepts(`${p.year}-${p.month}-${p.day}`, Number(p.hour) * 60 + Number(p.minute))) return at;
  }
  throw new Error("无法确定下次 Heartbeat 本地时间。");
}

export function nextMorning(now: Date, config: HeartbeatConfig, tomorrow = false): number {
  const today = dateKey(now, config.timezone);
  const allowed = (day: string, minute: number) => (!tomorrow || day > today) && minute >= 7 * 60 &&
    !quietMinutes(minute, config.quietStart, config.quietEnd);
  if (allowed(today, localMinutes(now, config.timezone))) return now.getTime();
  return nextMinute(now, config.timezone, allowed);
}

export function nextPlannedCheck(now: Date, config: HeartbeatConfig, state: HeartbeatState): number {
  if (!isCurrentMorningPlan(state.plan, now, config.timezone)) return nextMorning(now, config);
  if (nextDueWake(state.plan!, now, config.timezone) !== undefined) return now.getTime();
  const today = dateKey(now, config.timezone);
  const minutes = new Set(state.plan!.wakes.filter(w => !w.consumed).map(w => Number(w.time.slice(0, 2)) * 60 + Number(w.time.slice(3))));
  return nextMinute(now, config.timezone, (day, minute) => day === today ? minutes.has(minute) :
    minute >= 7 * 60 && !quietMinutes(minute, config.quietStart, config.quietEnd));
}

