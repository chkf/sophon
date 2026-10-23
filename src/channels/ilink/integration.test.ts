import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createCipheriv} from 'node:crypto';
import {IlinkAdapter} from './adapter.js';
import {IlinkStore} from './store.js';
import {IlinkApi,IlinkError,parseIlinkJson,type Binding,type IlinkMessage} from './api.js';
import {SerialQueue} from '../../util/serial-queue.js';
import {SessionStore} from '../../sessions/store.js';
import {MediaStore} from '../../media/store.js';
import {Gateway} from '../../gateway.js';
import {localContext} from '../../core/context-fixture.js';
import {TelegramAdapter} from '../telegram/adapter.js';
import {createCredentialEncryption} from '../../runtime/siwc/credential-encryption.js';
const binding:Binding={token:'fixture-secret',botId:'bot',userId:'wx-owner',baseUrl:'https://ilinkai.weixin.qq.com',telegramOwner:'123'};
const inbound=(id:string,text:string):IlinkMessage=>({message_id:id,from_user_id:'wx-owner',to_user_id:'bot',message_type:1,create_time_ms:Date.now(),context_token:'context-secret',item_list:[{type:1,text_item:{text}}]});
async function fixture(run:(f:any)=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),'ilink-test-'));await writeFile(join(root,'key'),randomBytes(32).toString('base64'),{mode:0o600});
  const encryption=createCredentialEncryption(process.platform,join(root,'key'));
  const store=new IlinkStore(root,encryption);const sessions=new SessionStore(root);const queue=new SerialQueue();
  const notices:string[]=[],sent:string[]=[];let active='telegram';
  const api:any={qr:async()=>({qrcode:'qr-fixture',qrcode_img_content:'https://weixin.qq.com/fixture'}),qrStatus:async()=>({status:'wait'}),
    updates:async(_b:any,_c:any,signal:AbortSignal)=>new Promise(resolve=>{if(signal.aborted)resolve({});else signal.addEventListener('abort',()=>resolve({}),{once:true});}),
    send:async(_b:any,_c:any,text:string)=>{sent.push(text);},media:async()=>Buffer.from('file fixture')};
  const options={ownerId:'123',store,media:new MediaStore(join(root,'media')),queue,api,
    bind:(tg:string,wx:string)=>sessions.bindOwnerSession(tg,wx),activate:async()=>{active='wechat';},notify:async(text:string)=>{notices.push(text);},qrPhoto:async()=>{},
    delivered:async()=>{},discarded:async()=>{},debounceMs:2,maxWaitMs:10};
  const adapter=new IlinkAdapter(options);
  try{await run({root,store,sessions,queue,api,adapter,options,notices,sent,encryption,active:()=>active});}
  finally{await adapter.stop();store.close();sessions.close();await rm(root,{recursive:true,force:true});}
}
test('TG → iLink → TG preserves canonical runtime/checkpoint key, complete transcript and media references',()=>fixture(async f=>{
  const {sessions}=f;const image={kind:'image',path:'/fixture/image.png'};
  await sessions.append('telegram','123','123',[{id:'original',role:'user',content:'旧 TG 历史',at:new Date().toISOString(),attachments:[image]}]);
  await sessions.bindOwnerSession('123','wx-owner');
  const keys:string[]=[],histories:any[]=[],settled:string[]=[];
  const runtime={reply:async(r:any)=>{keys.push(r.sessionId);histories.push(await r.history.readRange(0,50));return {text:'答复 '+keys.length};},commitSession:async(key:string)=>{settled.push(key);}};
  const gateway=new Gateway(runtime as any,sessions,{load:async()=>localContext()} as any);
  for(const [n,channel,id] of [[1,'telegram','123'],[2,'wechat','wx-owner'],[3,'telegram','123']] as const){
    const result:any=await gateway.handle({channel,conversationId:id,senderId:id,messageId:String(n),text:'问题 '+n,receivedAt:new Date().toISOString(),attachments:[]});
    await gateway.commitDeliveredAssistant(channel,id,id,result.text,undefined,result.deliveryId);
  }
  assert.deepEqual(keys,['telegram:123','telegram:123','telegram:123']);assert.deepEqual(settled,keys);
  assert.deepEqual(histories.map(x=>x.length),[1,3,5]);assert.deepEqual(histories[2][0].attachments,[image]);
  const tg=await sessions.get('telegram','123'),wx=await sessions.get('wechat','wx-owner');assert.deepEqual(wx,tg);assert.equal(tg.messages.length,7);
  assert.equal(tg.messages[3].source.channel,'wechat');assert.equal(tg.senderId,'123');
  await assert.rejects(sessions.append('wechat','wx-owner','stranger',[{role:'user',content:'bad',at:new Date().toISOString()}]),/mismatch/);
  assert.equal((await sessions.summary()).total,1);
}));
test('binding is additive, survives reopen, refuses owner changes and never merges preexisting WeChat history',()=>fixture(async f=>{
  await f.sessions.append('wechat','historical','historical',[{role:'user',content:'retain',at:new Date().toISOString()}]);
  await assert.rejects(f.sessions.bindOwnerSession('123','historical'),/Existing WeChat/);
  assert.equal((await f.sessions.get('wechat','historical')).messages[0].content,'retain');
  await f.sessions.bindOwnerSession('123','wx-owner');
  const reopened=new SessionStore(f.root);try{assert.equal(reopened.sessionKey('wechat','wx-owner'),'telegram:123');await assert.rejects(reopened.bindOwnerSession('999','wx-owner'),/identity/);}finally{reopened.close();}
}));
test('durable iLink inbox rejects strangers/groups, deduplicates reconnects and resumes after restart',()=>fixture(async f=>{
  await f.store.mutate((s:any)=>{s.binding=binding;});
  const messages=[inbound('90071992547409939','first'),inbound('2','second'),inbound('2','second'),{...inbound('3','stranger'),from_user_id:'other'},{...inbound('4','group'),group_id:'group'}];
  await f.adapter.accept(messages,'cursor1',binding);
  assert.equal((await f.store.load()).batches.length,1);assert.equal((await f.store.load()).batches[0].events.length,2);
  const secondStore=new IlinkStore(f.root,f.encryption);const received:any[]=[];
  const second=new IlinkAdapter({...f.options,store:secondStore});(second as any).handler=async(m:any)=>{received.push(m);return {kind:'model_reply',text:'answer',deliveryId:'delivery'};};
  try{await second.accept(messages,'cursor2',binding);await f.queue.run(()=>second.flush());await second.accept(messages,'cursor3',binding);await f.queue.run(()=>second.flush());
    assert.equal(received.length,1);assert.match(received[0].text,/first[\s\S]*second/);assert.deepEqual(f.sent,['answer']);assert.equal((await secondStore.load()).cursor,'cursor3');
  }finally{await second.stop();secondStore.close();}
  const bytes=await readFile(join(f.root,'channels','ilink.sqlite'));assert.equal(bytes.includes(Buffer.from('fixture-secret')),false);
}));
test('single shared queue covers Telegram/iLink model work, sends and delivery commits',()=>fixture(async f=>{
  await f.store.mutate((s:any)=>{s.binding=binding;});const events:string[]=[];let release!:()=>void;let reached!:()=>void;
  const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>reached=r);
  const tg=new TelegramAdapter({token:'fixture',ownerId:'123',dataDir:f.root,mediaStore:f.options.media,conversationQueue:f.queue,
    api:{call:async(method:string)=>{if(method==='sendMessage')events.push('tg-send');return true;},getFile:async()=>({}),downloadFile:async()=>new Uint8Array()} as any,
    onReplyDelivered:async()=>{events.push('tg-commit-start');reached();await gate;events.push('tg-commit-end');}});
  (tg as any).handler=async()=>{events.push('tg-model');return {kind:'model_reply',text:'tg',deliveryId:'tg-id'};};
  (f.adapter as any).handler=async()=>{events.push('wx-model');return {kind:'model_reply',text:'wx',deliveryId:'wx-id'};};
  f.options.delivered=async()=>{events.push('wx-commit');};f.api.send=async()=>{events.push('wx-send');};
  await f.adapter.accept([inbound('1','wx')],'c',binding);
  const first=(tg as any).processImmediate({channel:'telegram',conversationId:'123',senderId:'123',messageId:'1',text:'tg',receivedAt:new Date().toISOString(),attachments:[]});
  await ready;const second=f.queue.run(()=>f.adapter.flush());await Promise.resolve();assert.deepEqual(events,['tg-model','tg-send','tg-commit-start']);release();await Promise.all([first,second]);
  assert.deepEqual(events,['tg-model','tg-send','tg-commit-start','tg-commit-end','wx-model','wx-send','wx-commit']);await tg.stop();
}));
test('QR cancel/expiry/verification never switches; confirmed credentials persist before activation',()=>fixture(async f=>{
  let view=await f.adapter.beginLogin();assert.equal(f.active(),'telegram');
  const cancel=view.rows.flat().find((b:any)=>b.text==='取消');await cancel.run();await view.follow;assert.equal(f.active(),'telegram');
  f.api.qrStatus=async()=>({status:'expired'});view=await f.adapter.beginLogin();await view.follow;assert.equal(f.active(),'telegram');
  f.api.qrStatus=async()=>({status:'need_verifycode'});view=await f.adapter.beginLogin();const verify=await view.follow;assert.ok(verify.input);assert.equal(f.active(),'telegram');
  f.api.qrStatus=async()=>({status:'confirmed',bot_token:binding.token,ilink_bot_id:binding.botId,ilink_user_id:binding.userId,baseurl:binding.baseUrl});
  const waiting=await verify.input('123456');await waiting.follow;assert.equal(f.active(),'wechat');assert.deepEqual((await f.store.load()).binding,binding);
  const reopened=new IlinkStore(f.root,f.encryption);try{assert.deepEqual((await reopened.load()).binding,binding);}finally{reopened.close();}
}));
test('faults are deduplicated, transient errors wait for retries, context limits never invalidate login',()=>fixture(async f=>{
  await f.store.mutate((s:any)=>{s.binding=binding;s.context='context';});
  await (f.adapter as any).fault('network');await (f.adapter as any).fault('network');assert.equal(f.notices.length,0);
  await (f.adapter as any).fault('network');await (f.adapter as any).fault('network');assert.equal(f.notices.length,1);
  await (f.adapter as any).recovered();assert.equal(f.notices.length,2);
  await (f.adapter as any).fault('context');await (f.adapter as any).fault('context');assert.equal(f.notices.length,3);assert.equal((await f.store.load()).invalid,undefined);
  await (f.adapter as any).fault('auth');await (f.adapter as any).fault('auth');assert.equal(f.notices.length,4);assert.equal((await f.store.load()).invalid,true);assert.equal(f.active(),'telegram');
}));
test('uncertain iLink delivery is consumed once and never committed as delivered',()=>fixture(async f=>{
  await f.store.mutate((s:any)=>{s.binding=binding;s.context='context';});let attempts=0,commits=0,discarded=0;
  f.api.send=async()=>{attempts++;throw new IlinkError('network');};f.options.delivered=async()=>{commits++;};f.options.discarded=async()=>{discarded++;};
  (f.adapter as any).handler=async()=>({kind:'model_reply',text:'reply',deliveryId:'d'});
  await f.adapter.accept([inbound('1','hello')],'c',binding);await f.queue.run(()=>f.adapter.flush());await f.queue.run(()=>f.adapter.flush());
  assert.equal(attempts,1);assert.equal(commits,0);assert.equal(discarded,1);assert.equal((await f.store.load()).pending,undefined);
}));
test('official POST QR, uint64 IDs, auth errors and encrypted CDN media protocol',async()=>{
  const requests:any[]=[];const key=randomBytes(16),plain=Buffer.from('file bytes');const cipher=createCipheriv('aes-128-ecb',key,null);const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
  let mode='qr';const api=new IlinkApi(async(url:any,init:any)=>{requests.push({url:String(url),init});
    if(mode==='media')return new Response(encrypted);if(mode==='auth')return Response.json({ret:-14});
    return Response.json({qrcode:'q',qrcode_img_content:'https://weixin.qq.com/qr'});
  });await api.qr();assert.equal(requests[0].init.method,'POST');assert.match(requests[0].url,/get_bot_qrcode\?bot_type=3$/);assert.deepEqual(JSON.parse(requests[0].init.body),{local_token_list:[]});assert.equal(requests[0].init.headers.Authorization,undefined);
  assert.equal((parseIlinkJson('{"message_id":18446744073709551615,"text":"number 18446744073709551615"}') as any).message_id,'18446744073709551615');
  mode='media';assert.deepEqual(await api.media({type:4,file_item:{media:{full_url:'https://novac2c.cdn.weixin.qq.com/c2c/x',aes_key:Buffer.from(key.toString('hex')).toString('base64')}}}),plain);
  await assert.rejects(api.media({type:2,image_item:{media:{full_url:'https://127.0.0.1/internal'}}}),/媒体/);
  mode='auth';await assert.rejects(api.updates(binding,''),(e:any)=>e.kind==='auth');
});

