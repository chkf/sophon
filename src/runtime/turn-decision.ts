import type { MemoryStore } from '../memory/store.js';
import type { RuntimeTool } from './types.js';
import type { ToolGroups } from './tool-groups.js';

export const DECISION_TOOL_NAME = 'gateway_turn_decision';
export const DECISION_TOOL: RuntimeTool = {
  name: DECISION_TOOL_NAME, readOnly: true, replaySafe: true,
  description: '每轮先提交一次内部回复决策，明确选择或跳过各能力。stage_direction 是简短的动作或角色内心独白，不写分析过程；它辅助后续台词与语气。检索需求达到 0.6 时，工具直接执行首次记忆检索或读取并返回结果。决策不会作为台词发送。',
  parameters: {type:'object',additionalProperties:false,required:['stage_direction','reply_mode','memory','sticker','quote','image'],properties:{
    stage_direction:{type:'string',minLength:1,maxLength:600},
    reply_mode:{type:'string',enum:['text','voice']},
    memory:{type:'object',additionalProperties:false,required:['need_score','query','ids'],properties:{
      need_score:{type:'number',minimum:0,maximum:1},query:{type:['string','null'],maxLength:500},
      ids:{anyOf:[{type:'array',items:{type:'string'},minItems:1,maxItems:8},{type:'null'}]}
    }},
    sticker:{type:'string',enum:['skip','consider']},quote:{type:'string',enum:['skip','consider']},
    image:{type:'string',enum:['skip','requested']}
  }}
};
export interface TurnDecision {
  stage_direction:string;reply_mode:'text'|'voice';
  memory:{need_score:number;query:string|null;ids:string[]|null};
  sticker:'skip'|'consider';quote:'skip'|'consider';image:'skip'|'requested';
  tool_groups?:string[];
}
const keys=(value:Record<string,unknown>,fields:string[])=>Object.keys(value).length===fields.length && fields.every(k=>Object.hasOwn(value,k));
export class TurnDecisionState {
  private plan?:TurnDecision;
  private receipt?:unknown;
  private searches=0;
  constructor(private readonly available:{voice:boolean;sticker:boolean;quote:boolean;image:boolean},private readonly memory?:MemoryStore,
    private readonly groups?:ToolGroups){}
  get current(){return this.plan;}
  get tool():RuntimeTool {
    const tool=structuredClone(DECISION_TOOL);
    const fields=tool.parameters.properties as Record<string,Record<string,unknown>>;
    if (this.groups?.groups.length) {
      fields.tool_groups = this.groups.parameter;
      (tool.parameters.required as string[]).push('tool_groups');
    }
    if(!this.available.voice)fields.reply_mode.enum=['text'];
    if(!this.available.sticker)fields.sticker.enum=['skip'];
    if(!this.available.quote)fields.quote.enum=['skip'];
    if(!this.available.image)fields.image.enum=['skip'];
    if(!this.memory){
      fields.memory.properties={need_score:{type:'number',minimum:0,maximum:0.59},query:{type:'null'},ids:{type:'null'}};
    }
    return tool;
  }
  select(args:Record<string,unknown>):unknown {
    if(this.plan){if(JSON.stringify(args)===JSON.stringify(this.plan))return this.receipt;throw Error('本轮决策已提交，不要重复修改。');}
    const m=args.memory as Record<string,unknown>;
    if(!keys(args,['stage_direction','reply_mode','memory','sticker','quote','image',...(this.groups?.groups.length ? ['tool_groups'] : [])]) ||
      typeof args.stage_direction!=='string'||!args.stage_direction.trim()||args.stage_direction.length>600 ||
      !['text','voice'].includes(String(args.reply_mode))||!['skip','consider'].includes(String(args.sticker))||
      !['skip','consider'].includes(String(args.quote))||!['skip','requested'].includes(String(args.image))||
      !m||typeof m!=='object'||Array.isArray(m)||!keys(m,['need_score','query','ids'])||
      typeof m.need_score!=='number'||!Number.isFinite(m.need_score)||m.need_score<0||m.need_score>1||
      !(m.query===null||typeof m.query==='string'&&m.query.trim().length>0&&m.query.length<=500)||
      !(m.ids===null||Array.isArray(m.ids)&&m.ids.length>0&&m.ids.length<=8&&m.ids.every(id=>typeof id==='string'&&id.length>0)))throw Error('请完整填写有效的回复决策。');
    if(args.reply_mode==='voice'&&!this.available.voice||args.sticker==='consider'&&!this.available.sticker||
      args.quote==='consider'&&!this.available.quote||args.image==='requested'&&!this.available.image)throw Error('所选能力本轮不可用，请选择文字或跳过。');
    if(m.need_score>=0.6 && (!this.memory || (m.query===null)===(m.ids===null)))throw Error('需要检索时填写 query 或已有 ids 中的一项；本轮未提供记忆工具时请选择跳过。');
    if(m.need_score<0.6 && (m.query!==null||m.ids!==null))throw Error('跳过检索时 query 和 ids 均应为 null。');
    const loaded = this.groups?.groups.length ? this.groups.load(args.tool_groups) : undefined;
    this.plan=structuredClone(args) as unknown as TurnDecision;
    let result:unknown={status:'skipped'};
    if(m.need_score>=0.6)try {result=m.ids ? this.memory!.read(m.ids as string[]) : this.search({query:m.query});}
    catch(error){result={error:error instanceof Error?error.message:'记忆读取失败'};}
    return this.receipt={accepted:true,reply_mode:args.reply_mode,memory:result,...loaded};
  }
  search(args:Record<string,unknown>):unknown {
    if(!this.plan||this.plan.memory.need_score<0.6||!this.memory)throw Error('本轮未选择检索记忆。');
    if(this.searches>=2)throw Error('本轮最多检索两次；请依据已有信息回应，不补编。');
    if(Object.keys(args).some(k=>!['query','depth','limit'].includes(k)))throw Error('未知检索参数。');
    this.searches++;
    return this.memory.search(args.query as string,args.depth===undefined?1:args.depth as number,args.limit===undefined?8:args.limit as number);
  }
  allow(name:string):void {
    if(!this.plan)throw Error('请先提交 gateway_turn_decision。');
    if(name==='gateway_memory_read'&&this.plan.memory.need_score<0.6)throw Error('本轮未选择检索记忆。');
    if(name==='gateway_generate_image'&&this.plan.image!=='requested')throw Error('本轮未选择生图。');
    if(name==='send_voice'&&this.plan.reply_mode!=='voice')throw Error('本轮选择文字回复。');
    if(name==='gateway_sticker'&&this.plan.sticker==='skip')throw Error('本轮选择不使用贴纸。');
    if(name==='gateway_reply_native'&&this.plan.quote==='skip')throw Error('本轮选择不引用。');
  }
}

