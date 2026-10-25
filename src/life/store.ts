import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { mainPath, openDatabase, getState, putState, transaction } from "../state/database.js";

const KEY="runtime/life";
export interface LifeState { current:string; updatedAt:string }
export class LifeStore {
  constructor(private readonly dataDir:string){}
  private access<T>(fn:(db:DatabaseSync)=>T):T {
    if(!existsSync(mainPath(this.dataDir))) throw new Error("Life database unavailable");
    const db=openDatabase(mainPath(this.dataDir));
    try{return transaction(db,()=>fn(db));}finally{db.close();}
  }
  snapshot():LifeState {
    return this.access(db=>{
      const row=getState(db,KEY);
      if(!row)return {current:"",updatedAt:""};
      const v:unknown=JSON.parse(row.value);
      if(!v||typeof v!=="object"||typeof (v as LifeState).current!=="string"||typeof (v as LifeState).updatedAt!=="string")
        throw new Error("Life state invalid");
      return v as LifeState;
    });
  }
  update(current:string,now=new Date()):LifeState {
    if(typeof current!=="string"||current.length>1600)throw new Error("Life summary must be <=1600 characters");
    return this.access(db=>{
      const state={current:current.trim(),updatedAt:now.toISOString()};
      putState(db,{key:KEY,category:"runtime",value:JSON.stringify(state)});
      return state;
    });
  }
}
export const LIFE_TOOL={
  name:"gateway_life_update",
  description:"维护角色虚构日常的简短连续状态。仅在有值得延续的变化时更新；不得把虚构经历伪装成已核验的现实活动、交易或实际到场。",
  parameters:{type:"object",properties:{current:{type:"string",maxLength:1600,description:"当前兴趣、进行中的创作和未完生活事件的简短摘要"}} ,required:["current"],additionalProperties:false}
};