test('queued batch is frozen at admission; later messages cannot indefinitely extend it',()=>fixture(async f=>{
  await f.store.mutate((s:any)=>{s.binding=binding;});
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);const blocker=f.queue.run(()=>gate);
  const received:string[]=[];const done=new Promise<void>(resolve=>{(f.adapter as any).handler=async(m:any)=>{received.push(m.text);if(received.length===2)resolve();return {kind:'local_reply',text:'ok'};};});
  (f.adapter as any).running=true;
  await f.adapter.accept([inbound('1','first')],'c1',binding);
  await new Promise(r=>setTimeout(r,25));assert.ok((f.adapter as any).processing);
  await f.adapter.accept([inbound('2','second')],'c2',binding);assert.equal((await f.store.load()).batches.length,2);
  release();await blocker;await Promise.race([done,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('queue timeout')),2000);t.unref();})]);
  assert.match(received[0]!,/first/);assert.doesNotMatch(received[0]!,/second/);assert.match(received[1]!,/second/);
}));
test('partial iLink send records only acknowledged chunks; poll recovery cannot erase send limit',()=>fixture(async f=>{
  await f.store.mutate((s:any)=>{s.binding=binding;s.context='ctx';});let calls=0;const commits:any[]=[];
  f.api.send=async()=>{if(++calls===2)throw new IlinkError('rate_limit');};
  f.options.delivered=async(...args:any[])=>{commits.push(args);};
  (f.adapter as any).handler=async()=>({kind:'model_reply',text:'first\n\nsecond',deliveryId:'partial'});
  await f.adapter.accept([inbound('1','question')],'c',binding);await f.adapter.flush();
  assert.equal(calls,2);assert.deepEqual(commits,[['wx-owner','first','partial',false]]);
  await (f.adapter as any).recovered();assert.equal((await f.store.load()).fault.kind,'rate_limit');
  await (f.adapter as any).fault('context','send');await (f.adapter as any).fault('rate_limit','send');
  assert.equal(f.notices.filter((x:string)=>x.includes('平台限流')).length,1);
}));
test('media order and stable paths survive retry; failures and unsupported media remain explicit',()=>fixture(async f=>{
  await f.store.mutate((s:any)=>{s.binding=binding;});let downloads=0;const received:any[]=[];
  f.api.media=async()=>{downloads++;return Buffer.from('fixture text file');};
  (f.adapter as any).handler=async(m:any)=>{received.push(m);return received.length===1?{kind:'retry',retryAfterMs:0}:{kind:'local_reply',text:'ok'};};
  const file={type:4,file_item:{file_name:'notes.txt',len:'17',media:{}}};
  await f.adapter.accept([{...inbound('1','before'),item_list:[{type:1,text_item:{text:'before'}},file,{type:1,text_item:{text:'after'}}]}],'c',binding);
  await f.adapter.flush();await f.adapter.flush();assert.equal(downloads,1);assert.deepEqual(received[0].attachments,received[1].attachments);assert.match(received[0].text,/before[\s\S]*附件索引 1[\s\S]*after/);
  assert.equal(await readFile(received[0].attachments[0].localPath,'utf8'),'fixture text file');
  f.api.media=async()=>{throw new Error('download failed');};
  await f.adapter.accept([{...inbound('2','bad'),item_list:[file,{type:5}]}],'c2',binding);await f.adapter.flush();
  assert.ok(received[2].attachments[0].error);assert.match(received[2].attachments[1].error,/视频/);
}));
test('unavailable credential storage does not block TG startup and unconfigured iLink incurs no writes',()=>fixture(async f=>{
  const missing={isAvailable:async()=>false,encrypt:async()=>{throw Error('missing key');},decrypt:async()=>{throw Error('missing key');}};
  const emptyRoot=join(f.root,'empty');const emptyStore=new IlinkStore(emptyRoot,missing as any);const empty=new IlinkAdapter({...f.options,store:emptyStore});
  try{await empty.start(async()=>undefined);assert.equal(await empty.availableTarget(),undefined);assert.match((await empty.beginLogin()).text,/加密凭据/);}finally{await empty.stop();emptyStore.close();}
  await f.store.mutate((s:any)=>{s.binding=binding;});const badStore=new IlinkStore(f.root,missing as any);const bad=new IlinkAdapter({...f.options,store:badStore});
  try{await bad.start(async()=>undefined);assert.equal(await bad.availableTarget(),undefined);assert.match((await bad.panel()).text,/TG 普通聊天继续/);assert.equal(f.notices.length,1);}finally{await bad.stop();badStore.close();}
}));

