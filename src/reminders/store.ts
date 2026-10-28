import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {readJsonFile,writeJsonAtomic} from '../util/atomic-json.js';
import {SerialQueue} from '../util/serial-queue.js';
import type {ChannelName} from '../channels/types.js';
export type ReminderStatus='pending'|'sending'|'delivered'|'unknown'|'cancelled'|'expired';
export interface Reminder {id:string;text:string;dueAt:string;timezone:string;channel:ChannelName;target:string;status:ReminderStatus;createdAt:string;updatedAt:string;late?:boolean}
export class ReminderError extends Error {}
const DAY=86400_000;
export class ReminderStore {
 private readonly path:string;
 private readonly queue=new SerialQueue();
 constructor(dataDir:string,private readonly onChanged:()=>void=()=>{}){this.path=join(dataDir,'heartbeat','reminders.json');}
 private read():Promise<Reminder[]>{return readJsonFile(this.path,[]);}
 private change<T>(work:(items:Reminder[])=>T):Promise<T>{return this.queue.run(async()=>{
  const items=await this.read();const result=work(items);await writeJsonAtomic(this.path,items);this.onChanged();return structuredClone(result);
 });}
 list():Promise<Reminder[]>{return this.queue.run(async()=>structuredClone(await this.read()).sort((a,b)=>a.dueAt.localeCompare(b.dueAt)));}
 create(input:{text:unknown;dueAt:unknown;timezone:string;channel:ChannelName;target:string;source:string},now=new Date()):Promise<Reminder>{
  const {text,dueAt}=input;
  if(typeof text!=='string'||!text.trim()||text.length>1000)throw new ReminderError('提醒内容必须为 1–1000 字符。');
  if(typeof dueAt!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(dueAt)||!Number.isFinite(Date.parse(dueAt)))throw new ReminderError('请使用带明确时区偏移的 ISO 时间。');
  // Reject calendar overflow instead of silently moving a reminder to another day.
  const day=dueAt.slice(0,10);if(new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)throw new ReminderError('提醒日期无效。');
  const at=new Date(dueAt).toISOString();
  const id='rem_'+createHash('sha256').update(JSON.stringify([input.channel,input.target,input.source,at,text.trim()])).digest('hex').slice(0,32);
  return this.change(items=>{
   const existing=items.find(item=>item.id===id);if(existing)return existing;
   if(Date.parse(at)<=now.getTime()||Date.parse(at)>now.getTime()+365*DAY)throw new ReminderError('提醒时间须在未来一年内。');
   // Keep all pending work and at most 100 recent terminal records.
   const terminal=items.filter(i=>!['pending','sending'].includes(i.status)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,100);
   const live=items.filter(i=>['pending','sending'].includes(i.status));
   if(live.length>=100)throw new ReminderError('最多保留 100 个待执行提醒，请先取消不需要的任务。');
   items.splice(0,items.length,...live,...terminal);
   const item:Reminder={id,text:text.trim(),dueAt:at,timezone:input.timezone,channel:input.channel,target:input.target,status:'pending',createdAt:now.toISOString(),updatedAt:now.toISOString()};items.push(item);return item;
  });
 }
 cancel(id:unknown,now=new Date()):Promise<Reminder>{return this.change(items=>{
  const item=items.find(i=>i.id===id);if(!item)throw new ReminderError('提醒不存在。');
  if(item.status!=='pending'&&item.status!=='cancelled')throw new ReminderError('提醒已进入发送或结束状态，无法取消。');
  item.status='cancelled';item.updatedAt=now.toISOString();return item;
 });}
 recover(now=new Date()):Promise<void>{return this.change(items=>{for(const item of items)if(item.status==='sending'){item.status='unknown';item.updatedAt=now.toISOString();}});}
 claim(id:string,now:Date):Promise<Reminder|undefined>{return this.change(items=>{
  const item=items.find(i=>i.id===id);if(!item||item.status!=='pending'||Date.parse(item.dueAt)>now.getTime())return;
  const late=now.getTime()-Date.parse(item.dueAt);item.updatedAt=now.toISOString();
  if(late>DAY){item.status='expired';return;}
  item.status='sending';item.late=late>60_000;return item;
 });}
 finish(id:string,status:'delivered'|'unknown',now=new Date()):Promise<void>{return this.change(items=>{
  const item=items.find(i=>i.id===id);if(item?.status==='sending'){item.status=status;item.updatedAt=now.toISOString();}
 });}
}
