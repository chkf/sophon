import { dateKey, localMinutes, parseTime, quietMinutes } from "../util/clock-window.js";
export { localMinutes } from "../util/clock-window.js";

export interface PlannedWake {
  time: string; // HH:MM in configured timezone
  intent: string;
  consumed?: boolean;
}

export interface DailyWakePlan {
  date: string;
  channel: string;
  // Missing on legacy plans; only reuse intents under the policy that produced them.
  policyRevision?: string;
  reminderRevision?: string;
  lastUserAt?: string;
  generatedAt: string;
  wakes: PlannedWake[];
}

// A new local day begins at midnight, but proactive wake planning begins at 07:00.
const BASE_PLAN_START_MINUTE = 7 * 60;

export function basePlanningWindowOpen(now: Date, timezone: string): boolean {
  return localMinutes(now, timezone) >= BASE_PLAN_START_MINUTE;
}

/** Plans prepared before 07:00 by an older Gateway are refreshed at the first morning tick. */
export function isCurrentMorningPlan(plan: DailyWakePlan | undefined, now: Date, timezone: string): boolean {
  if (!plan || plan.date !== dateKey(now, timezone)) return false;
  const generatedAt = new Date(plan.generatedAt);
  return Number.isFinite(generatedAt.getTime()) &&
    dateKey(generatedAt, timezone) === plan.date &&
    basePlanningWindowOpen(generatedAt, timezone);
}

/** Parse a proposal, never an instruction. Invalid or out-of-hours wakeups are discarded. */
export function parseWakePlan(
  response: string,
  now: Date,
  timezone: string,
  quietStart: string,
  quietEnd: string,
  dailyCap: number,
  channel: string,
  lastUserAt?: string,
  previous?: DailyWakePlan,
): DailyWakePlan {
  const raw = response.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "");
  const data: unknown = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Heartbeat plan must be an object.");
  const proposal=data as Record<string,unknown>;
  const incremental=Object.hasOwn(proposal,"keep") || Object.hasOwn(proposal,"remove");
  let inherited:PlannedWake[]=[];
  if(incremental) {
    if(!previous || previous.date!==dateKey(now,timezone) || previous.channel!==channel)throw new Error("No current plan to revise.");
    const remaining=previous.wakes.filter(w=>!w.consumed && (parseTime(w.time)??-1)>=localMinutes(now,timezone));
    if(Object.hasOwn(proposal,"keep")) {
      if(proposal.keep!==true || Object.keys(proposal).some(k=>k!=="keep"))throw new Error("Invalid keep response.");
      inherited=remaining;
    } else {
      if(!Array.isArray(proposal.remove) || proposal.remove.some(t=>typeof t!=="string" || !remaining.some(w=>w.time===t)))throw new Error("Invalid removed wake.");
      inherited=remaining.filter(w=>!(proposal.remove as string[]).includes(w.time));
    }
  }
  const candidates=proposal.keep===true?[]:proposal.wakes;
  if (!Array.isArray(candidates)) {
    throw new Error("Heartbeat plan must contain a wakes array.");
  }
  const wakes: PlannedWake[] = [];
  const nowMinute = localMinutes(now, timezone);
  const cap=Math.max(0,Math.min(8,dailyCap+2));
  inherited=inherited.filter(w=>!quietMinutes(parseTime(w.time)!,quietStart,quietEnd)).slice(0,cap);
  for (const candidate of candidates.slice(0, 12)) {
    if (!candidate || typeof candidate !== "object") continue;
    const entry = candidate as Record<string, unknown>;
    if (typeof entry.time !== "string" || typeof entry.intent !== "string") continue;
    const minute = parseTime(entry.time);
    const intent = entry.intent.trim();
    if (minute === undefined || minute < nowMinute + 20 || !intent || intent.length > 120) continue;
    if (quietMinutes(minute, quietStart, quietEnd) || previous?.wakes.some(wake => wake.consumed && wake.time === entry.time)) continue;
    if (inherited.some(wake=>Math.abs((parseTime(wake.time)??0)-minute)<45))continue;
    if (wakes.some(wake => Math.abs((parseTime(wake.time) ?? 0) - minute) < 45)) continue;
    wakes.push({ time: entry.time, intent });
  }
  wakes.sort((a, b) => a.time.localeCompare(b.time));
  return {
    date: dateKey(now, timezone),
    channel,
    ...(lastUserAt ? { lastUserAt } : {}),
    generatedAt: now.toISOString(),
    wakes: [...inherited,...wakes.slice(0,Math.max(0,cap-inherited.length))].sort((a,b)=>a.time.localeCompare(b.time)),
  };
}

/** A missed wake never creates a catch-up burst after a restart. */
export function nextDueWake(plan: DailyWakePlan, now: Date, timezone: string): number | undefined {
  if (plan.date !== dateKey(now, timezone)) return undefined;
  const current = localMinutes(now, timezone);
  const index = plan.wakes.findIndex(wake => {
    const minute = parseTime(wake.time);
    return !wake.consumed && minute !== undefined && minute <= current && current - minute <= 45;
  });
  return index >= 0 ? index : undefined;
}
