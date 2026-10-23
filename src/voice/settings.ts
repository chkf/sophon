import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../util/atomic-json.js";
import { SerialQueue } from "../util/serial-queue.js";
export interface VoiceSettings { asr:boolean; asrModel:string; tts:boolean; ttsModel:string; voice:string; proactive:boolean; showTextButton:boolean; asrDailyLimit:number|null; ttsDailyLimit:number|null }
// Presets from official Model Studio model docs; model browsing and selection never make paid calls.
export const ASR_MODELS=["qwen-audio-3.1-asr-flash","qwen3-asr-flash"] as const;
export const TTS_MODELS=["qwen3-tts-flash","qwen-audio-3.1-tts-flash","qwen-audio-3.1-tts-plus"] as const;
export const ASR_DAILY_LIMITS=[60,120,240] as const;
export const TTS_DAILY_LIMITS=[30,60,100] as const;
// The owner selects a compatible voice; Gateway cannot change this persisted setting.
export const VOICES:Record<string,string[]>={
  "qwen3-tts-flash":["Cherry","Serena","Chelsie","Ethan"],
  "qwen-audio-3.1-tts-flash":["longanhuan_v3.1"],
  "qwen-audio-3.1-tts-plus":["longanlingxin_v3.1","xunanchuan_v3.1","longanhuan_v3.1","longanfengyue_v3.1"],
};
/** Gateway can supply a brief natural-language delivery description, never a voice ID or model.
 * Validated at the tool boundary and again immediately before the paid synthesis API.
 */
export const MAX_VOICE_INSTRUCTION_CHARS=120;
export function validVoiceInstruction(value:unknown):value is string {
  if(typeof value!=="string"||value!==value.trim()||value.length<1||value.length>MAX_VOICE_INSTRUCTION_CHARS)return false;
  if(/[\x00-\x1f\x7f<>[\]{}`\\]/.test(value)||/https?:\/\//i.test(value))return false;
  // The fixed owner's voice, model and API controls are never agent-selectable.
  if(/(?:音色|声纹|变声|克隆|复刻|另一个人|男声|女声|声线|API|密钥|token|模型|改成.*声音|切换.*声音|换.*声音|voice[_ -]?id|speaker[_ -]?id|model[_ -]?id)/i.test(value))return false;
  return true;
}
export function voiceInstructionForModel(model:string,instruction?:string):string|undefined {
  if(!model.startsWith("qwen-audio-")||!instruction)return undefined;
  if(!validVoiceInstruction(instruction))throw new Error("语音表达指令无效：只能描述语气、情绪、语速或停顿。");
  return instruction;
}
const defaults:VoiceSettings={asr:false,asrModel:ASR_MODELS[0],tts:false,ttsModel:TTS_MODELS[0],voice:"Cherry",proactive:false,showTextButton:true,asrDailyLimit:null,ttsDailyLimit:null};
export class VoiceSettingsStore {
  private readonly queue=new SerialQueue();private readonly path:string;
  constructor(root:string){this.path=join(root,"voice","settings.json");}
  async get():Promise<VoiceSettings>{return {...defaults,...await readJsonFile<Partial<VoiceSettings>>(this.path,{})};}
  update(patch:Partial<VoiceSettings>):Promise<VoiceSettings>{return this.queue.run(async()=>{
    const next={...await this.get(),...patch};
    if(!ASR_MODELS.includes(next.asrModel as typeof ASR_MODELS[number])||!TTS_MODELS.includes(next.ttsModel as typeof TTS_MODELS[number])||!VOICES[next.ttsModel]?.includes(next.voice)||typeof next.showTextButton!=="boolean"||next.asrDailyLimit!==null&&!ASR_DAILY_LIMITS.includes(next.asrDailyLimit as typeof ASR_DAILY_LIMITS[number])||next.ttsDailyLimit!==null&&!TTS_DAILY_LIMITS.includes(next.ttsDailyLimit as typeof TTS_DAILY_LIMITS[number]))throw new Error("语音模型、音色、每日上限或查看文字按钮设置无效。");
    await writeJsonAtomic(this.path,next);return next;
  });}
}
export function explicitVoiceRequest(text:string):boolean {
  if(/(?:不要|别|不用|不必).{0,8}(?:语音|朗读)|(?:语音|朗读).{0,8}(?:怎么|如何|价格|收费|功能|设置|支持)/.test(text))return false;
  // Short chat commands often omit both a measure word and “回复”. Do not
  // mistake reported actions (“我刚发了语音”) or feature questions for requests.
  if(text.split(/[，。！？!?；;\n]/).some(part=>/^(?:(?:请|麻烦|你|给我|帮我|能不能|可以|现在)\s*)*(?:(?:用|发|来|换成|改用|改成)(?:一?[条段个]|一下)?语音|语音(?:回复|回答))(?:\s|[吧呀啊嘛吗呢我]|回复|回答|说|讲|给|$)/.test(part.trim())))return true;
  return /(?:请|用|发|给我|帮我|能不能|可以).{0,10}语音.{0,10}(?:回复|回答|说|发|讲)|(?:发|给我发|来|给我来|说)(?:一)?(?:条|段|个)语音|(?:请|帮我|给我)朗读|(?:reply|respond|say).{0,20}(?:voice|aloud)/i.test(text);
}
export function speakable(text:string):boolean {return Boolean(text.trim())&&text.length<=500&&!/```|https?:\/\/|(?:^|\n)\s*(?:#{1,6}\s|[-*]\s|\d+[.)]\s)|[{}]|\|.*\|/.test(text);}
