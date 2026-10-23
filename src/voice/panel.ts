import type { PanelView } from "../channels/telegram/panels.js";
import type { VoiceService } from "./service.js";
import { ASR_DAILY_LIMITS, ASR_MODELS, TTS_DAILY_LIMITS, TTS_MODELS, VOICES } from "./settings.js";
const button=(text:string,run:()=>Promise<PanelView>)=>({text,run});
export class VoicePanel {
  constructor(private readonly speech:VoiceService,private readonly preview:()=>Promise<boolean>){}
  async open(note=""):Promise<PanelView>{
    const s=await this.speech.settings.get();
    return {text:[note,"语音设置 · 阿里云百炼",this.speech.configured()?"服务器凭据及端点已配置；可用性以实际调用为准":"未配置百炼密钥或地域端点，请在服务器安全配置。",
      "识别："+(s.asr?"开启":"关闭")+" / "+s.asrModel,"合成："+(s.tts?"开启":"关闭")+" / "+s.ttsModel,"音色："+s.voice,
      "每日识别上限："+(s.asrDailyLimit??"不限")+" / 每日合成上限："+(s.ttsDailyLimit??"不限")+"（按 UTC 日期计算）",
      "说话语气：Gateway 自行判断；音色和 TTS 模型只由你手动切换。","TG 语音「查看文字」按钮："+(s.showTextButton?"显示":"隐藏"),"TG 主动语音："+(s.proactive?"开启":"关闭"),"微信回复方式：文字；原生语音气泡暂不可用。TG 主动语音开关仅作用于 TG。",
      "识别状态："+this.speech.store.status("asr"),"合成状态："+this.speech.store.status("tts"),
      "开启后调用百炼付费额度。浏览此面板不调用语音服务。\n每段最长 120 秒 / 8MB；朗读 ≤500 字符。"].filter(Boolean).join("\n"),rows:[
      [button(s.asr?"关闭识别":"开启识别（付费）",()=>this.toggle("asr",!s.asr)),button("识别模型",()=>this.asr())],
      [button(s.tts?"关闭合成":"开启合成（付费）",()=>this.toggle("tts",!s.tts)),button("合成模型",()=>this.tts())],
      [button("选择音色",()=>this.voices()),button("试听（付费）",async()=>({text:"试听会使用当前音色调用百炼付费语音服务，固定文字：你好，这是语音试听示例。",rows:[[button("确认试听",async()=>{const ok=await this.preview();return this.open(ok?"试听已提交 TG，请在手机上确认播放效果。":"试听未发送，请检查启用状态、凭据、依赖及上方状态。");}),button("取消",()=>this.open())]]}))],
      [button(s.showTextButton?"隐藏「查看文字」按钮":"显示「查看文字」按钮",()=>this.setTextButton(!s.showTextButton))],
      [button(s.proactive?"关闭 TG 主动语音":"开启 TG 主动语音（付费）",()=>this.toggle("proactive",!s.proactive))],
      [button("识别每日上限",()=>this.dailyLimit("asr")),button("合成每日上限",()=>this.dailyLimit("tts"))]]};
  }
  /** Display preference only; never invokes TTS or enables paid features. */
  private async setTextButton(show:boolean):Promise<PanelView>{
    await this.speech.settings.update({showTextButton:show});
    return this.open(show?"已显示后续语音的「查看文字」按钮。":"已隐藏后续语音的「查看文字」按钮。");
  }
  private async toggle(field:"asr"|"tts"|"proactive",value:boolean){
    if(value&&!this.speech.configured())return this.open("请先在服务器配置凭据及地域端点。");
    if(field==="proactive"&&value&&!(await this.speech.settings.get()).tts)return this.open("请先开启语音合成。");
    await this.speech.settings.update({[field]:value});return this.open();
  }
  private async asr():Promise<PanelView>{return {text:"选择已核对协议的 ASR 模型；中文/英文混合由模型自动识别。",rows:ASR_MODELS.map(model=>[button(model,async()=>{await this.speech.settings.update({asrModel:model});return this.open();})])};}
  private async dailyLimit(kind:"asr"|"tts"):Promise<PanelView>{
    const options=kind==="asr"?ASR_DAILY_LIMITS:TTS_DAILY_LIMITS;
    return {text:(kind==="asr"?"识别":"合成")+"每日尝试次数上限（UTC）。不限仍会产生百炼费用。",rows:[null,...options].map(limit=>[button(limit===null?"不限":String(limit)+" 次",async()=>{
      await this.speech.settings.update(kind==="asr"?{asrDailyLimit:limit}:{ttsDailyLimit:limit});
      return this.open();
    })])};
  }
  private async tts():Promise<PanelView>{return {text:"选择 TTS 模型（不影响聊天模型）。音色由你手动选择；切换模型尽量保留兼容音色，不兼容时暂用首个预设，你可以继续手动选择。语气由 Gateway 自行决定。",rows:TTS_MODELS.map(model=>[button(model,async()=>{
    const previous=await this.speech.settings.get();
    const voice=VOICES[model]!.includes(previous.voice)?previous.voice:VOICES[model]![0]!;
    await this.speech.settings.update({ttsModel:model,voice});
    return this.open();
  })])};}
  private async voices():Promise<PanelView>{const s=await this.speech.settings.get();return {text:"选择音色；选中不会自动试听。",rows:VOICES[s.ttsModel]!.map(voice=>[button(voice,async()=>{await this.speech.settings.update({voice});return this.open();})])};}
}
