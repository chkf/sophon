import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { CredentialEncryptionAdapter } from "../../runtime/siwc/sdk.js";
import { SerialQueue } from "../../util/serial-queue.js";
import type { Binding, FaultKind, IlinkMessage } from "./api.js";
import type { InboundMessage, PlatformMessageFragment } from "../types.js";
import type { ReplyOutcome } from "../reply.js";
import { centralEnabled, mainPath, pathRoots, references, schemaVersion, getState, putState, ILINK_RECEIPT_KEY } from "../../state/database.js";
export interface IlinkBatch { id:string; events:IlinkMessage[]; firstAt:number; lastAt:number; inbound?:InboundMessage; attempts?:number; retryAt?:number; paused?:boolean }
export interface IlinkPending { batchId:string; reply:Exclude<ReplyOutcome,{kind:"retry"|"pause"}>; userId:string }
export interface IlinkDeliveryReceipt extends IlinkPending {
  botId:string;
  origin?:"proactive";
  at?:string;
  confirmed:{text:string;fragment?:PlatformMessageFragment}[];
  complete:boolean;
}
export interface IlinkState {
  binding?:Binding; cursor:string; context?:string; invalid?:boolean;
  batches:IlinkBatch[]; pending?:IlinkPending;
  /** Only acknowledged chunks are recoverable; a restart settles history and never resends them. */
  deliveryReceipt?:IlinkDeliveryReceipt;
  fault?:{kind:FaultKind;count:number;notified:boolean};
  faults?:Record<string,{count:number;notified:boolean}>;
}
/** Read-only deployment verification also checks the encrypted journal and its public capability marker. */
export function validateIlinkReceipt(state:IlinkState,marker:boolean,version:0|1|2):void {
  const receipt=state.deliveryReceipt;
  if(marker!==Boolean(receipt))throw new Error("微信发送回执与保护标记不一致；请保留备份并检查，不能重发或清除未结算回执。");
  if(receipt===undefined)return;
  if(version!==2||!receipt||state.pending||!state.binding||receipt.botId!==state.binding.botId||receipt.userId!==state.binding.userId||
    typeof receipt.batchId!=="string"||!receipt.batchId||typeof receipt.complete!=="boolean"||!receipt.reply||
    !["model_reply","local_reply"].includes(receipt.reply.kind)||typeof receipt.reply.text!=="string"||
    receipt.reply.kind==="model_reply"&&(typeof receipt.reply.deliveryId!=="string"||!receipt.reply.deliveryId)||
    receipt.origin!==undefined&&receipt.origin!=="proactive"||
    receipt.origin==="proactive"&&(receipt.reply.kind!=="model_reply"||typeof receipt.at!=="string"||!Number.isFinite(Date.parse(receipt.at)))||
    receipt.origin!=="proactive"&&receipt.at!==undefined||
    !Array.isArray(receipt.confirmed)||receipt.confirmed.some(chunk=>!chunk||typeof chunk.text!=="string"||chunk.fragment&&
      (chunk.fragment.accountId!==receipt.botId||chunk.fragment.conversationId!==receipt.userId||chunk.fragment.direction!=="outbound"||
        typeof chunk.fragment.messageId!=="string"||!chunk.fragment.messageId||chunk.fragment.text!==chunk.text)))
    throw new Error("微信发送回执损坏或绑定不匹配；请保留备份，已尝试的发送不会自动重发。");
}
/** Encrypted payloads plus a permanent, small idempotency ledger; one local SQLite transaction per update batch. */
export class IlinkStore {
  private readonly db:DatabaseSync;
  private readonly queue=new SerialQueue();
  private cached?:IlinkState;
  private readonly central:boolean;
  private readonly roots:string[];
  private readonly version:0|1|2;
  private sql(text:string):string { return this.central ? text.replace(/\b(state|events)\b/g, "ilink_$1") : text; }
  constructor(private readonly root:string,private readonly encryption:CredentialEncryptionAdapter) {
    this.central=centralEnabled(root);this.roots=pathRoots(root);
    const dir=join(root,"channels");mkdirSync(dir,{recursive:true,mode:0o700});
    const path=this.central?mainPath(root):join(dir,"ilink.sqlite");this.db=new DatabaseSync(path);chmodSync(path,0o600);this.version=schemaVersion(this.db);
    if(this.version===2)this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    else this.db.exec(this.sql("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY);"));
  }
  async load():Promise<IlinkState> {
    if(!this.cached) {
      const document=this.version===2?getState(this.db,"channels/ilink"):undefined;
      if(document&&document.encoding!=="encrypted_json")throw new Error("微信持久化状态编码无效。");
      const row=this.version===2?(document?{payload:document.value}:undefined):this.db.prepare(this.sql("SELECT payload FROM state WHERE id=1")).get() as {payload:string}|undefined;
      const state=row?JSON.parse(await this.encryption.decrypt(Buffer.from(row.payload,"base64"))):{cursor:"",batches:[]};
      if(!state || typeof state.cursor!=="string" || !Array.isArray(state.batches) ||
        state.batches.some((b:IlinkBatch)=>!b || typeof b.id!=="string" || !Array.isArray(b.events) ||
          !Number.isFinite(b.firstAt) || !Number.isFinite(b.lastAt)) ||
        (state.binding && ["token","botId","userId","baseUrl","telegramOwner"].some(k=>typeof state.binding[k]!=="string" || !state.binding[k]))) {
        throw new Error("微信持久化状态损坏，已停止微信接入；请保留备份并在 TG 检查。");
      }
      let marker=false;
      if(this.version===2) {
        const row=getState(this.db,ILINK_RECEIPT_KEY);marker=Boolean(row);
        if(row&&(row.category!=="metadata"||row.encoding!=="json"||row.value!=="true"))
          throw new Error("微信发送回执与保护标记不一致；请保留备份并检查，不能重发或清除未结算回执。");
      }
      validateIlinkReceipt(state,marker,this.version);
      this.cached=references(state,this.root,"load",this.roots);
    }
    return this.cached!;
  }
  supportsDeliveryReceipts():boolean {return this.version===2;}
  async ready():Promise<boolean> {return this.encryption.isAvailable();}
  mutate<T>(fn:(state:IlinkState)=>T,seen:string[]=[]):Promise<T> {
    return this.queue.run(async()=>{
      const next=structuredClone(await this.load());const result=fn(next);
      validateIlinkReceipt(next,Boolean(next.deliveryReceipt),this.version);
      const payload=Buffer.from(await this.encryption.encrypt(JSON.stringify(this.central?references(next,this.root,"store",this.roots):next))).toString("base64");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if(this.version===2) {
          putState(this.db,{key:"channels/ilink",category:"channel",encoding:"encrypted_json",value:payload});
          if(next.deliveryReceipt)putState(this.db,{key:ILINK_RECEIPT_KEY,category:"metadata",encoding:"json",value:"true"});
          else this.db.prepare("DELETE FROM gateway_state WHERE key=?").run(ILINK_RECEIPT_KEY);
          for(const id of seen)this.db.prepare("INSERT OR IGNORE INTO channel_events(channel,event_key) VALUES('wechat',?)").run(id);
        } else {
          this.db.prepare(this.sql("INSERT OR REPLACE INTO state VALUES(1,?)")).run(payload);
          for(const id of seen)this.db.prepare(this.sql("INSERT OR IGNORE INTO events VALUES(?)")).run(id);
        }
        this.db.exec("COMMIT");this.cached=next;return result;
      } catch(error){this.db.exec("ROLLBACK");throw error;}
    });
  }
  seen(id:string):boolean {return Boolean(this.db.prepare(this.version===2?"SELECT 1 FROM channel_events WHERE channel='wechat' AND event_key=?":this.sql("SELECT 1 FROM events WHERE id=?")).get(id));}
  close(){this.db.close();}
}
