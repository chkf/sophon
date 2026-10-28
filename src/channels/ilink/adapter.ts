import { displayText } from "../../runtime/reply-segments.js";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import QRCode from "qrcode";
import type { PanelView } from "../telegram/panels.js";
import type { Attachment, InboundHandler, InboundMessage, InboundMessageReference, PlatformMessageFragment, ProactiveDelivery, ProactiveSender } from "../types.js";
import { normalizeInboundReply } from "../reply.js";
import { splitTelegramText } from "../telegram/delivery.js";
import { splitHumanMessages } from "../message-splitting.js";
import type { MediaStore } from "../../media/store.js";
import { SerialQueue } from "../../util/serial-queue.js";
import { trustedHttps } from "../../util/bounded-http.js";
import { IlinkApi, IlinkError, ILINK_BASE, type Binding, type IlinkClient, type IlinkMessage, type IlinkItem, type IlinkReference, type FaultKind, platformId, messagePlatformId } from "./api.js";
import { partialQuote, renderReference } from "./references.js";
import { IlinkStore, type IlinkBatch } from "./store.js";
import type { ReplyOutcome } from "../reply.js";

interface Options {
  showStageDirections?: () => Promise<boolean>;
  ownerId:string; store:IlinkStore; media:MediaStore; queue:SerialQueue; api?:IlinkClient;
  bind:(owner:string,user:string)=>Promise<void>; activate:()=>Promise<void>;
  notify:(text:string)=>Promise<void>; qrPhoto:(bytes:Buffer)=>Promise<void>;
  delivered:(user:string,text:string,id:string,complete?:boolean,fragments?:PlatformMessageFragment[])=>Promise<void>;
  proactiveDelivered?:(user:string,text:string,id:string,at:string,fragments?:PlatformMessageFragment[])=>Promise<void>;
  lookupReference?:(user:string,botId:string,id:string)=>Promise<InboundMessageReference|undefined>;
  discarded:(user:string,id:string)=>Promise<void>;
  debounceMs?:number; maxWaitMs?:number; getInputDebounceMs?:()=>number;
}
interface Login { id:string; code:string; base:string; expires:number; abort:AbortController; verify?:string }
const btn=(text:string,run:()=>Promise<PanelView>)=>({text,run});
const delay=(ms:number,signal?:AbortSignal)=>new Promise<void>(resolve=>{
  if(signal?.aborted){resolve();return;}
  const done=()=>{clearTimeout(timer);signal?.removeEventListener("abort",done);resolve();};
  const timer=setTimeout(done,ms);signal?.addEventListener("abort",done,{once:true});
});
export class IlinkAdapter implements ProactiveSender {
  readonly channel="wechat" as const;
  private readonly api:IlinkClient;
  private readonly accepting=new SerialQueue();
  private running=false;
  private stopSignal=new AbortController();
  private poll?:Promise<void>;
  private flushTimer?:NodeJS.Timeout;
  private scheduleGeneration=0;
  private startupFailed=false;
  private flushing?:Promise<void>;
  private processing?:string;
  private handler?:InboundHandler;
  private login?:Login;
  constructor(private readonly options:Options){this.api=options.api??new IlinkApi();}
  async start(handler:InboundHandler):Promise<void>{
    this.handler=handler;
    let state;
    try { state=await this.options.store.load(); }
    catch { this.startupFailed=true;await this.options.notify("微信加密状态无法读取，微信已暂停。请检查服务器凭据密钥和备份；TG 普通聊天继续可用。").catch(()=>undefined);return; }
    if(state.binding){
      try {
        if(state.binding.telegramOwner!==this.options.ownerId)throw new Error("微信绑定的 Telegram 用户不匹配。");
        await this.options.bind(this.options.ownerId,state.binding.userId);
      }
      catch { this.startupFailed=true;await this.options.notify("微信会话绑定存在历史或身份冲突，微信已暂停。请离线备份并审阅现有历史，TG 继续可用。").catch(()=>undefined);return; }
    }
    this.running=true;this.stopSignal=new AbortController();
    if(state.pending||state.deliveryReceipt) {
      try {await this.options.queue.run(()=>this.deliverPending());}
      catch {await this.options.notify("微信已确认的发送暂未完成历史保存；回执已保留，不会重发。请检查持久状态后，在微信管理中恢复待回复队列。").catch(()=>undefined);}
    }
    this.schedule();this.poll=this.pollLoop();
  }
  async stop():Promise<void>{
    this.running=false;this.stopSignal.abort();this.cancelLogin();
    if(this.flushTimer)clearTimeout(this.flushTimer);
    await this.poll;await this.flushing;await this.options.queue.drain();
  }
  async availableTarget():Promise<string|undefined>{if(this.startupFailed)return undefined;const s=await this.options.store.load();return !s.invalid&&!s.deliveryReceipt&&s.context?s.binding?.userId:undefined;}
  async status():Promise<string>{
    const s=await this.options.store.load();
    return !s.binding?"未绑定":s.deliveryReceipt?"已尝试发送的回复待保存历史；不会重发":s.invalid?"登录失效，需要重新扫码":s.fault?new IlinkError(s.fault.kind).message:"已绑定；接口状态正常，客户端送达需实际确认";
  }
  async choose():Promise<PanelView>{
    if(this.startupFailed)return this.panel();
    const s=await this.options.store.load();
    if(s.binding&&!s.invalid){await this.options.activate();return this.panel("主动渠道已选择微信。");}
    return this.beginLogin();
  }
  async panel(note=""):Promise<PanelView>{
    if(this.startupFailed)return {text:"微信启动已暂停：加密状态无法读取或历史/身份冲突。请在服务器检查密钥与备份，修复后重启；TG 普通聊天继续可用。",rows:[]};
    const state=await this.options.store.load();
    return {text:[note,"微信 iLink："+await this.status(),"共享普通会话；微信回复使用文字。原生引用回复、语音气泡暂不可用。","临时不可用时不将日常主动消息转发至 TG。"].filter(Boolean).join("\n"),rows:[
      [btn("选择微信",()=>this.choose()),btn("重新绑定",()=>this.beginLogin())],
      [btn("恢复微信待回复队列",async()=>{await this.retry();return this.panel("已恢复待处理消息。");})],
      ...(state.invalid?[]:[[btn("刷新状态",()=>this.panel())]])]};
  }
  private cancelLogin(){this.login?.abort.abort();this.login=undefined;}
  async beginLogin():Promise<PanelView>{
    this.cancelLogin();
    if(!await this.options.store.ready())return {text:"加密凭据存储不可用，请在服务器配置 GATEWAY_CREDENTIAL_KEY_FILE 后重试。",rows:[]};
    const state=await this.options.store.load();
    if(state.batches.length||state.pending||state.deliveryReceipt||this.processing)return this.panel("先处理完或在离线备份后审阅微信待处理队列，再重新绑定。");
    try {
      const qr=await this.api.qr();
      const login:Login={id:randomUUID(),code:qr.qrcode,base:ILINK_BASE,expires:Date.now()+300_000,abort:new AbortController()};
      this.login=login;
      // Generate locally: the QR payload is never given to a third-party QR service.
      await this.options.qrPhoto(await QRCode.toBuffer(qr.qrcode_img_content,{width:560,margin:3,errorCorrectionLevel:"M"}));
      return this.loginView(login,"等待扫码：请用你自己的微信扫描上方二维码，并在手机上确认。可在电脑 TG 展示二维码，用手机微信扫一扫；同机识别以微信实际支持为准。二维码五分钟内有效。");
    }catch{this.cancelLogin();return this.panel("二维码获取或展示失败，原主动渠道未变。请稍后重试。");}
  }
  private loginView(login:Login,text:string,verify=false):PanelView {
    const view:PanelView={text,rows:[[btn("重新获取二维码",()=>this.beginLogin()),btn("取消",async()=>{this.cancelLogin();return this.panel("已取消扫码，原主动渠道未变。");})]]};
    if(verify)view.input=async code=>{
      if(this.login!==login)return this.panel("扫码已失效。");
      if(!/^\d{4,12}$/.test(code.trim()))return this.loginView(login,"验证码格式不正确，请回复此面板重新输入手机显示的验证码。",true);
      login.verify=code.trim();return this.loginView(login,"正在验证…");
    };
    else view.follow=this.pollLogin(login);
    return view;
  }
  private async pollLogin(login:Login):Promise<PanelView>{
    await delay(1000,login.abort.signal);
    if(this.login!==login||login.abort.signal.aborted)return this.panel("扫码已取消。");
    if(Date.now()>login.expires){this.cancelLogin();return this.panel("二维码已过期，原主动渠道未变。");}
    try {
      const response=await this.api.qrStatus(login.code,login.base,login.verify,login.abort.signal);
      login.verify=undefined;
      if(this.login!==login||login.abort.signal.aborted)return this.panel("扫码已取消。");
      if(response.status==="confirmed"){
        if(!response.bot_token||!response.ilink_bot_id||!response.ilink_user_id||!response.baseurl)throw new Error();
        trustedHttps(response.baseurl,["weixin.qq.com"]);
        const binding:Binding={token:response.bot_token,botId:response.ilink_bot_id,userId:response.ilink_user_id,baseUrl:response.baseurl,telegramOwner:this.options.ownerId};
        await this.options.queue.run(async()=>{
          if(this.login!==login||login.abort.signal.aborted)throw new Error();
          await this.options.bind(this.options.ownerId,binding.userId);
          await this.options.store.mutate(s=>{s.binding=binding;s.cursor="";delete s.context;delete s.invalid;delete s.fault;delete s.faults;});
        });
        if(this.login!==login||login.abort.signal.aborted)return this.panel("扫码绑定已保存，但切换已取消；原主动渠道未变。");
        this.cancelLogin();
        try { await this.options.activate(); }
        catch { return this.panel("扫码绑定已保存，但主动渠道保存失败。请点击选择微信重试。"); }
        return this.panel("扫码绑定已保存，主动渠道已切换微信。请先在微信给 Gateway 发一条消息建立发送上下文。");
      }
      if(response.status==="scaned_but_redirect"&&response.redirect_host){
        const base=response.redirect_host.startsWith("https://")?response.redirect_host:"https://"+response.redirect_host;
        login.base=trustedHttps(base,["weixin.qq.com"]).origin;
      } else if(response.status==="need_verifycode")return this.loginView(login,"请回复此面板，输入微信手机上显示的配对验证码。不要发送账号密码或 API 密钥。",true);
      else if(["expired","verify_code_blocked","binded_redirect"].includes(response.status)){
        this.cancelLogin();return this.panel("扫码已过期、验证被限制或该 Bot 已绑定其他实例。请重新获取二维码；原主动渠道未变。");
      }
      return this.loginView(login,response.status==="scaned"?"已扫码，等待手机确认…":"等待扫码或微信状态更新…");
    }catch{
      if(this.login!==login)return this.panel("扫码已取消。");
      return this.loginView(login,"扫码状态暂时获取失败，正在重试；原主动渠道未变。");
    }
  }
  private async fault(kind:FaultKind,scope="poll"):Promise<void>{
    let notify=false;
    await this.options.store.mutate(s=>{
      if(kind==="auth")s.invalid=true;
      s.faults??={};const key=scope+":"+kind;
      const previous=s.faults[key];const count=(previous?.count??0)+1;
      notify=!previous?.notified&&(kind!=="network"||count>=3);
      const current={count,notified:notify||previous?.notified||false};
      s.faults[key]=current;s.fault={kind,...current};
    });
    if(notify)await this.options.notify(new IlinkError(kind).message+"\n在 TG /proactive → 微信管理处理；原主动渠道保留。").catch(()=>undefined);
  }
  private async recovered(kinds:FaultKind[]=["network","rate_limit"],scope="poll"):Promise<void>{
    const state=await this.options.store.load();
    if(!kinds.some(kind=>state.faults?.[scope+":"+kind]))return;
    let notified=false;
    await this.options.store.mutate(s=>{
      for(const kind of kinds){const key=scope+":"+kind;const old=s.faults?.[key];notified ||= Boolean(old?.notified);if(s.faults)delete s.faults[key];}
      if(s.fault&&kinds.includes(s.fault.kind)&&!Object.keys(s.faults??{}).some(key=>key.endsWith(":"+s.fault!.kind)))delete s.fault;
    });
    if(notified)await this.options.notify("微信相关连接或发送状态已恢复。过时的主动消息不会补发。").catch(()=>undefined);
  }
  private async pollLoop():Promise<void>{
    while(this.running){
      const state=await this.options.store.load();
      if(!state.binding||state.invalid||state.batches.reduce((n,b)=>n+b.events.length,0)>=100){await delay(1000,this.stopSignal.signal);continue;}
      try {
        const binding=state.binding;
        const updates=await this.api.updates(binding,state.cursor,this.stopSignal.signal);
        if(!this.running)break;
        if((await this.options.store.load()).binding?.token!==binding.token)continue;
        await this.accept(updates.msgs??[],updates.get_updates_buf,binding);
        await this.recovered();
        await delay(100,this.stopSignal.signal);
      }catch(error){
        if(!this.running)break;
        const kind=error instanceof IlinkError?error.kind:"network";
        await this.fault(kind);
        const count=(await this.options.store.load()).fault?.count??1;
        await delay(Math.min(60_000,2000*2**Math.min(count,5)),this.stopSignal.signal);
      }
    }
  }
  accept(messages:IlinkMessage[],cursor:string|undefined,binding:Binding):Promise<void>{
    return this.accepting.run(()=>this.acceptSerial(messages,cursor,binding));
  }
  private async acceptSerial(messages:IlinkMessage[],cursor:string|undefined,binding:Binding):Promise<void>{
    const accepted:IlinkMessage[]=[];const ids:string[]=[];const pageSeen=new Set<string>();
    for(const m of messages){
      if(m.message_type!==1||m.group_id||m.from_user_id!==binding.userId||m.to_user_id&&m.to_user_id!==binding.botId)continue;
      const id=messagePlatformId(m)??m.client_id;
      if(!id)continue; // No stable id: never risk duplicating an unidentifiable event.
      const key=binding.botId+":"+id;
      if(this.options.store.seen(key)||pageSeen.has(key))continue;
      pageSeen.add(key);ids.push(key);accepted.push(m);
    }
    await this.options.store.mutate(s=>{
      if(s.binding?.token!==binding.token||s.binding.userId!==binding.userId)throw new Error("微信绑定已变更，旧响应未接收。");
      const now=Date.now();
      if(s.batches.reduce((n,b)=>n+b.events.length,0)+accepted.length>100)throw new Error("微信收件队列已满；游标未推进。");
      for(const message of accepted){
        if(message.context_token)s.context=message.context_token;
        const tail=s.batches.at(-1);
        if(tail&&tail.id!==this.processing&&!tail.inbound&&tail.events.length<20&&now-tail.firstAt<(this.options.maxWaitMs??30_000)){
          tail.events.push(message);tail.lastAt=now;
        }else s.batches.push({id:randomUUID(),events:[message],firstAt:now,lastAt:now});
      }
      if(cursor)s.cursor=cursor;
    },ids);
    this.schedule();
  }
  refreshInputTiming(){this.schedule();}
  private schedule(){
    const generation=++this.scheduleGeneration;
    if(this.flushTimer)clearTimeout(this.flushTimer);
    if(!this.running||this.flushing)return;
    void this.options.store.load().then(state=>{
      const b=state.batches[0];if(!b||b.paused||state.invalid||!this.running||generation!==this.scheduleGeneration)return;
      const due=b.retryAt??Math.min(b.lastAt+(this.options.getInputDebounceMs?.()??this.options.debounceMs??8000),b.firstAt+(this.options.maxWaitMs??30_000));
      this.flushTimer=setTimeout(()=>{
        // Freeze this batch when it joins the shared FIFO; subsequent events form the next batch.
        this.processing=b.id;
        this.flushing=this.options.queue.run(()=>this.flush()).catch(()=>console.error("[ilink] queued processing failed; state retained"))
          .finally(()=>{this.processing=undefined;this.flushing=undefined;this.schedule();});
      },Math.max(0,due-Date.now()));
    }).catch(()=>console.error("[ilink] scheduling failed; persisted inbox retained"));
  }
  async retry(){await this.options.queue.run(async()=>{
    await this.deliverPending();
    await this.options.store.mutate(s=>{for(const b of s.batches){delete b.paused;b.attempts=0;b.retryAt=Date.now();}});
  });this.schedule();}
  private async attachment(item:IlinkItem,sourceId:string,remoteId=sourceId):Promise<Attachment> {
    const kind=item.type===2?"image":item.type===3?"voice":"document";
    if(![2,3,4].includes(item.type??0))return {kind:"document",error:"该微信媒体类型暂不支持；视频理解未启用，请发送文字、图片、文件或语音。"};
    const voice=item.voice_item;
    if(kind==="voice"&&typeof voice?.text==="string"&&voice.text.trim()&&voice.text.length<=32_000&&!voice.text.includes("\u0000"))return {
      kind,remoteId,sourceMessageId:sourceId,transcription:voice.text.trim(),transcriptionSource:"platform",
      ...(voice.playtime!==undefined?{durationSeconds:voice.playtime/1000}:{})};
    if(Number(item.file_item?.len)>20*1024*1024)throw new IlinkError("media");
    const bytes=await this.api.media(item);
    const name=basename(item.file_item?.file_name??(kind==="image"?"image.jpg":voice?.encode_type===7?"voice.mp3":"voice.silk"));
    const mime=kind==="image"?imageMime(bytes):kind==="voice"?(bytes.subarray(0,16).includes(Buffer.from("#!SILK"))?"audio/silk":"audio/mpeg"):fileMime(name);
    const attachment=await this.options.media.save({channel:"wechat",kind,bytes,fileName:kind==="image"?"image."+(mime==="image/png"?"png":mime==="image/webp"?"webp":"jpg"):name,mimeType:mime,remoteId});
    attachment.sourceMessageId=sourceId;
    if(voice?.playtime!==undefined)attachment.durationSeconds=voice.playtime/1000;
    return attachment;
  }
  private async reference(ref:IlinkReference,binding:Binding,earlier:PlatformMessageFragment[]):Promise<InboundMessageReference> {
    const id=platformId(ref.svr_id)??platformId(ref.message_item?.msg_id);
    const prior=id?earlier.find(item=>item.messageId===id):undefined;
    const stored=id?(prior?{messageId:id,sender:"user" as const,text:prior.text,attachments:prior.attachments}:await this.options.lookupReference?.(binding.userId,binding.botId,id)):undefined;
    const result:InboundMessageReference={messageId:id??"",sender:stored?.sender??"unknown"};
    const item=ref.message_item;
    if(item?.type===1&&item.text_item?.text)result.text=item.text_item.text;
    else if(item?.type===3&&typeof item.voice_item?.text==="string"&&item.voice_item.text.trim())result.text=item.voice_item.text.trim();
    else if(item&&[2,4].includes(item.type??0)) {
      try{result.attachments=[await this.attachment(item,"quote:"+(id??"inline"))];}
      catch{result.attachments=[{kind:item.type===2?"image":"document",fileName:item.file_item?.file_name,error:"引用附件下载失败、已过期或不可访问。"}];}
    } else if(item&&[3,5].includes(item.type??0))result.unavailableReason="引用语音或视频没有可用文字，请补充文字。";
    if(!result.text&&stored?.text)result.text=stored.text;
    if(!result.attachments?.length&&stored?.attachments?.length)result.attachments=stored.attachments;
    if(!result.text&&!result.attachments?.length) {
      // A title is only a summary supplied by the platform, never fabricated original text.
      if(ref.title?.trim())result.text="[平台引用摘要] "+ref.title.trim();
      result.unavailableReason??="引用消息原文未保存或无法定位；请补充原文。";
    }
    if(ref.partial_text&&result.text) {
      const selected=partialQuote(stored?.text??result.text,ref.partial_text);
      if(selected!==undefined){result.text=selected;result.partial=true;}
      else result.unavailableReason="部分引用范围未能核对；显示的是当前可用引用文字，不能据此猜测选中片段。";
    }
    return result;
  }
  private async normalize(batch:IlinkBatch,binding:Binding):Promise<InboundMessage>{
    const parts:string[]=[];const attachments:Attachment[]=[];const platformMessages:PlatformMessageFragment[]=[];
    for(let n=0;n<batch.events.length;n++){
      const message=batch.events[n]!;parts.push("[微信消息 "+(n+1)+"]");
      const id=messagePlatformId(message);
      const fragment:PlatformMessageFragment={accountId:binding.botId,conversationId:binding.userId,direction:"inbound",...(id?{messageId:id}:{}),text:""};
      const body:string[]=[];
      for(let itemIndex=0;itemIndex<(message.item_list?.length??0);itemIndex++) {
        const item=message.item_list![itemIndex]!;
        if(item.ref_msg){const reference=await this.reference(item.ref_msg,binding,platformMessages);(fragment.references??=[]).push(reference);parts.push(renderReference(reference));}
        if(item.type===1){if(item.text_item?.text){parts.push(item.text_item.text);body.push(item.text_item.text);}continue;}
        const kind=item.type===2?"image":item.type===3?"voice":"document";
        try {
          const sourceId=id??message.client_id??batch.id;
          // Opaque media identity is already persisted in the inbox and used by both old and
          // current ASR readers. Scope it before the first paid attempt; do not change an
          // already-normalized batch on retry, which would invalidate its attempt ledger.
          const remoteId="ilink:"+createHash("sha256").update(JSON.stringify([
            binding.telegramOwner,binding.botId,binding.userId,"inbound",
            id?"platform":message.client_id?"client":"batch",sourceId,itemIndex,
          ])).digest("hex");
          const attachment=await this.attachment(item,sourceId+":"+itemIndex,remoteId);
          attachments.push(attachment);(fragment.attachments??=[]).push(attachment);
          const marker="[附件索引 "+attachments.length+"]";parts.push(marker);body.push(marker);
          if(!attachment.error)await this.recovered(["media"]);
        }catch{
          const attachment:Attachment={kind,error:"微信附件下载、解密失败、格式不支持或超过 20MB，请重发较小文件。"};
          attachments.push(attachment);(fragment.attachments??=[]).push(attachment);parts.push("[本条附件处理失败]");body.push("[本条附件处理失败]");await this.fault("media");
        }
      }
      fragment.text=body.join("\n");platformMessages.push(fragment);
    }
    return {channel:"wechat",conversationId:binding.userId,senderId:binding.userId,messageId:"ilink:"+batch.id,text:parts.join("\n"),receivedAt:new Date(batch.events.at(-1)?.create_time_ms??batch.lastAt).toISOString(),attachments,platformMessages};
  }
  async flush():Promise<void>{
    const state=await this.options.store.load();const b=state.batches[0];
    if(!b||b.paused||state.invalid||!state.binding||!this.handler){await this.settleDeliveryReceipt();return;}
    this.processing=b.id;
    try {
      await this.settleDeliveryReceipt();
      const inbound=b.inbound??await this.normalize(b,state.binding);
      await this.options.store.mutate(s=>{s.batches.find(x=>x.id===b.id)!.inbound=inbound;});
      const result=normalizeInboundReply(await this.handler(inbound));
      if(result?.kind==="retry"||result?.kind==="pause"){
        await this.defer(b.id,result);return;
      }
      await this.options.store.mutate(s=>{
        s.batches=s.batches.filter(x=>x.id!==b.id);
        if(result)s.pending={batchId:b.id,reply:result,userId:inbound.senderId};
      });
      await this.deliverPending();
    }catch{
      await this.defer(b.id,{kind:"retry",retryAfterMs:10_000});
    }finally{this.processing=undefined;}
  }
  private async defer(id:string,result:Extract<ReplyOutcome,{kind:"retry"|"pause"}>){
    let paused=false;
    await this.options.store.mutate(s=>{const b=s.batches.find(x=>x.id===id);if(!b)return;b.attempts=(b.attempts??0)+1;
      b.paused=result.kind==="pause"||b.attempts>=3;paused=b.paused;b.retryAt=Date.now()+(result.kind==="retry"?Math.max(5000,result.retryAfterMs):60_000);});
    if(paused)await this.options.notify("微信待回复消息已保存并暂停。额度或服务恢复后，在 TG /proactive → 微信管理 → 恢复队列。").catch(()=>undefined);
  }
  private async deliverPending(){
    if(this.options.store.supportsDeliveryReceipts())return this.deliverPendingWithReceipt();
    const pending=await this.options.store.mutate(s=>{const p=s.pending;delete s.pending;return p;});
    if(!pending)return;
    const r=pending.reply;
    if(r.kind==="model_reply" && this.options.showStageDirections) r.text=displayText(r.text,await this.options.showStageDirections());
    const sent:string[]=[];const fragments:PlatformMessageFragment[]=[];
    try {
      await this.sendChunks(pending.userId,r.text,(chunk,fragment)=>{sent.push(chunk);if(fragment)fragments.push(fragment);});
    }catch{
      if(r.kind==="model_reply") {
        if(sent.length)await this.options.delivered(pending.userId,sent.join("\n"),r.deliveryId,false,...(fragments.length?[fragments]:[]));
        else await this.options.discarded(pending.userId,r.deliveryId);
      }
      // Consumed before attempting network delivery; never replay ambiguous sends.
      return;
    }
    if(r.kind==="model_reply")await (fragments.length?this.options.delivered(pending.userId,r.text,r.deliveryId,true,fragments):this.options.delivered(pending.userId,r.text,r.deliveryId))
      .catch(()=>console.error("[ilink] acknowledged reply commit failed; not replaying send"));
  }
  private async deliverPendingWithReceipt():Promise<void>{
    await this.settleDeliveryReceipt();
    const show = await this.options.showStageDirections?.() ?? true;
    const pending=await this.options.store.mutate(s=>{
      const value=s.pending;if(!value)return;
      if(!s.binding||s.binding.userId!==value.userId||s.binding.telegramOwner!==this.options.ownerId)
        throw new Error("微信待发送回复与绑定身份不一致。");
      if(value.reply.kind==="model_reply") value.reply.text=displayText(value.reply.text,show);
      s.deliveryReceipt={...value,botId:s.binding.botId,confirmed:[],complete:false};delete s.pending;return value;
    });
    if(!pending)return;
    await this.sendReceipt(pending.batchId,pending.userId,pending.reply.text);
  }
  private async sendReceipt(batchId:string,userId:string,text:string):Promise<{fragments:PlatformMessageFragment[];failed:boolean}> {
    let failed=false;
    try {
      await this.sendChunks(userId,text,async(text,fragment)=>{
        await this.options.store.mutate(s=>{
          if(s.deliveryReceipt?.batchId!==batchId)throw new Error("微信发送回执已变更。");
          s.deliveryReceipt.confirmed.push({text,...(fragment?{fragment}:{})});
        });
      });
      await this.options.store.mutate(s=>{
        if(s.deliveryReceipt?.batchId!==batchId)throw new Error("微信发送回执已变更。");
        s.deliveryReceipt.complete=true;
      });
    }catch {
      failed=true;
      // The journal was created before the first attempt. Only durable acknowledgements can enter history.
      // An interrupted/ambiguous send is never retried, even if no acknowledgement reached local storage.
    }
    const fragments=(await this.options.store.load()).deliveryReceipt?.confirmed.flatMap(chunk=>chunk.fragment?[chunk.fragment]:[])??[];
    await this.settleDeliveryReceipt();
    return {fragments,failed};
  }
  private async settleDeliveryReceipt():Promise<void>{
    const receipt=(await this.options.store.load()).deliveryReceipt;
    if(!receipt)return;
    if(receipt.reply.kind==="model_reply") {
      if(receipt.confirmed.length) {
        const fragments=receipt.confirmed.flatMap(chunk=>chunk.fragment?[chunk.fragment]:[]);
        const text=receipt.complete?receipt.reply.text:receipt.confirmed.map(chunk=>chunk.text).join("\n");
        if(receipt.origin==="proactive") {
          if(!this.options.proactiveDelivered)throw new Error("微信主动发送回执的历史保存入口未配置。");
          await this.options.proactiveDelivered(receipt.userId,text,receipt.reply.deliveryId,receipt.at!,...(fragments.length?[fragments]:[]));
        }else await this.options.delivered(receipt.userId,text,receipt.reply.deliveryId,receipt.complete,...(fragments.length?[fragments]:[]));
      }else if(receipt.origin!=="proactive")await this.options.discarded(receipt.userId,receipt.reply.deliveryId);
    }
    // The history callback is idempotent by deliveryId; retain the journal until that callback succeeds.
    await this.options.store.mutate(s=>{
      if(s.deliveryReceipt?.batchId!==receipt.batchId)throw new Error("微信发送回执已变更。");
      delete s.deliveryReceipt;
    });
  }
  async sendText(target:string,text:string):Promise<PlatformMessageFragment[]>{
    const fragments:PlatformMessageFragment[]=[];
    await this.sendChunks(target,text,(_chunk,fragment)=>{if(fragment)fragments.push(fragment);});
    return fragments;
  }
  async sendProactiveText(target:string,text:string,_voiceText?:string,delivery?:ProactiveDelivery):Promise<PlatformMessageFragment[]>{
    if (this.options.showStageDirections) text=displayText(text,await this.options.showStageDirections());
    if(!delivery||!this.options.store.supportsDeliveryReceipts())return this.sendText(target,text);
    if(!this.options.proactiveDelivered)throw new Error("微信主动发送历史保存入口未配置。");
    await this.settleDeliveryReceipt();
    await this.options.store.mutate(s=>{
      if(!s.binding||s.binding.userId!==target||s.binding.telegramOwner!==this.options.ownerId||s.pending)
        throw new Error("微信主动发送身份不匹配或存在待回复消息。");
      s.deliveryReceipt={batchId:delivery.deliveryId,userId:target,botId:s.binding.botId,
        reply:{kind:"model_reply",text,deliveryId:delivery.deliveryId},origin:"proactive",at:delivery.at,confirmed:[],complete:false};
    });
    const result=await this.sendReceipt(delivery.deliveryId,target,text);
    if(result.failed)throw new IlinkError("network");
    return result.fragments;
  }
  private async sendChunks(target:string,text:string,ack?:(chunk:string,fragment?:PlatformMessageFragment)=>void|Promise<void>):Promise<void>{
    const state=await this.options.store.load();
    if(!state.binding||state.invalid)throw new IlinkError("auth");
    if(target!==state.binding.userId)throw new Error("微信收件人未绑定。");
    try {
      for(const chunk of splitHumanMessages(text).flatMap(bubble=>splitTelegramText(bubble,2000))){
        const receipt=await this.api.send(state.binding,state.context,chunk,randomUUID());const messageId=platformId(receipt?.messageId);
        await ack?.(chunk,messageId?{accountId:state.binding.botId,conversationId:target,direction:"outbound",messageId,text:chunk}:undefined);
      }
      await this.recovered(["network","rate_limit","context"],"send");
    }catch(error){await this.fault(error instanceof IlinkError?error.kind:"network","send");throw new IlinkError(error instanceof IlinkError?error.kind:"network");}
  }
}
function imageMime(bytes:Buffer):string {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return "image/png";
  if(bytes[0]===255&&bytes[1]===216)return "image/jpeg";
  if(bytes.subarray(0,4).toString()==="RIFF"&&bytes.subarray(8,12).toString()==="WEBP")return "image/webp";
  throw new IlinkError("media");
}
function fileMime(name:string):string {return ({".pdf":"application/pdf",".txt":"text/plain",".md":"text/markdown",".csv":"text/csv",".json":"application/json"} as Record<string,string>)[extname(name).toLowerCase()]??"application/octet-stream";}
