import { randomBytes } from "node:crypto";
import { TelegramBotApiError } from "../channels/telegram/api.js";
import type { TelegramApiClient, TelegramUpdate } from "../channels/telegram/types.js";
import { SerialQueue } from "../util/serial-queue.js";
import { type AudioCodec, LightweightAudio } from "./audio.js";
import type { VoiceService } from "./service.js";
import type { TelegramNativeReply } from "../channels/types.js";
import { nativeReplyParameters } from "../runtime/native-reply.js";
import { spokenText } from "../runtime/reply-segments.js";

/** Telegram owns its wire format, owner check and transcript buttons. Synthesis and
 * the durable paid-attempt ledger stay in VoiceService. This is not an iLink sender.
 */
export class TelegramVoiceTransport {
  private readonly callbacks=new SerialQueue();
  constructor(private readonly speech:VoiceService,private readonly ownerId:string,
    private readonly codec:Pick<AudioCodec,"opus">=new LightweightAudio(),
    private readonly callbackPrefix:"vt"|"vl"="vt"){}

  /** false permits one text fallback; an uncertain send rejects and must not be replayed. */
  async send(api:TelegramApiClient,target:string,text:string,id:string,preview=false,
    reply?: TelegramNativeReply, onSent?: (messageId: number) => void, instruction?:string):Promise<boolean>{
    if(target!==this.ownerId)throw new Error("语音只向已绑定的 Telegram 用户发送。");
    text=spokenText(text);
    if(!text)return false;
    return this.speech.synthesizeAndDeliver(text,id,(audio,job)=>this.callbacks.run(async()=>{
      let bytes:Buffer;const token=randomBytes(12).toString("hex");
      try {
        bytes=await this.codec.opus(audio);
        this.speech.store.saveText(token,target,text,job);
      }catch(error){
        return {sent:false,error:"语音转码或原文登记失败，已使用文字。",note:error instanceof Error?error.message:"语音转码失败"};
      }
      // The owner's persisted choice affects only the UI on NEW voice bubbles.
      // Always keep the voice job and original transcript for history/recovery.
      // A malformed settings state is a definite local failure, not a sent bubble.
      let showTextButton:boolean;
      try {
        showTextButton=(await this.speech.settings.get()).showTextButton === true;
      }catch(error){
        return {sent:false,error:"语音按钮设置读取失败，已回退文字。",note:error instanceof Error?error.message:"语音设置读取失败"};
      }
      let sent:{message_id:number};
      const parameters = !preview ? nativeReplyParameters(reply, target, reply?.accountId) : undefined;
      try {
        sent=await api.call<{message_id:number}>("sendVoice",{
          chat_id:target,voice:new Blob([new Uint8Array(bytes)],{type:"audio/ogg"}),
          ...(preview?{caption:"音色试听"}:{}),
          ...(parameters ? { reply_parameters: parameters } : {}),
          ...(showTextButton ? {reply_markup:{inline_keyboard:[[{text:"查看文字",callback_data:this.callbackPrefix+":"+token+":0"}]]}} : {}),
        },60_000);
      }catch(error){
        const rejected=error instanceof TelegramBotApiError&&error.errorCode!==undefined&&error.errorCode>=400&&error.errorCode<500;
        if(rejected)return {sent:false,error:"TG 明确拒绝语音，已回退文字。"};
        throw new Error("TG 语音送达不确定；不重复发送。");
      }
      if(!Number.isSafeInteger(sent.message_id)||sent.message_id<=0)throw new Error("TG 语音发送结果不确定。");
      this.speech.store.sent(token,sent.message_id);
       onSent?.(sent.message_id);
      return {sent:true,note:"最近一次合成成功；TG API 已接受，手机播放待确认"};
    }),instruction);
  }

  async proactive(api:TelegramApiClient,target:string,text:string,instruction?:string,deliveryId?:string):Promise<boolean>{
    if(!(await this.speech.settings.get()).proactive)return false;
    return this.send(api,target,text,deliveryId??"proactive:"+randomBytes(12).toString("hex"),false,undefined,undefined,instruction);
  }

  async callback(query:NonNullable<TelegramUpdate["callback_query"]>,api:TelegramApiClient):Promise<boolean>{
    if(!query.data?.startsWith(this.callbackPrefix+":"))return false;
    const m=query.message;
    const answer=(text?:string)=>api.call("answerCallbackQuery",{callback_query_id:query.id,...(text?{text}:{})});
    if(String(query.from.id)!==this.ownerId||!m||m.chat.type!=="private"||String(m.chat.id)!==this.ownerId){await answer("仅限所有者私聊。");return true;}
    const match=query.data.match(/^v[tl]:([a-f0-9]{24}):(\d{1,4})$/);if(!match){await answer("按钮无效。");return true;}
    await this.callbacks.run(async()=>{
      const record=this.speech.store.text(match[1]!);const page=Number(match[2]);
      if(!record||record.chat!==this.ownerId||record.message!==null&&record.message!==m.message_id){await answer("原文记录不可用。");return;}
      const chunks=spokenText(record.text).match(/[\s\S]{1,900}/g)??[""];
      if(page>=chunks.length){await answer("页码无效。");return;}
      if(record.page===page){await answer("原文已显示。");return;}
      await answer();
      const nav=[];
      if(page>0)nav.push({text:"上一页",callback_data:this.callbackPrefix+":"+record.token+":"+(page-1)});
      if(page+1<chunks.length)nav.push({text:"下一页",callback_data:this.callbackPrefix+":"+record.token+":"+(page+1)});
      await api.call("editMessageCaption",{chat_id:record.chat,message_id:m.message_id,caption:chunks[page]+(chunks.length>1?"\n("+(page+1)+"/"+chunks.length+")":""),reply_markup:{inline_keyboard:nav.length?[nav]:[[{text:"查看文字",callback_data:this.callbackPrefix+":"+record.token+":0"}]]}});
      this.speech.store.shown(record.token,m.message_id,page);
    });return true;
  }
}
