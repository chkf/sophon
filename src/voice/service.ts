import { spokenText } from "../runtime/reply-segments.js";
import { createHash } from "node:crypto";
import type { InboundMessage } from "../channels/types.js";
import { SerialQueue } from "../util/serial-queue.js";
import { type AudioCodec, LightweightAudio, MAX_AUDIO_SECONDS } from "./audio.js";
import { VoiceSettingsStore, speakable, validVoiceInstruction } from "./settings.js";
import type { VoiceLedger } from "./store.js";
import type { SpeechClient } from "./bailian.js";
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
export type VoiceDeliveryResult = { sent:true; note:string } | { sent:false; error:string; note?:string };
export type VoiceDelivery = (audio:Buffer, operationId:string) => Promise<VoiceDeliveryResult>;
export class VoiceService {
  constructor(readonly settings:VoiceSettingsStore,readonly store:VoiceLedger,private readonly client:SpeechClient,
    private readonly codec:AudioCodec=new LightweightAudio(),private readonly queue:SerialQueue=new SerialQueue()){}
  configured(){return this.client.configured();}
  async close():Promise<void>{await this.queue.drain();this.store.close?.();}
  async preprocess(message:InboundMessage):Promise<InboundMessage>{
    const copy=structuredClone(message);let extra="";
    for(let i=0;i<copy.attachments.length;i++){
      const attachment=copy.attachments[i]!;
      if(attachment.error)throw new Error(attachment.error);
      if(attachment.kind==="video")throw new Error("视频理解暂未启用，请改发图片或文字。");
      if(attachment.kind!=="voice"&&attachment.kind!=="audio")continue;
      const text=await this.queue.run(async()=>{
        if(message.channel==="wechat"&&attachment.transcriptionSource==="platform"&&typeof attachment.transcription==="string"&&attachment.transcription.trim()&&attachment.transcription.length<=32_000&&!attachment.transcription.includes("\u0000"))return attachment.transcription.trim();
        attachment.transcriptionSource="asr";
        const settings=await this.settings.get();
        if(!settings.asr||!this.configured())throw new Error("语音识别尚未配置或开启，请先发文字；可在 TG /model → 语音设置启用。");
        if(!attachment.localPath)throw new Error("语音文件下载失败，请重发。");
        if(attachment.durationSeconds!==undefined&&(!Number.isFinite(attachment.durationSeconds)||attachment.durationSeconds<=0||attachment.durationSeconds>MAX_AUDIO_SECONDS))throw new Error("语音超过 120 秒限制或时长无效，请分段发送。");
        const id="asr:"+hash(message.channel+":"+message.senderId+":"+(attachment.sourceMessageId??message.messageId)+":"+(attachment.remoteId??i));
        const old=this.store.job(id);
        if(old?.result)return old.result;
        if(old)throw new Error(old.error??"上次识别结果不确定，为避免重复扣费未自动重试；请重发语音。");
        // Decode and validate duration before reserving a paid attempt.
        const wav=await this.codec.prepare(attachment.localPath,attachment.mimeType);
        this.store.reserve(id,"asr",settings.asrDailyLimit);
        try{const result=await this.client.transcribe(wav,settings.asrModel);this.store.finish(id,result);this.store.status("asr","最近一次识别成功（模型："+settings.asrModel+"）");return result;}
        catch(e){const error=e instanceof Error?e.message:"语音识别失败";this.store.finish(id,undefined,error);this.store.status("asr",error);throw new Error(error);}
      });
      attachment.transcription=text;
      attachment.transcriptionSource??="asr";
      for(const fragment of copy.platformMessages??[]) {
        const original=fragment.attachments?.find(item=>item.sourceMessageId===attachment.sourceMessageId);
        if(original){original.transcription=text;original.transcriptionSource=attachment.transcriptionSource;}
      }
      const rendered="[语音转写 · "+message.channel+" · 附件 "+(i+1)+"]\n"+text;
      const marker="[附件索引 "+(i+1)+"]";
      if(copy.text.includes(marker))copy.text=copy.text.replace(marker,rendered);else extra+="\n"+rendered;
      for(const fragment of copy.platformMessages??[])if(fragment.attachments?.some(item=>item.sourceMessageId===attachment.sourceMessageId))fragment.text=fragment.text.replace(marker,rendered);
    }
    copy.text+=extra;return copy;
  }
  /** Called by a durable delivery path, never by the model's transcript-registration tool.
   * The channel must return false only when no voice was sent; ambiguous sends throw.
   * One queue covers ASR, synthesis, encoding and delivery so paid attempts cannot overlap.
   */
  async synthesizeAndDeliver(text:string,id:string,deliver:VoiceDelivery,instruction?:string):Promise<boolean>{
    text = spokenText(text);
    if(!speakable(text))return false;
    return this.queue.run(async()=>{
      const job="tts:"+id;const prior=this.store.job(job);
      if(prior?.result==="sent")return true;
      if(prior){if(prior.error?.includes("已使用文字")||prior.error?.includes("已回退文字"))return false;throw new Error("上次语音发送状态不确定，不重复发送。");}
      const settings=await this.settings.get();
      if(!settings.tts||!this.configured())return false;
      let bytes:Buffer;
      try {
        this.store.reserve(job,"tts",settings.ttsDailyLimit);
        bytes=await this.client.synthesize(text,settings,validVoiceInstruction(instruction)?instruction:undefined);
      }catch(e){
        if(this.store.job(job))this.store.finish(job,undefined,"语音合成或转码失败，已使用文字。");
        this.store.status("tts",e instanceof Error?e.message:"合成失败");return false;
      }
      let result:VoiceDeliveryResult;
      try {
        result=await deliver(bytes,job);
      }catch{
        this.store.finish(job,undefined,"语音送达不确定；不重复发送。");
        throw new Error("语音送达不确定；未重发原文以避免重复回复。");
      }
      if(!result.sent){this.store.finish(job,undefined,result.error);this.store.status("tts",result.note??result.error);return false;}
      this.store.finish(job,"sent");this.store.status("tts",result.note);return true;
    });
  }
}
