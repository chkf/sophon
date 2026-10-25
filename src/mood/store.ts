import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { mainPath, openDatabase, getState, putState, transaction } from "../state/database.js";

export const MOOD_LABELS = ["冷淡","疏离","低落","慵懒","平静","惬意","愉快","亲昵","热烈","狂热"] as const;
const KEY = "runtime/mood";
const GRACE_MS = 6 * 60 * 60_000;
const STEP_MS = 12 * 60 * 60_000;
const REQUIRED_ROUNDS = [4,4,4,6,10,16] as const;

interface MoodRecord { level:number; progress:number; lastInteractionAt?:string; updatedAt:string }
export interface MoodSnapshot extends MoodRecord { label:string; roundsToNext:number|null }

export function effectiveMood(level:number, lastInteractionAt:string|undefined, now:Date):number {
  if (!lastInteractionAt) return level;
  const elapsed = now.getTime() - Date.parse(lastInteractionAt);
  if (!Number.isFinite(elapsed) || elapsed <= GRACE_MS) return level;
  const steps = Math.floor((elapsed-GRACE_MS)/STEP_MS);
  if (steps <= 0) return level;
  return level > 3 ? Math.max(3,level-steps) : Math.min(3,level+steps);
}
function validate(raw:unknown):MoodRecord {
  if (!raw || typeof raw !== "object") throw new Error("Mood state invalid");
  const v=raw as MoodRecord;
  if (!Number.isInteger(v.level)||v.level<1||v.level>10||!Number.isInteger(v.progress)||v.progress<0||v.progress>10000||
      typeof v.updatedAt!=="string"||!Number.isFinite(Date.parse(v.updatedAt))||
      (v.lastInteractionAt!==undefined&&!Number.isFinite(Date.parse(v.lastInteractionAt)))) throw new Error("Mood state invalid");
  return v;
}
export class MoodStore {
  constructor(private readonly dataDir:string) {}
  private access<T>(fn:(db:DatabaseSync)=>T):T {
    if (!existsSync(mainPath(this.dataDir))) throw new Error("Mood database unavailable");
    const db=openDatabase(mainPath(this.dataDir));
    try { return transaction(db,()=>fn(db)); } finally { db.close(); }
  }
  private read(db:DatabaseSync, now:Date):MoodRecord {
    const row=getState(db,KEY);
    const raw=row?validate(JSON.parse(row.value)):{level:5,progress:0,updatedAt:now.toISOString()};
    const level=effectiveMood(raw.level,raw.lastInteractionAt,now);
    return {...raw,level,progress:level!==raw.level?0:raw.progress};
  }
  private save(db:DatabaseSync,value:MoodRecord):void {
    putState(db,{key:KEY,category:"runtime",value:JSON.stringify(value)});
  }
  snapshot(now=new Date()):MoodSnapshot {
    return this.access(db=>{
      const s=this.read(db,now);
      return {...s,label:MOOD_LABELS[s.level-1]!,roundsToNext:s.level<7?REQUIRED_ROUNDS[s.level-1]!-s.progress:null};
    });
  }
  /** One successful user/assistant exchange, not individual message fragments or proactive sends. */
  exchange(now=new Date()):MoodSnapshot {
    return this.access(db=>{
      const s=this.read(db,now);
      let level=s.level,progress=s.progress;
      if(level<7) {
        progress++;
        if(progress>=REQUIRED_ROUNDS[level-1]!) {level++;progress=0;}
      } else progress=0;
      const next={level,progress,lastInteractionAt:now.toISOString(),updatedAt:now.toISOString()};
      this.save(db,next);
      return {...next,label:MOOD_LABELS[level-1]!,roundsToNext:level<7?REQUIRED_ROUNDS[level-1]!-progress:null};
    });
  }
  /** Explicit model-requested emotional change; no reason or user-facing metadata. */
  adjust(delta:number,now=new Date()):MoodSnapshot {
    if(!Number.isInteger(delta)||delta<-9||delta>9) throw new Error("Mood delta must be an integer from -9 to 9");
    return this.access(db=>{
      const s=this.read(db,now);
      const level=Math.max(1,Math.min(10,s.level+delta));
      const next={...s,level,progress:0,updatedAt:now.toISOString()};
      this.save(db,next);
      return {...next,label:MOOD_LABELS[level-1]!,roundsToNext:level<7?REQUIRED_ROUNDS[level-1]!:null};
    });
  }
}
export const MOOD_TOOL = {
  name:"gateway_mood_adjust",
  description:"仅在本轮交流确实引起额外情绪变化时调整 Mood；普通聊天的自然增长由 Gateway 自动计算。不要为同一事件重复调整。",
  parameters:{type:"object",properties:{delta:{type:"integer",minimum:-9,maximum:9,description:"额外变化，可正可负"}} ,required:["delta"],additionalProperties:false}
};
