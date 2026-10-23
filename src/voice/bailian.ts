import { boundedBytes, trustedHttps } from "../util/bounded-http.js";
import { voiceInstructionForModel, type VoiceSettings } from "./settings.js";
import { MAX_AUDIO_BYTES } from "./audio.js";
export interface VoiceConfig { apiKey?:string; baseUrl?:string }
export interface SpeechClient { configured():boolean; transcribe(wav:Buffer,model:string):Promise<string>; synthesize(text:string,settings:VoiceSettings,instruction?:string):Promise<Buffer> }
function audioDownloadUrl(value:string):string {
  const url=new URL(value);
  // Qwen TTS documents HTTP links for this Beijing result bucket. Never send
  // signed URLs over HTTP; change only the scheme, not the signed path/query.
  // https://help.aliyun.com/zh/model-studio/qwen-tts-api
  if(url.protocol==="http:"&&url.hostname==="dashscope-result-bj.oss-cn-beijing.aliyuncs.com"&&!url.username&&!url.password&&!url.port){
    value=value.replace(/^http:/i,"https:");
  }
  trustedHttps(value,["aliyuncs.com","ali.com"]);
  return value;
}
export function voiceEndpoint(base:string):URL {
  const url=trustedHttps(base,["aliyuncs.com"]);
  if(url.pathname!=="/"||url.search||url.hash||!(/^(?:dashscope(?:-intl)?\.aliyuncs\.com|[a-z\d-]+\.(?:ap-southeast-1|cn-beijing)\.maas\.aliyuncs\.com)$/.test(url.hostname)))throw new Error("语音端点须为百炼新加坡或北京的 HTTPS API Host（不含路径）。");
  return url;
}
export class BailianSpeech implements SpeechClient {
  constructor(private readonly config:VoiceConfig,private readonly fetcher:typeof fetch=fetch){if(config.baseUrl)voiceEndpoint(config.baseUrl);}
  configured():boolean{return Boolean(this.config.apiKey&&this.config.baseUrl);}
  private async request(path:string,body:unknown,extraHeaders:Record<string,string>={}):Promise<Record<string,any>> {
    if(!this.configured())throw new Error("百炼凭据或地域端点尚未配置。");
    try {
      const response=await this.fetcher(new URL(path,voiceEndpoint(this.config.baseUrl!)),{method:"POST",redirect:"error",signal:AbortSignal.timeout(60_000),headers:{Authorization:"Bearer "+this.config.apiKey,"content-type":"application/json",...extraHeaders},body:JSON.stringify(body)});
      if(!response.ok){await response.body?.cancel();throw new Error(response.status===401||response.status===403?"百炼凭据、地域或账号权限不可用。":response.status===429?"百炼限流，请稍后再试。":"百炼模型调用失败，请核对本地域的模型可用性。");}
      const data=JSON.parse((await boundedBytes(response,1024*1024)).toString());
      if(data.code)throw new Error("百炼拒绝请求，请核对模型、音色及账号权限。");
      return data;
    }catch(e){if(e instanceof Error&&e.message.startsWith("百炼"))throw e;throw new Error("百炼语音请求超时或网络不可用，本次不自动重试付费调用。");}
  }
  async transcribe(wav:Buffer,model:string):Promise<string>{
    const audio="data:audio/wav;base64,"+wav.toString("base64");
    const modern=model==="qwen-audio-3.1-asr-flash";
    const data=modern
      ? await this.request("/api/v1/services/aigc/multimodal-generation/generation",{
          model,input:{messages:[{role:"user",content:[{type:"input_audio",input_audio:{data:audio}}]}]},
          parameters:{format:"wav",sample_rate:"16000"},
        },{"X-DashScope-SSE":"disable"})
      : await this.request("/compatible-mode/v1/chat/completions",{
          model,messages:[{role:"user",content:[{type:"input_audio",input_audio:{data:audio}}]}],
          stream:false,asr_options:{enable_itn:false},
        });
    // The new DashScope ASR contract returns output.text, not OpenAI choices.
    const text=modern?data.output?.text:data.choices?.[0]?.message?.content;
    if(typeof text!=="string"||!text.trim()||text.length>16_000)throw new Error("百炼未返回有效识别文字。");return text.trim();
  }
  async synthesize(text:string,settings:VoiceSettings,instruction?:string):Promise<Buffer>{
    const modern=settings.ttsModel.startsWith("qwen-audio-");
    const expression=voiceInstructionForModel(settings.ttsModel,instruction);
    const data=await this.request(modern?"/api/v1/services/audio/tts/SpeechSynthesizer":"/api/v1/services/aigc/multimodal-generation/generation",{
      model:settings.ttsModel,
      input:{text,voice:settings.voice,...(modern?{format:"wav",sample_rate:24000}:{language_type:"Auto"}),
        ...(expression?{instruction:expression}:{})},
    });
    const url=data.output?.audio?.url;
    if(typeof url!=="string")throw new Error("百炼没有返回合成音频。");
    const response=await this.fetcher(audioDownloadUrl(url),{redirect:"error",signal:AbortSignal.timeout(45_000)});
    if(!response.ok){await response.body?.cancel();throw new Error("合成音频下载失败。");}
    return boundedBytes(response,MAX_AUDIO_BYTES);
  }
}
