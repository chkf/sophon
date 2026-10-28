import type { MemoryStore } from '../memory/store.js';
import type { RuntimeTool } from './types.js';

export const DECISION_TOOL_NAME = 'gateway_turn_decision';
export const DECISION_TOOL: RuntimeTool = {
  name: DECISION_TOOL_NAME, readOnly: true, replaySafe: true,
  description: '先按需查询记忆、贴纸候选及其他资料，正式回复前提交一次决策。stage_direction 只写简短的虚构动作或心理描写，可表达角色当下意图；不写分析过程，不复述到台词。展示由本地开关控制。',
  parameters: {type:'object',additionalProperties:false,required:['stage_direction','reply_mode','sticker','quote','image'],properties:{
    stage_direction:{type:'string',minLength:1,maxLength:600},
    reply_mode:{type:'string',enum:['text','voice']},
    sticker:{type:'string',enum:['skip','consider']},quote:{type:'string',enum:['skip','consider']},
    image:{type:'string',enum:['skip','requested']}
  }}
};
export interface TurnDecision {
  stage_direction:string;reply_mode:'text'|'voice';
  sticker:'skip'|'consider';quote:'skip'|'consider';image:'skip'|'requested';
}
const keys=(value:Record<string,unknown>,fields:string[])=>Object.keys(value).length===fields.length && fields.every(k=>Object.hasOwn(value,k));
export class TurnDecisionState {
  private plan?:TurnDecision;
  private receipt?:unknown;
  private searches=0;
  constructor(private readonly available:{voice:boolean;sticker:boolean;quote:boolean;image:boolean},private readonly memory?:MemoryStore){}
  get current(){return this.plan;}
  get tool():RuntimeTool {
    const tool=structuredClone(DECISION_TOOL);
    const fields=tool.parameters.properties as Record<string,Record<string,unknown>>;
    if(!this.available.voice)fields.reply_mode.enum=['text'];
    if(!this.available.sticker)fields.sticker.enum=['skip'];
    if(!this.available.quote)fields.quote.enum=['skip'];
    if(!this.available.image)fields.image.enum=['skip'];
    return tool;
  }
  select(args:Record<string,unknown>):unknown {
    if(this.plan){if(JSON.stringify(args)===JSON.stringify(this.plan))return this.receipt;throw Error('本轮决策已提交，不要重复修改。');}
    if(!keys(args,['stage_direction','reply_mode','sticker','quote','image']) ||
      typeof args.stage_direction!=='string'||!args.stage_direction.trim()||args.stage_direction.length>600 ||
      !['text','voice'].includes(String(args.reply_mode))||!['skip','consider'].includes(String(args.sticker))||
      !['skip','consider'].includes(String(args.quote))||!['skip','requested'].includes(String(args.image)))throw Error('请完整填写有效的回复决策。');
    if(args.reply_mode==='voice'&&!this.available.voice||args.sticker==='consider'&&!this.available.sticker||
      args.quote==='consider'&&!this.available.quote||args.image==='requested'&&!this.available.image)throw Error('所选能力本轮不可用，请选择文字或跳过。');
    this.plan=structuredClone(args) as unknown as TurnDecision;
    return this.receipt={accepted:true,reply_mode:args.reply_mode};
  }
  search(args:Record<string,unknown>):unknown {
    if(!this.memory)throw Error('本轮未提供记忆检索。');
    if(this.searches>=2)throw Error('本轮最多检索两次；请依据已有信息回应，不补编。');
    if(Object.keys(args).some(k=>!['query','depth','limit'].includes(k)))throw Error('未知检索参数。');
    this.searches++;
    return this.memory.search(args.query as string,args.depth===undefined?1:args.depth as number,args.limit===undefined?8:args.limit as number);
  }
  allow(name:string,args?:Record<string,unknown>):void {
    const output = ['send_voice','gateway_generate_image','gateway_reply_native'].includes(name) ||
      name==='gateway_sticker' && args?.action!=='list';
    if(!this.plan){if(output)throw Error('正式输出前请提交 gateway_turn_decision。');return;}
    if(name==='gateway_generate_image'&&this.plan.image!=='requested')throw Error('本轮未选择生图。');
    if(name==='send_voice'&&this.plan.reply_mode!=='voice')throw Error('本轮选择文字回复。');
  }
}
