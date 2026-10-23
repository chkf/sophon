import { createDecipheriv, randomBytes } from "node:crypto";
import { boundedBytes, trustedHttps } from "../../util/bounded-http.js";

// Wire protocol verified against Tencent/openclaw-weixin 874637a (2.4.10).
export const ILINK_BASE = "https://ilinkai.weixin.qq.com";
export type FaultKind = "auth" | "network" | "rate_limit" | "context" | "media" | "platform";
export class IlinkError extends Error {
  constructor(readonly kind: FaultKind, readonly code?: number) {
    super({auth:"微信登录失效，请在 TG /proactive 重新扫码。",network:"微信网络暂时不可用。",rate_limit:"微信平台限流，请稍后再试。",context:"微信发送上下文受限，请先在微信给 Gateway 发一条消息。",media:"微信媒体下载、解密失败或超过 20MB。",platform:"微信平台请求失败，请在 TG 查看状态。"}[kind]);
  }
}
export interface CdnMedia { full_url?: string; encrypt_query_param?: string; aes_key?: string }
export interface IlinkPartialText { start:string; end:string; startindex:number; endindex:number; quotemd5:string }
export interface IlinkReference { message_item?:IlinkItem; title?:string; svr_id?:string; partial_text?:IlinkPartialText }
export interface IlinkItem {
  type?: number; msg_id?:string; ref_msg?:IlinkReference; text_item?: {text?:string};
  image_item?: {media?:CdnMedia;aeskey?:string};
  file_item?: {media?:CdnMedia;file_name?:string;len?:string};
  voice_item?: {media?:CdnMedia;text?:string;playtime?:number;encode_type?:number;sample_rate?:number};
}
export interface IlinkMessage {
  message_id?: string | number; client_id?:string; from_user_id?:string; to_user_id?:string;
  message_type?:number; message_state?:number; group_id?:string; create_time_ms?:number;
  context_token?:string; item_list?:IlinkItem[];
}
export interface Binding { token:string; botId:string; userId:string; baseUrl:string; telegramOwner:string }
export interface QrStatus { status:string; bot_token?:string; ilink_bot_id?:string; ilink_user_id?:string; baseurl?:string; redirect_host?:string }
export interface Updates { msgs?:IlinkMessage[]; get_updates_buf?:string; longpolling_timeout_ms?:number }
export interface IlinkSendReceipt { messageId?:string }
export interface IlinkClient {
  qr():Promise<{qrcode:string;qrcode_img_content:string}>;
  qrStatus(code:string,base:string,verify?:string,signal?:AbortSignal):Promise<QrStatus>;
  updates(binding:Binding,cursor:string,signal?:AbortSignal):Promise<Updates>;
  send(binding:Binding,context:string|undefined,text:string,clientId:string):Promise<IlinkSendReceipt|void>;
  media(item:IlinkItem):Promise<Buffer>;
}
/** Quote integer tokens before parsing; never rewrite a number embedded in a JSON string. */
export function parseIlinkJson(raw:string):unknown {
  return JSON.parse(raw.replace(/"(?:\\.|[^"\\])*"|\b\d{16,}\b/g, token => token.startsWith('"') ? token : '"'+token+'"'));
}
function checked(payload:unknown):Record<string,unknown> {
  if(!payload || typeof payload!=="object" || Array.isArray(payload))throw new IlinkError("platform");
  const p=payload as Record<string,unknown>;
  const code=Number(p.errcode)||Number(p.ret)||0;
  if(code) {
    // -14 is the official client's session-timeout code. Other limits are not guessed by age.
    const detail=String(p.errmsg??"");
    const kind:FaultKind=code===-14?"auth":/context[_ -]?token|发送窗口|上下文.*(?:过期|失效)|reply window/i.test(detail)?"context":/rate.?limit|too many|频率|限流/i.test(detail)?"rate_limit":"platform";
    throw new IlinkError(kind,code);
  }
  return p;
}
export class IlinkApi implements IlinkClient {
  constructor(private readonly fetcher:typeof fetch=fetch) {}
  private async request(base:string,path:string,body?:unknown,token?:string,signal?:AbortSignal):Promise<Record<string,unknown>> {
    const url=new URL(path,trustedHttps(base,["weixin.qq.com"]));
    const timeout=AbortSignal.timeout(path.includes("getupdates")||path.includes("get_qrcode_status")?40_000:20_000);
    try {
      const response=await this.fetcher(url,{method:body===undefined?"GET":"POST",redirect:"error",
        headers:{"iLink-App-Id":"bot","iLink-App-ClientVersion":String((2<<16)|(4<<8)|10),
          ...(body===undefined?{}:{"content-type":"application/json",AuthorizationType:"ilink_bot_token","X-WECHAT-UIN":Buffer.from(String(randomBytes(4).readUInt32BE())).toString("base64")}),
          ...(token?{Authorization:"Bearer "+token}:{})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal?AbortSignal.any([timeout,signal]):timeout});
      if(!response.ok) { await response.body?.cancel(); throw new IlinkError(response.status===429?"rate_limit":response.status===401?"auth":response.status>=500?"network":"platform",response.status); }
      return checked(parseIlinkJson((await boundedBytes(response,2*1024*1024)).toString("utf8")));
    } catch(error) {
      if(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) && !signal?.aborted && path.includes("getupdates")) return {};
      if(error instanceof IlinkError)throw error; throw new IlinkError("network"); }
  }
  private body(value:Record<string,unknown>) { return {...value,base_info:{channel_version:"2.4.10",bot_agent:"Sophon/0.1.0"}}; }
  async qr() {
    const p=await this.request(ILINK_BASE,"/ilink/bot/get_bot_qrcode?bot_type=3",{local_token_list:[]});
    if(typeof p.qrcode!=="string"||typeof p.qrcode_img_content!=="string"||p.qrcode_img_content.length>4096)throw new IlinkError("platform");
    return {qrcode:p.qrcode,qrcode_img_content:p.qrcode_img_content};
  }
  async qrStatus(code:string,base:string,verify?:string,signal?:AbortSignal):Promise<QrStatus> {
    return await this.request(base,"/ilink/bot/get_qrcode_status?"+new URLSearchParams({qrcode:code,...(verify?{verify_code:verify}:{})}),undefined,undefined,signal) as unknown as QrStatus;
  }
  async updates(binding:Binding,cursor:string,signal?:AbortSignal):Promise<Updates> {
    return await this.request(binding.baseUrl,"/ilink/bot/getupdates",this.body({get_updates_buf:cursor}),binding.token,signal) as Updates;
  }
  async send(binding:Binding,context:string|undefined,text:string,clientId:string):Promise<IlinkSendReceipt> {
    if(!context)throw new IlinkError("context");
    const result=await this.request(binding.baseUrl,"/ilink/bot/sendmessage",this.body({msg:{from_user_id:"",to_user_id:binding.userId,
      client_id:clientId,message_type:2,message_state:2,context_token:context,item_list:[{type:1,text_item:{text}}]}}),binding.token);
    const messageId=platformId(result.message_id);
    return messageId?{messageId}:{};
  }
  async media(item:IlinkItem):Promise<Buffer> {
    try {
      const data=item.image_item??item.file_item??item.voice_item; const media=data?.media;
      if(!media)throw new Error();
      const url=media.full_url??("https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param="+encodeURIComponent(media.encrypt_query_param??""));
      trustedHttps(url,["weixin.qq.com"]);
      const response=await this.fetcher(url,{signal:AbortSignal.timeout(45_000),redirect:"error"});
      if(!response.ok) { await response.body?.cancel(); throw new Error(); }
      const bytes=await boundedBytes(response,20*1024*1024+16);
      const hex=item.image_item?.aeskey;
      const encoded=hex?Buffer.from(hex,"hex"):media.aes_key?Buffer.from(media.aes_key,"base64"):undefined;
      if(!encoded) {if(item.type!==2||bytes.length>20*1024*1024)throw new Error();return bytes;}
      const key=encoded.length===32&&/^[a-f\d]{32}$/i.test(encoded.toString())?Buffer.from(encoded.toString(),"hex"):encoded;
      if(key.length!==16)throw new Error();
      const decipher=createDecipheriv("aes-128-ecb",key,null);
      const plain=Buffer.concat([decipher.update(bytes),decipher.final()]);
      if(plain.length>20*1024*1024)throw new Error();
      return plain;
    } catch { throw new IlinkError("media"); }
  }
}
/** Unsafe JS numbers cannot be repaired after precision loss; keep absent IDs absent. */
export function platformId(value:unknown):string|undefined {
  if(typeof value==="string"&&value.trim())return value.trim();
  if(typeof value==="number"&&Number.isSafeInteger(value)&&value>=0)return String(value);
  return undefined;
}
export function messagePlatformId(message:IlinkMessage):string|undefined {
  return platformId(message.message_id)??message.item_list?.map(item=>platformId(item.msg_id)).find(Boolean);
}