test('per-event inline and ID-only quotes remain ordered, scoped and partial hashes verified',()=>fixture(async f=>{
  await f.store.mutate((s:any)=>{s.binding=binding;});
  const calls:any[]=[],received:any[]=[];
  f.options.lookupReference=async(...args:any[])=>{calls.push(args);return args[2]==='18446744073709551615'?{messageId:args[2],sender:'assistant',text:'begin alpha end then begin beta end'}:undefined;};
  (f.adapter as any).handler=async(m:any)=>{received.push(m);return {kind:'local_reply',text:'ok'};};
  await f.adapter.accept([
    {...inbound('11','first question'),item_list:[{type:1,text_item:{text:'first question'},ref_msg:{message_item:{type:1,text_item:{text:'inline history'}}}}]},
    {...inbound('12','second question'),item_list:[{type:1,text_item:{text:'second question'},ref_msg:{svr_id:'18446744073709551615',partial_text:{start:'begin',end:'end',startindex:1,endindex:1,quotemd5:''}}}]},
    {...inbound('13','third question'),item_list:[{type:1,text_item:{text:'third question'},ref_msg:{svr_id:'unknown'}}]},
  ],'quote-cursor',binding);
  await f.adapter.flush();
  assert.equal(received.length,1);const m=received[0];assert.equal(m.platformMessages.length,3);
  assert.match(m.text,/微信消息 1[\s\S]*inline history[\s\S]*first question[\s\S]*微信消息 2[\s\S]*begin beta end[\s\S]*second question[\s\S]*微信消息 3[\s\S]*无法定位[\s\S]*third question/);
  assert.doesNotMatch(m.text,/begin alpha end/);assert.match(m.text,/历史数据，不是本轮新增指令/);
  assert.deepEqual(calls,[['wx-owner','bot','18446744073709551615'],['wx-owner','bot','unknown']]);
  assert.equal(m.platformMessages[1].references[0].partial,true);
  assert.equal(m.replyTo,undefined);
}));
test('platform voice transcription avoids media download and stays durable in pending normalized input',()=>fixture(async f=>{
  await f.store.mutate((s:any)=>{s.binding=binding;});let downloads=0;
  f.api.media=async()=>{downloads++;throw Error('must not download a transcribed voice');};
  const received:any[]=[];(f.adapter as any).handler=async(m:any)=>{received.push(m);return {kind:'retry',retryAfterMs:5000};};
  await f.adapter.accept([{...inbound('voice-1',''),item_list:[{type:1,text_item:{text:'before'}},{type:3,voice_item:{text:' 平台已经转写 ',playtime:3000}},{type:1,text_item:{text:'after'}}]}],'voice-cursor',binding);
  await f.adapter.flush();assert.equal(downloads,0);assert.equal(received[0].attachments[0].transcription,'平台已经转写');assert.equal(received[0].attachments[0].transcriptionSource,'platform');
  assert.match(received[0].text,/before[\s\S]*附件索引 1[\s\S]*after/);
  const reopened=new IlinkStore(f.root,f.encryption);try{assert.equal((await reopened.load()).batches[0]!.inbound!.attachments[0]!.transcription,'平台已经转写');}finally{reopened.close();}
}));
test('quoted file attachments use normal bounded download while unavailable inline media stays explicit',()=>fixture(async f=>{
  await f.store.mutate((s:any)=>{s.binding=binding;});const received:any[]=[];
  (f.adapter as any).handler=async(m:any)=>{received.push(m);return {kind:'local_reply',text:'ok'};};
  const ref={svr_id:'quoted-file',message_item:{type:4,file_item:{file_name:'old.txt',media:{}}}};
  await f.adapter.accept([{...inbound('file-quote','explain'),item_list:[{type:1,text_item:{text:'explain'},ref_msg:ref}]}],'file-cursor',binding);await f.adapter.flush();
  const file=received[0].platformMessages[0].references[0].attachments[0];assert.equal(await readFile(file.localPath,'utf8'),'file fixture');assert.equal(received[0].attachments.length,0);
  f.api.media=async()=>{throw Error('expired');};
  await f.adapter.accept([{...inbound('expired-quote','explain'),item_list:[{type:1,text_item:{text:'explain'},ref_msg:ref}]}],'expired-cursor',binding);await f.adapter.flush();
  assert.match(received[1].text,/引用附件下载失败/);assert.equal(received[1].platformMessages[0].references[0].attachments[0].localPath,undefined);
}));
test('confirmed outbound fragment IDs attach to exact chunks, partial failures retain only acknowledgements',()=>fixture(async f=>{
  await f.store.mutate((s:any)=>{s.binding=binding;s.context='ctx';});const delivered:any[]=[];let n=0;
  f.api.send=async()=>({messageId:String(++n)});f.options.delivered=async(...args:any[])=>{delivered.push(args);};
  (f.adapter as any).handler=async()=>({kind:'model_reply',text:'first\n\nsecond',deliveryId:'delivery'});
  await f.adapter.accept([inbound('out-1','question')],'out-cursor',binding);await f.adapter.flush();
  assert.equal(delivered[0][3],true);assert.deepEqual(delivered[0][4].map((x:any)=>[x.messageId,x.text]),[['1','first'],['2','second']]);
  f.api.send=async()=>{if(++n===4)throw new IlinkError('network');return {messageId:String(n)};};
  await f.adapter.accept([inbound('out-2','question')],'out-cursor-2',binding);await f.adapter.flush();
  assert.equal(delivered[1][3],false);assert.deepEqual(delivered[1][4].map((x:any)=>[x.messageId,x.text]),[['3','first']]);
  assert.equal(n,4);
}));
test('send API returns lossless acknowledged uint64 IDs and leaves missing IDs absent',async()=>{
  let present=true;
  const api=new IlinkApi(async()=>new Response(present?'{"message_id":18446744073709551615,"ret":0}':'{"ret":0}',{headers:{'content-type':'application/json'}}));
  assert.deepEqual(await api.send(binding,'ctx','text','client'),{messageId:'18446744073709551615'});
  present=false;assert.deepEqual(await api.send(binding,'ctx','text','client'),{});
});
