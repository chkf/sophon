import {getState,mainPath,openDatabase,putState} from '../state/database.js';

const KEY='runtime/reply-timing';
export const DEFAULT_REPLY_WAIT_SECONDS=8;
export function validReplyWait(seconds:unknown):seconds is number {
  return typeof seconds==='number' && Number.isInteger(seconds) && seconds>=0 && seconds<=30;
}
/** Shared owner setting; no conversation content is stored here. */
export class ReplyTiming {
  constructor(private readonly root:string){}
  get():{seconds:number} {
    const db=openDatabase(mainPath(this.root));
    try {
      const saved=getState(db,KEY);
      const seconds=saved?JSON.parse(saved.value).seconds:DEFAULT_REPLY_WAIT_SECONDS;
      if(!validReplyWait(seconds))throw Error('回复等待时间设置无效。');
      return {seconds};
    }finally{db.close();}
  }
  milliseconds():number{return this.get().seconds*1000;}
  set(seconds:number):{seconds:number}{
    if(!validReplyWait(seconds))throw Error('回复等待时间须为 0–30 秒的整数。');
    const db=openDatabase(mainPath(this.root));
    try{putState(db,{key:KEY,value:JSON.stringify({seconds})});return {seconds};}
    finally{db.close();}
  }
}
