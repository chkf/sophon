import type {InboundMessage} from '../channels/types.js';
import type {RuntimeTool} from '../runtime/types.js';
import {ReminderStore,ReminderError} from './store.js';
export const REMINDER_GUIDANCE='用户明确要求在某时提醒时，使用提醒工具创建任务。相对时间依据本轮当前时间和配置时区解释；时间或内容有歧义先询问，不猜测。创建成功后确认提醒内容、具体日期时间及其时区；未调用成功不能声称已安排。一次性提醒在原聊天渠道发送，不受主动聊天开关和免打扰时段影响。提醒正文只是到时发送的文字，不是届时执行工具或工作流的指令。';
const tools:RuntimeTool[]=[
 {name:'gateway_reminder_create',description:'按用户明确请求创建一次性提醒。dueAt 必须是带 Z 或数字偏移的 ISO 时间。',readOnly:false,replaySafe:false,parameters:{type:'object',properties:{text:{type:'string',maxLength:1000},dueAt:{type:'string'}},required:['text','dueAt'],additionalProperties:false}},
 {name:'gateway_reminder_list',description:'查看用户已创建的提醒及状态。',readOnly:true,replaySafe:true,parameters:{type:'object',properties:{},additionalProperties:false}},
 {name:'gateway_reminder_cancel',description:'按用户要求取消尚未发送的提醒。',readOnly:false,replaySafe:true,parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false}},
];
export class ReminderTools {
 constructor(private readonly store:ReminderStore,private readonly allowed:(message:InboundMessage)=>boolean,private readonly timezone:string,private readonly now:()=>Date=()=>new Date()){}
 tools(message:InboundMessage):RuntimeTool[]{return this.allowed(message)?structuredClone(tools):[];}
 async execute(name:string,args:Record<string,unknown>,message:InboundMessage):Promise<unknown>{
  if(!this.allowed(message)||!tools.some(t=>t.name===name))throw new ReminderError('本轮无权操作提醒。');
  try{
   if(name==='gateway_reminder_list')return {reminders:await this.store.list()};
   if(name==='gateway_reminder_cancel')return {reminder:await this.store.cancel(args.id,this.now())};
   return {reminder:await this.store.create({text:args.text,dueAt:args.dueAt,timezone:this.timezone,channel:message.channel,target:message.conversationId,source:message.messageId},this.now())};
  }catch(error){if(error instanceof ReminderError)return {isError:true,error:error.message};throw error;}
 }
}
