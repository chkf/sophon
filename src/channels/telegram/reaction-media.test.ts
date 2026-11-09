import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareReactionMedia } from './reaction-media.js';
import { deliverPreparedReply } from './delivery.js';
import type { TelegramApiClient } from './types.js';
import type { TelegramSticker } from '../types.js';
const base: TelegramSticker = {fileId:'synthetic_asset',accountId:'telegram-bot:70002',chatId:'70001',format:'animated'};
let available = true;
try { execFileSync('ffmpeg',['-version'],{stdio:'ignore'}); execFileSync('ffprobe',['-version'],{stdio:'ignore'}); } catch { available = false; }
test('native animated sticker retains its ID without downloading', async () => {
  const result = await prepareReactionMedia({} as TelegramApiClient,base);
  assert.equal(result.media,base.fileId); assert.equal(result.method,'sendSticker');
});
test('oversized reaction fails before download',async () => {
  let downloads = 0;
  const api = {getFile:async()=>({file_path:'asset',file_size:21*1024*1024}),downloadFile:async()=>{downloads++;return new Uint8Array();}} as unknown as TelegramApiClient;
  await assert.rejects(prepareReactionMedia(api,{...base,format:'static'}),/20MB/);
  assert.equal(downloads,0);
});
for (const format of ['image','static','video','gif_document','mp4_document'] as const) test(`synthetic ${format} is converted and uploaded once`,{skip:!available},async t => {
  const root=await mkdtemp(join(tmpdir(),'reaction-fixture-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const still=['image','static'].includes(format);
  const input=join(root,still?'sample.png':'sample.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=64x48:r=10',...(still?['-frames:v','1']:['-t','1','-c:v','libx264']),'-threads','1',input]);
  const bytes=new Uint8Array(await readFile(input)); let attempts=0;
  const api:TelegramApiClient={getFile:async()=>({file_path:'synthetic/source',file_size:bytes.length}),downloadFile:async()=>bytes,
    async call<T>(method,body){attempts++;assert.equal(method,'sendSticker');assert.ok(body.sticker instanceof File);throw new Error('Synthetic delivery uncertainty');}};
  const sticker={...base,format};
  const media=await prepareReactionMedia(api,sticker);
  assert.equal(media.method,'sendSticker'); assert.ok(media.media instanceof File);
  assert.equal(media.media.type,still?'image/webp':'video/webm');
  assert.ok(media.media.size <= (still?512:256)*1024);
  let failures=0;
  await deliverPreparedReply(api,{kind:'model_reply',chatId:base.chatId,senderId:base.chatId,text:'',deliveryId:'synthetic-delivery',sticker},
    {onReplyDeliveryFailed:()=>{failures++;}},async()=>{},base.accountId);
  assert.equal(attempts,1);assert.equal(failures,1);
});
test('long animation retains full duration through animation upload',{skip:!available},async t=>{
  const root=await mkdtemp(join(tmpdir(),'reaction-long-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const input=join(root,'source.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=green:s=64x48:r=10','-t','4','-c:v','libx264','-threads','1',input]);
  const api={getFile:async()=>({file_path:'synthetic/source'}),downloadFile:async()=>new Uint8Array(await readFile(input))} as unknown as TelegramApiClient;
  const media=await prepareReactionMedia(api,{...base,format:'mp4_document'});
  assert.equal(media.method,'sendAnimation'); assert.ok(media.media instanceof File);
  const {writeFile}=await import('node:fs/promises');const output=join(root,'output.mp4');await writeFile(output,new Uint8Array(await media.media.arrayBuffer()));
  const duration=Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',output],{encoding:'utf8'}));
  assert.ok(duration >= 3.9);
});
test('image collection accepts owner originals and excludes another sender',async t=>{
 const {TelegramAdapter}=await import('./adapter.js');const {MediaStore}=await import('../../media/store.js');
 const root=await mkdtemp(join(tmpdir(),'reaction-collection-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const api:TelegramApiClient={async call<T>(){return {} as T;},getFile:async()=>({file_path:'synthetic/diagram.png'}),downloadFile:async()=>new Uint8Array([1,2,3])};
 const adapter=new TelegramAdapter({token:'70002:synthetic-token',ownerId:'70001',dataDir:root,mediaStore:new MediaStore(root),api});t.after(()=>adapter.stop());
 type Message=import('./types.js').TelegramMessage;
 const collect=(m:Message)=>(adapter as unknown as {collectAttachments(message:Message):Promise<import('../types.js').Attachment[]>}).collectAttachments(m);
 for(const sender of [70001,70003]){
  const items=await collect({message_id:1,date:1,chat:{id:70001,type:'private'},from:{id:sender},document:{file_id:'synthetic_image',file_name:'diagram.png',mime_type:'image/png'}});
  assert.equal(items[0]?.sticker?.format,sender===70001?'image':undefined);
 }
});
