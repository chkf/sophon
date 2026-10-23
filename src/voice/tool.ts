import type { RuntimeTool } from "../runtime/types.js";
import { displayText, replyParagraphs, replyText, splitStageDirections, spokenText, visibleSegments, type ReplySegment } from "../runtime/reply-segments.js";
import { speakable, validVoiceInstruction, MAX_VOICE_INSTRUCTION_CHARS } from "./settings.js";

export const VOICE_TOOL = "send_voice";
export class VoiceSupplementError extends Error {
  constructor(readonly deliveredText:string){super("回复已部分送达，后续文字发送失败；不重发。");}
}
export const voiceTool: RuntimeTool = {
  name: VOICE_TOOL,
  description: "登记下一段语音，可多次调用，与文字和角色描写按生成顺序交替交付。text 只写台词，不含角色描写；instruction 结合 Persona、对应描写和语境描述情绪、语气、语速及停顿。成功仅表示已登记，实际发送由 Gateway 完成。",
  parameters: {type:"object",properties:{
    text:{type:"string",description:"实际台词，1–500 字符，不含角色描写、代码、链接或排版标记。"},
    instruction:{type:"string",maxLength:MAX_VOICE_INSTRUCTION_CHARS,description:"结合 Persona、对应角色描写和当前语境生成自然的情绪、语气、语速和停顿描述。"}
  },required:["text","instruction"],additionalProperties:false},
  readOnly:false,
  replaySafe:true,
};
/** Also collects text-only turns. No network or paid work occurs during selection. */
export class VoiceTurn {
  private parts: ReplySegment[] = [];
  private readonly recorded = new Set<string>();
  constructor(readonly showStageDirections = false) {}
  get segments(): ReplySegment[] { return structuredClone(this.parts); }
  // Legacy getters are retained only for older provider consumers.
  get text(): string | undefined { return this.parts.find(part => part.kind === "voice")?.text; }
  get instruction(): string | undefined { return this.parts.find(part => part.kind === "voice")?.instruction; }
  readonly guidance="根据内容和情绪自然选择文字或语音，可以分成多个气泡，不限制语音段数。角色描写遵循 Core 和 Persona 的设置；如需描写，使用简短、中性的动作说明。instruction 利用对应描写指导表达，语音只朗读正文。普通文字与 send_voice 按输出顺序交付。不要重复输出已登记的台词。工具成功仅代表登记，实际发送和失败回退由 Gateway 完成。";
  recordText(text: string, id: string): void {
    if (this.recorded.has(id)) return;
    this.recorded.add(id);
    for (const part of splitStageDirections(text).flatMap(part => part.kind === "text"
      ? replyParagraphs(part.text).map(text=>({kind:"text" as const,text})) : [part])) {
      if (part.kind === "stage_direction" && !this.showStageDirections) continue;
      // A final transcript echo must not repeat already queued speech.
      if (part.kind === "text" && this.parts.some(p => p.kind === "voice" && p.text === part.text)) continue;
      this.parts.push(part);
    }
  }
  finalize(text: string): string {
    this.recordText(text, "final");
    return displayText(text, this.showStageDirections);
  }
  restore(segments: ReplySegment[], voice = true): void {
    this.parts = visibleSegments(segments, this.showStageDirections, voice);
  }
  select(args:Record<string,unknown>):unknown {
    if(!args||typeof args!=="object"||Array.isArray(args)||Object.keys(args).some(key=>!["text","instruction"].includes(key)))
      return {success:false,error:"语音参数只能包含 text 和 instruction；音色与模型由用户手动选择。"};
    if(typeof args.text!=="string"||!speakable(args.text)||spokenText(args.text)!==args.text.trim())
      return {success:false,error:"请选择 1–500 字符的自然台词，不含角色描写、代码、链接或列表。"};
    if(args.instruction!==undefined&&!validVoiceInstruction(args.instruction))
      return {success:false,error:"instruction 只能是简短的表达描述，不能指定音色、声音身份、模型或任意控制指令。"};
    const text=args.text.trim(),instruction=(args.instruction as string|undefined)??"用自然、清晰的语气说话。";
    if (this.parts.some(p=>p.kind==="voice"&&p.text===text&&p.instruction===instruction))
      return {success:true,status:"相同片段已登记，不重复发送。"};
    this.parts.push({kind:"voice",text,instruction});
    return {success:true,status:"已登记语音片段，待本轮完成后按顺序发送。"};
  }
  combine(final:string):string {
    this.recordText(final,"final");
    return replyText(this.parts);
  }
}
export function voiceSupplement(text:string,voice:string):string {
  return text===voice?"":text.startsWith(voice+"\n\n")?text.slice(voice.length+2):text;
}
