import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { centralEnabled, mainPath, schemaVersion, getState, putState, transaction } from "../state/database.js";
export interface VoiceText { token:string; chat:string; message:number|null; text:string; page:number|null }
/** Voice attempt ledger used to prevent duplicate paid requests. */
export interface VoiceLedger {
  job(id:string):{result:string|null;error:string|null}|undefined;
  reserve(id:string,kind:"asr"|"tts",dailyLimit?:number|null):void;
  finish(id:string,result?:string,error?:string):void;
  status(kind:"asr"|"tts",note?:string):string;
  saveText(token:string,chat:string,text:string,operationId?:string):void;
  sent(token:string,id:number):void;
  text(token:string):VoiceText|undefined;
  shown(token:string,message:number,page:number):void;
  close?():void;
}
export class VoiceStore implements VoiceLedger {
  private readonly db:DatabaseSync;
  private readonly central:boolean;
  private readonly version:0|1|2;
  private sql(text:string):string { return this.central ? text.replace(/\b(jobs|status)\b/g, "voice_$1") : text; }
  constructor(root:string){
    this.central=centralEnabled(root);const dir=join(root,"voice");mkdirSync(dir,{recursive:true,mode:0o700});
    const path=this.central?mainPath(root):join(dir,"voice.sqlite");this.db=new DatabaseSync(path);chmodSync(path,0o600);
    this.version=schemaVersion(this.db);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    if(this.version!==2)this.db.exec(this.sql("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,kind TEXT NOT NULL,day TEXT NOT NULL,result TEXT,error TEXT); CREATE TABLE IF NOT EXISTS voice_text (token TEXT PRIMARY KEY,chat TEXT NOT NULL,message INTEGER,text TEXT NOT NULL,page INTEGER); CREATE TABLE IF NOT EXISTS status (kind TEXT PRIMARY KEY,note TEXT NOT NULL);"));
  }
  job(id:string):{result:string|null;error:string|null}|undefined {
    return this.db.prepare(this.version===2?"SELECT result,error FROM voice_records WHERE operation_id=?":this.sql("SELECT result,error FROM jobs WHERE id=?")).get(id) as {result:string|null;error:string|null}|undefined;
  }
  reserve(id:string,kind:"asr"|"tts",dailyLimit?:number|null):void {
    if(dailyLimit!=null&&(!Number.isSafeInteger(dailyLimit)||dailyLimit<1))throw new Error("语音每日上限无效。");
    transaction(this.db,()=>{
      const day=new Date().toISOString().slice(0,10);
      if(dailyLimit!=null){
        const n=(this.db.prepare(this.version===2?"SELECT count(*) AS n FROM voice_records WHERE operation_id IS NOT NULL AND kind=? AND day=?":this.sql("SELECT count(*) AS n FROM jobs WHERE kind=? AND day=?")).get(kind,day) as {n:number}).n;
        if(n>=dailyLimit)throw new Error("今日语音调用已达到设置的每日上限，请在语音设置调整或明天再试。");
      }
      if(this.version===2)this.db.prepare("INSERT INTO voice_records(id,operation_id,kind,day) VALUES(?,?,?,?)").run(randomUUID(),id,kind,day);
      else this.db.prepare(this.sql("INSERT INTO jobs(id,kind,day) VALUES(?,?,?)")).run(id,kind,day);
    });
  }
  finish(id:string,result?:string,error?:string) {
    this.db.prepare(this.version===2?"UPDATE voice_records SET result=?,error=? WHERE operation_id=?":this.sql("UPDATE jobs SET result=?,error=? WHERE id=?")).run(result??null,error??null,id);
  }
  status(kind:"asr"|"tts",note?:string):string {
    if(this.version===2) {
      return transaction(this.db,()=>{
        const row=getState(this.db,"voice/status");
        if(row&&row.encoding!=="json")throw new Error("语音诊断编码无效。");
        const value:unknown=row?JSON.parse(row.value):{};
        if(!value||typeof value!=="object"||Array.isArray(value)||Object.entries(value).some(([key,item])=>!["asr","tts"].includes(key)||typeof item!=="string"))throw new Error("语音诊断内容无效。");
        const status=value as Partial<Record<"asr"|"tts",string>>;
        if(note!==undefined) {status[kind]=note;putState(this.db,{key:"voice/status",category:"diagnostic",value:JSON.stringify(status)});}
        return status[kind]??"尚未真实调用验证";
      });
    }
    if(note!==undefined)this.db.prepare(this.sql("INSERT OR REPLACE INTO status VALUES(?,?)")).run(kind,note);
    return (this.db.prepare(this.sql("SELECT note FROM status WHERE kind=?")).get(kind) as {note:string}|undefined)?.note??"尚未真实调用验证";
  }
  /** Only new TTS supplies operationId; historical unpaired text remains an independent row. */
  saveText(token:string,chat:string,text:string,operationId?:string) {
    if(this.version===2) {
      if(operationId) {
        const result=this.db.prepare("UPDATE voice_records SET token=?,chat=?,text=? WHERE operation_id=? AND kind='tts' AND token IS NULL").run(token,chat,text,operationId);
        if(result.changes!==1)throw new Error("语音任务不存在或已关联原文。");
      } else this.db.prepare("INSERT INTO voice_records(id,kind,token,chat,text) VALUES(?,'tts',?,?,?)").run(randomUUID(),token,chat,text);
    } else this.db.prepare("INSERT INTO voice_text(token,chat,text) VALUES(?,?,?)").run(token,chat,text);
  }
  sent(token:string,id:number){this.db.prepare(this.version===2?"UPDATE voice_records SET message=? WHERE token=?":"UPDATE voice_text SET message=? WHERE token=?").run(id,token);}
  text(token:string):VoiceText|undefined{return this.db.prepare(this.version===2?"SELECT token,chat,message,text,page FROM voice_records WHERE token=?":"SELECT * FROM voice_text WHERE token=?").get(token) as VoiceText|undefined;}
  shown(token:string,message:number,page:number){this.db.prepare(this.version===2?"UPDATE voice_records SET message=?,page=? WHERE token=?":"UPDATE voice_text SET message=?,page=? WHERE token=?").run(message,page,token);}
  close(){this.db.close();}
}
