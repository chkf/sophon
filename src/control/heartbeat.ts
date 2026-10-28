import type { HeartbeatState } from "../heartbeat/policy.js";
import { dateKey,localMinutes,parseTime } from "../util/clock-window.js";
export function controlHeartbeatTiming(state:HeartbeatState,planning:boolean|undefined,timezone:string,channel:string,now:Date,enabled=true) {
 const plan=state.plan;
 const nextPlannedWake=enabled && planning && plan?.date===dateKey(now,timezone) && plan.channel===channel
  ? plan.wakes.filter(wake=>!wake.consumed && (parseTime(wake.time)??-1)>=localMinutes(now,timezone)).map(wake=>wake.time).sort()[0]??null:null;
 const check=Date.parse(state.nextCheckAt??'');
 return {planningEnabled:Boolean(planning),nextPlannedWake,nextCheckAt:enabled && !planning && Number.isFinite(check) && check>=now.getTime()?state.nextCheckAt:null};
}
