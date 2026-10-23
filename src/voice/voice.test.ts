import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {VoiceService} from './service.js';import {TelegramVoiceTransport} from './telegram.js';
import {TelegramAdapter} from '../channels/telegram/adapter.js';import {VoiceStore} from './store.js';import {VoiceSettingsStore,ASR_MODELS,TTS_MODELS,VOICES,explicitVoiceRequest,speakable} from './settings.js';
import {VoicePanel} from './panel.js';import {BailianSpeech,voiceEndpoint} from './bailian.js';import {LightweightAudio} from './audio.js';
import {TelegramBotApiError,TelegramBotApi} from '../channels/telegram/api.js';
import {deliverPreparedReply} from '../channels/telegram/delivery.js';import {voiceTool,VoiceTurn} from './tool.js';
async function fixture(run:(f:any)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'voice-test-'));const settings=new VoiceSettingsStore(root),store=new VoiceStore(root);let asr=0,tts=0;
  const usedInstructions:string[]=[];const client={configured:()=>true,transcribe:async()=>{asr++;return '中英混合 memory 测试';},synthesize:async(_text:string,_settings:unknown,instruction?:string)=>{tts++;if(instruction)usedInstructions.push(instruction);return Buffer.from('wav');}};
  const codec={prepare:async()=>Buffer.from('wav'),opus:async()=>Buffer.from('OggS')};
  const speech=new VoiceService(settings,store,client,codec);const telegramVoice=new TelegramVoiceTransport(speech,'123',codec);const calls:any[]=[];
  const api={call:async(method:string,body:any)=>{calls.push({method,body});return {message_id:42};}};
  try{await run({root,settings,store,client,codec,speech,telegramVoice,api,calls,count:()=>({asr,tts}),instructions:()=>usedInstructions});}finally{store.close();await rm(root,{recursive:true,force:true});}}
const message={channel:'wechat',conversationId:'wx',senderId:'wx',messageId:'1',text:'before\n[附件索引 1]\nafter',receivedAt:new Date().toISOString(),attachments:[{kind:'voice',localPath:'/fixture',remoteId:'voice-id',durationSeconds:3,mimeType:'audio/silk'}]};
test('default settings and browsing panel never call paid services; settings persist separately',()=>fixture(async f=>{
  await writeFile(join(f.root,'chat-model-fixture.json'),'unchanged');
  await new VoicePanel(f.speech,()=>Promise.resolve(false)).open();assert.deepEqual(f.count(),{asr:0,tts:0});
  await assert.rejects(f.speech.preprocess(message),/尚未/);assert.equal(await f.telegramVoice.send(f.api,'123','你好','a'),false);assert.deepEqual(f.count(),{asr:0,tts:0});
  await f.settings.update({asr:true,tts:true,proactive:true,voice:'Serena'});assert.deepEqual(await new VoiceSettingsStore(f.root).get(),await f.settings.get());assert.equal(await readFile(join(f.root,'chat-model-fixture.json'),'utf8'),'unchanged');
}));
test('voice daily caps are optional and can be restored without changing paid switches',()=>fixture(async f=>{
  assert.equal((await f.settings.get()).asrDailyLimit,null);
  assert.equal((await f.settings.get()).ttsDailyLimit,null);
  await f.settings.update({tts:true});
  for(let i=0;i<31;i++)assert.equal(await f.telegramVoice.send(f.api,'123','语音测试',`unlimited-${i}`),true);
  assert.equal(f.count().tts,31);
  const panel=new VoicePanel(f.speech,()=>Promise.resolve(false));
  const choices=await (await panel.open()).rows.flat().find((item:any)=>item.text==='合成每日上限')!.run!();
  await choices.rows.flat().find((item:any)=>item.text==='30 次')!.run!();
  assert.equal((await f.settings.get()).ttsDailyLimit,30);
  assert.equal(await f.telegramVoice.send(f.api,'123','已达上限','capped'),false);
  assert.equal(f.count().tts,31,'rejected attempts must not call the paid API');
  assert.match(f.store.status('tts'),/每日上限/);
  const unlimited=await (await panel.open()).rows.flat().find((item:any)=>item.text==='合成每日上限')!.run!();
  await unlimited.rows.flat().find((item:any)=>item.text==='不限')!.run!();
  assert.equal(await f.telegramVoice.send(f.api,'123','恢复语音','resumed'),true);
  assert.equal(f.count().tts,32);
  await assert.rejects(f.settings.update({ttsDailyLimit:1}),/上限/);
}));
test('ASR 3.1 is the fresh default; old selection survives setting edits and no calls occur in model menu',()=>fixture(async f=>{
  assert.equal((await f.settings.get()).asrModel,'qwen-audio-3.1-asr-flash');
  const panel=await (await new VoicePanel(f.speech,()=>Promise.resolve(false)).open()).rows[0]![1]!.run!();
  assert.deepEqual(panel.rows.flat().map((button:any)=>button.text),[...ASR_MODELS]);
  await f.settings.update({asrModel:'qwen3-asr-flash'});
  assert.equal((await new VoiceSettingsStore(f.root).get()).asrModel,'qwen3-asr-flash');
  await f.settings.update({tts:true});
  assert.equal((await f.settings.get()).asrModel,'qwen3-asr-flash');
  await panel.rows.flat().find((button:any)=>button.text==='qwen-audio-3.1-asr-flash')!.run!();
  assert.equal((await new VoiceSettingsStore(f.root).get()).asrModel,'qwen-audio-3.1-asr-flash');
  assert.deepEqual(f.count(),{asr:0,tts:0});
}));
test('voice model instructions stay concise without repeating fixed voice and model controls',()=>{
  assert.doesNotMatch(voiceTool.description,/音色|语音模型/);
  assert.doesNotMatch((voiceTool.parameters as any).properties.instruction.description,/音色|语音模型/);
  assert.doesNotMatch(new VoiceTurn().guidance,/音色|模型只由/);
});
test('Plus can be selected and the owner-selected voice persists without any synthesis',()=>fixture(async f=>{
  const model="qwen-audio-3.1-tts-plus";
  assert.ok(TTS_MODELS.includes(model));
  assert.ok(VOICES[model]?.includes("longanlingxin_v3.1"));
  const panel=new VoicePanel(f.speech,()=>Promise.resolve(false));
  const base=await panel.open();
  const modelPanel=await base.rows[1]![1]!.run!();
  const modelButton=modelPanel.rows.flat().find((b:any)=>b.text===model);
  assert.ok(modelButton?.run);
  await modelButton.run();
  const settings=await f.settings.get();
  assert.equal(settings.ttsModel,model);
  assert.equal(settings.voice,"longanlingxin_v3.1");
  const voicePanel=await (await panel.open()).rows[2]![0]!.run!();
  assert.ok(voicePanel.rows.flat().some((b:any)=>b.text==="xunanchuan_v3.1"));
  await voicePanel.rows.flat().find((b:any)=>b.text==="longanhuan_v3.1")!.run!();
  assert.equal((await f.settings.get()).voice,"longanhuan_v3.1");
  await new VoiceSettingsStore(f.root).update({tts:true});
  assert.equal((await new VoiceSettingsStore(f.root).get()).voice,"longanhuan_v3.1");
  assert.equal((await new VoiceSettingsStore(f.root).get()).ttsModel,model);
  assert.equal((await f.settings.get()).voice,"longanhuan_v3.1");
  assert.deepEqual(f.count(),{asr:0,tts:0});
  await assert.rejects(f.settings.update({voice:"Cherry"}),/设置无效/);
}));
test('ASR keeps source and position, caches across restart/retry, enforces duration before paid call',()=>fixture(async f=>{
  await f.settings.update({asr:true});const result=await f.speech.preprocess(message);assert.match(result.text,/before[\s\S]*语音转写 · wechat[\s\S]*memory[\s\S]*after/);assert.equal(result.messageId,'1');assert.equal(result.attachments[0].transcription,'中英混合 memory 测试');
  const reopened=new VoiceStore(f.root);try{const again=new VoiceService(f.settings,reopened,f.client,f.codec);assert.deepEqual(await again.preprocess(message),result);}finally{reopened.close();}
  await assert.rejects(f.speech.preprocess({...message,attachments:[{...message.attachments[0],remoteId:'long',durationSeconds:121}]}),/120/);assert.equal(f.count().asr,1);
  f.client.transcribe=async()=>{throw new Error('fixture ASR failed');};await assert.rejects(f.speech.preprocess({...message,attachments:[{...message.attachments[0],remoteId:'fail'}]}),/failed/);
  f.client.transcribe=async()=>{throw new Error('must not retry');};await assert.rejects(f.speech.preprocess({...message,attachments:[{...message.attachments[0],remoteId:'fail'}]}),/fixture ASR failed/);
}));
test('transport keeps the owner-selected Plus voice and forwards free-form expression to synthesis',()=>fixture(async f=>{
  const model="qwen-audio-3.1-tts-plus";
  const voice="longanhuan_v3.1";
  await f.settings.update({ttsModel:model,voice,tts:true});
  const instruction="用正常语速说话，发音清晰，句尾自然停顿。";
  const sent=await f.telegramVoice.send(f.api,"123","这是语音合成测试。","expressive",false,undefined,undefined,instruction);
  assert.equal(sent,true);
  assert.deepEqual(f.instructions(),[instruction]);
  const current=await f.settings.get();
  assert.equal(current.ttsModel,model);
  assert.equal(current.voice,voice);
  assert.deepEqual(f.count(),{asr:0,tts:1});
}));
test('older voice settings without a text-button field default to showing the button',()=>fixture(async f=>{
  const legacy={asr:false,asrModel:"qwen3-asr-flash",tts:false,ttsModel:"qwen3-tts-flash",
    voice:"Cherry",proactive:false};
  await writeFile(join(f.root,"voice","settings.json"),JSON.stringify(legacy));
  const loaded=await new VoiceSettingsStore(f.root).get();
  assert.equal(loaded.showTextButton,true);
  assert.equal(loaded.tts,false);
  const menu=new VoicePanel(f.speech,()=>Promise.resolve(false));
  const hide=(await menu.open()).rows.flat().find((item:any)=>item.text==='隐藏「查看文字」按钮');
  assert.ok(hide?.run);
  await hide.run();
  const saved=await new VoiceSettingsStore(f.root).get();
  assert.equal(saved.showTextButton,false);
  assert.equal(saved.tts,false,"button setting must not activate synthesis");
  assert.equal(saved.voice,"Cherry");
  assert.deepEqual(f.count(),{asr:0,tts:0},"legacy migration and UI selection cannot spend TTS");
}));
test('TG 查看文字 button defaults visible; hides only new buttons and survives restart without consuming TTS',()=>fixture(async f=>{
  const voicePanel=new VoicePanel(f.speech,()=>Promise.resolve(false));
  const current=await f.settings.get();
  assert.equal(current.showTextButton,true,"existing installations keep the original visible-button behavior");
  const initialPanel=await voicePanel.open();
  assert.match(initialPanel.text,/TG 语音「查看文字」按钮：显示/);
  await f.settings.update({tts:true});

  // Existing bubbles keep their original callback after the preference is changed.
  assert.equal(await f.telegramVoice.send(f.api,'123','最开始显示文字按钮。','button-before'),true);
  const firstSend=f.calls.find((entry:any)=>entry.method==='sendVoice');
  const firstButton=firstSend.body.reply_markup.inline_keyboard[0][0];
  assert.equal(firstButton.text,'查看文字');
  const beforeToggle=f.count().tts;
  const hide=initialPanel.rows.flat().find((action:any)=>action.text==='隐藏「查看文字」按钮');
  assert.ok(hide?.run);
  const hiddenPanel=await hide.run();
  assert.match(hiddenPanel.text,/TG 语音「查看文字」按钮：隐藏/);
  assert.deepEqual(f.count(),{asr:0,tts:beforeToggle},"toggling never calls paid synthesis");
  assert.equal((await new VoiceSettingsStore(f.root).get()).showTextButton,false);

  assert.equal(await f.telegramVoice.send(f.api,'123','现在发送没有按钮的气泡。','button-hidden'),true);
  const withoutButton=f.calls.filter((entry:any)=>entry.method==='sendVoice').at(-1);
  assert.equal(withoutButton.body.reply_markup,undefined,"the button markup must be absent, not an empty keyboard");
  assert.equal(f.store.job('tts:button-hidden')?.result,'sent',"disabling UI must not interfere with paid-attempt settlement");
  // Turning off NEW buttons does not invalidate an existing already-sent button.
  const callback={id:'old-voice',from:{id:123},data:firstButton.callback_data,message:{
    message_id:42,date:1,chat:{id:123,type:'private'}}};
  await f.telegramVoice.callback(callback,f.api);
  assert.equal(f.calls.filter((entry:any)=>entry.method==='editMessageCaption').length,1);

  const show=hiddenPanel.rows.flat().find((action:any)=>action.text==='显示「查看文字」按钮');
  assert.ok(show?.run);
  const visiblePanel=await show.run();
  assert.match(visiblePanel.text,/TG 语音「查看文字」按钮：显示/);
  assert.equal((await new VoiceSettingsStore(f.root).get()).showTextButton,true);
  assert.equal(await f.telegramVoice.send(f.api,'123','按钮恢复显示。','button-again'),true);
  const last=f.calls.filter((entry:any)=>entry.method==='sendVoice').at(-1);
  assert.equal(last.body.reply_markup.inline_keyboard[0][0].text,'查看文字');
}));

test('TG hidden text button also applies to preview and proactive voice, without changing audio, caption or send count',()=>fixture(async f=>{
  await f.settings.update({tts:true,proactive:true,showTextButton:false});
  const adapter=new TelegramAdapter({token:'fixture',ownerId:'123',dataDir:f.root,mediaStore:{} as never,api:f.api,
    sendVoice:(api,target,text,id,reply,onSent,instruction,preview)=>f.telegramVoice.send(api,target,text,id,preview,reply,onSent,instruction),
    sendProactiveVoice:(api,target,text)=>f.telegramVoice.proactive(api,target,text)});
  assert.equal(await adapter.previewVoice(),true);
  const preview=f.calls.filter((entry:any)=>entry.method==='sendVoice').at(-1);
  assert.equal(preview.body.caption,'音色试听');
  assert.equal(preview.body.reply_markup,undefined);
  await adapter.sendProactiveText('123','晚上好','晚上好');
  const proactive=f.calls.filter((entry:any)=>entry.method==='sendVoice').at(-1);
  assert.equal(proactive.body.reply_markup,undefined);
  assert.equal(proactive.body.caption,undefined);
  assert.equal(proactive.body.voice.type,'audio/ogg');
  assert.deepEqual(f.count(),{asr:0,tts:2});
  await adapter.stop();
}));

test('TG sendVoice keeps one original, owner-only durable view button edits caption without ASR or new messages',()=>fixture(async f=>{
  await f.settings.update({tts:true});assert.equal(await f.telegramVoice.send(f.api,'123','你好，Gateway。','reply'),true);assert.equal(await f.telegramVoice.send(f.api,'123','你好，Gateway。','reply'),true);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'sendVoice');assert.equal(f.calls[0].body.voice.type,'audio/ogg');const data=f.calls[0].body.reply_markup.inline_keyboard[0][0].callback_data;assert.ok(data.length<=64);
  const record=new VoiceStore(f.root);try{const restarted=new TelegramVoiceTransport(new VoiceService(f.settings,record,f.client,f.codec),'123',f.codec);
    const q={id:'q',from:{id:123},data,message:{message_id:42,date:1,chat:{id:123,type:'private'}}};
    await restarted.callback({...q,from:{id:456}},f.api);assert.equal(f.calls.filter((x:any)=>x.method==='editMessageCaption').length,0);
    await restarted.callback(q,f.api);await restarted.callback(q,f.api);assert.equal(f.calls.filter((x:any)=>x.method==='editMessageCaption').length,1);
    assert.equal(f.calls.find((x:any)=>x.method==='editMessageCaption').body.caption,'你好，Gateway。');assert.deepEqual(f.count(),{asr:0,tts:1});
  }finally{record.close();}
}));
test('voice failure falls back once on definitive rejection; ambiguous delivery never repeats text or TTS',()=>fixture(async f=>{
  await f.settings.update({tts:true});let fallback=0,commits=0,discarded=0;
  const pending:any={kind:'model_reply',text:'你好',voiceRequested:true,chatId:'123',senderId:'123',deliveryId:'one'};
  const callbacks={sendVoice:(api:any,target:string,text:string,id:string)=>f.telegramVoice.send(api,target,text,id),onReplyDelivered:async()=>{commits++;},onReplyDeliveryFailed:async()=>{discarded++;}};
  const rejected={call:async()=>{throw new TelegramBotApiError('sendVoice',400,'unsupported');}} as any;
  await deliverPreparedReply(rejected,pending,callbacks,async()=>{fallback++;});assert.equal(fallback,1);assert.equal(commits,1);assert.equal(discarded,0);
  const uncertain={call:async()=>{throw new Error('connection lost after POST');}} as any;
  await deliverPreparedReply(uncertain,{...pending,deliveryId:'two'},callbacks,async()=>{fallback++;});assert.equal(fallback,1);assert.equal(commits,1);assert.equal(discarded,1);
  await assert.rejects(f.telegramVoice.send(uncertain,'123','你好','two'),/不重复/);assert.equal(f.count().tts,2);
}));
test('long originals paginate in-place and repeated clicks do not flood',()=>fixture(async f=>{
  const token='a'.repeat(24);f.store.saveText(token,'123','文'.repeat(2000));f.store.sent(token,42);
  for(const page of [0,0,1,1,2])await f.telegramVoice.callback({id:'q',from:{id:123},data:'vt:'+token+':'+page,message:{message_id:42,date:1,chat:{id:123,type:'private'}}},f.api);
  const edits=f.calls.filter((x:any)=>x.method==='editMessageCaption');assert.equal(edits.length,3);assert.ok(edits.every((x:any)=>x.body.caption.length<=1024));assert.deepEqual(f.count(),{asr:0,tts:0});
}));
test('durable TTS outcomes take precedence over later settings changes and survive reopening',()=>fixture(async f=>{
  await f.settings.update({tts:true});
  assert.equal(await f.telegramVoice.send(f.api,'123','已经发送','accepted'),true);
  const uncertain={call:async()=>{throw Error('lost response');}} as any;
  await assert.rejects(f.telegramVoice.send(uncertain,'123','未知发送','unknown'),/不确定/);
  await f.settings.update({tts:false});f.client.configured=()=>false;
  const reopened=new VoiceStore(f.root);
  try {
    const transport=new TelegramVoiceTransport(new VoiceService(f.settings,reopened,f.client,f.codec),'123',f.codec);
    assert.equal(await transport.send(f.api,'123','已经发送','accepted'),true);
    await assert.rejects(transport.send(f.api,'123','未知发送','unknown'),/不重复/);
    await assert.rejects(transport.send(f.api,'456','已经发送','accepted'),/已绑定的 Telegram 用户/);
    assert.equal(f.calls.filter((call:any)=>call.method==='sendVoice').length,1);
    assert.equal(f.count().tts,2);
  }finally{reopened.close();}
}));
test('encoding failure stays a single paid attempt and cannot reach the Telegram API',()=>fixture(async f=>{
  await f.settings.update({tts:true});f.codec.opus=async()=>{throw Error('fixture codec failure');};
  assert.equal(await f.telegramVoice.send(f.api,'123','保留原文','codec-failure'),false);
  assert.equal(await f.telegramVoice.send(f.api,'123','保留原文','codec-failure'),false);
  assert.equal(f.count().tts,1);assert.equal(f.calls.length,0);
  assert.match(f.store.job('tts:codec-failure').error,/已使用文字/);
}));
test('channel encoding and delivery remain inside the shared voice concurrency limit',()=>fixture(async f=>{
  await f.settings.update({tts:true});let release!:()=>void;let entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const heldApi={call:async()=>{entered();await waiting;return {message_id:42};}} as any;
  const first=f.telegramVoice.send(heldApi,'123','第一段','serial-one');
  await started;
  const second=f.telegramVoice.send(f.api,'123','第二段','serial-two');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.count().tts,1);assert.equal(f.calls.length,0);
  release();assert.deepEqual(await Promise.all([first,second]),[true,true]);assert.equal(f.count().tts,2);
}));
test('the Telegram preview and proactive paths use the same transport and explicit paid settings',()=>fixture(async f=>{
  const adapter=new TelegramAdapter({token:'fixture',ownerId:'123',dataDir:f.root,mediaStore:{} as never,api:f.api,
    sendVoice:(api,target,text,id,reply,onSent,instruction,preview)=>f.telegramVoice.send(api,target,text,id,preview,reply,onSent,instruction),
    sendProactiveVoice:(api,target,text)=>f.telegramVoice.proactive(api,target,text)});
  assert.equal(await adapter.previewVoice(),false);assert.equal(f.calls.length,0);
  await f.settings.update({tts:true});assert.equal(await adapter.previewVoice(),true);
  assert.equal(f.calls.at(-1).body.caption,'音色试听');
  await adapter.sendProactiveText('123','先用文字','先用文字');
  assert.deepEqual(f.calls.map((call:any)=>call.method),['sendVoice','sendMessage']);
  await f.settings.update({proactive:true});
  await adapter.sendProactiveText('123','语音测试\n\n补充文字','语音测试');
  assert.deepEqual(f.calls.map((call:any)=>call.method),['sendVoice','sendMessage','sendVoice','sendMessage']);
  assert.equal(f.calls.at(-1).body.text,'补充文字');assert.equal(f.count().tts,2);
  await adapter.stop();
}));
test('explicit voice requests exclude feature discussion, negation, code and long explanations',()=>{
  assert.equal(explicitVoiceRequest('请用语音回复我'),true);assert.equal(explicitVoiceRequest('不要用语音回复'),false);assert.equal(explicitVoiceRequest('语音价格多少'),false);
  for(const text of ['给我发一段语音','发条语音','来段语音','说段语音','发一条语音','发语音','用语音','用语音吧','能不能发语音','你可以发语音吗','语音回复我','发语音给我听','请用语音回复测试内容'])
    assert.equal(explicitVoiceRequest(text),true,text);
  for(const text of ['先别给我发一段语音','请不要发条语音','语音设置怎么弄','不要发语音','别用语音','语音怎么收费','我刚刚发了语音','讨论怎么发语音','你支持语音吗'])
    assert.equal(explicitVoiceRequest(text),false,text);
  assert.equal(speakable('```cpp\na++\n```'),false);assert.equal(speakable('字'.repeat(501)),false);assert.equal(speakable('今天怎么样？'),true);
});
test('Qwen-Audio-3.1-ASR uses non-streaming DashScope WAV without hotwords or model-side context',async()=>{
  const calls:any[]=[];const wav=Buffer.from('RIFFmock-wav');
  const client=new BailianSpeech({apiKey:'fixture-key',baseUrl:'https://workspace.ap-southeast-1.maas.aliyuncs.com'},async(url:any,init:any)=>{
    calls.push({url:String(url),init});
    return Response.json({output:{text:'  今天进行语音识别测试。  ',output:{sentence:{text:'今天进行语音识别测试。'}}}});
  });
  assert.equal(await client.transcribe(wav,'qwen-audio-3.1-asr-flash'),'今天进行语音识别测试。');
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(calls[0].init.headers['X-DashScope-SSE'],'disable');
  assert.equal(calls[0].init.headers.Authorization,'Bearer fixture-key');
  assert.deepEqual(JSON.parse(calls[0].init.body),{
    model:'qwen-audio-3.1-asr-flash',
    input:{messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:'data:audio/wav;base64,'+wav.toString('base64')}}]}]},
    parameters:{format:'wav',sample_rate:'16000'},
  });
  const malformed=new BailianSpeech({apiKey:'fixture-key',baseUrl:'https://workspace.ap-southeast-1.maas.aliyuncs.com'},
    async()=>Response.json({output:{output:{sentence:{text:'partial only'}}}}));
  await assert.rejects(malformed.transcribe(wav,'qwen-audio-3.1-asr-flash'),/百炼未返回有效识别文字/);
});
test('Bailian only uses configured Aliyun region and matches verified HTTP contracts, no implicit retry',async()=>{
  const calls:any[]=[];const client=new BailianSpeech({apiKey:'fixture-key',baseUrl:'https://workspace.ap-southeast-1.maas.aliyuncs.com'},async(url:any,init:any)=>{
    calls.push({url:String(url),init});if(String(url).includes('chat/completions'))return Response.json({choices:[{message:{content:'中文 English'}}]});
    if(String(url).includes('generation'))return Response.json({output:{audio:{url:'https://fixture.oss-ap-southeast-1.aliyuncs.com/test.wav'}}});return new Response('wav');
  });assert.equal(await client.transcribe(Buffer.from('wav'),'qwen3-asr-flash'),'中文 English');
  assert.equal(JSON.parse(calls[0].init.body).asr_options.language,undefined);assert.match(JSON.parse(calls[0].init.body).messages[0].content[0].input_audio.data,/^data:audio\/wav;base64,/);
  await client.synthesize('你好',{asr:false,asrModel:'qwen3-asr-flash',tts:true,ttsModel:'qwen3-tts-flash',voice:'Cherry',proactive:false});assert.equal(calls.length,3);assert.equal(calls[2].init.headers,undefined);
  assert.throws(()=>voiceEndpoint('https://other-provider.example'),/Untrusted/);assert.throws(()=>voiceEndpoint('https://workspace.us-east-1.maas.aliyuncs.com'),/端点/);
});
test('real lightweight codec validates WAV, produces OGG/Opus and decodes SILK without a resident service',async()=>{
  const root=await mkdtemp(join(tmpdir(),'codec-'));const previousCwd=process.cwd();try{process.chdir(root);const pcm=Buffer.alloc(32000);const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);
    const file=join(root,'sample.wav');await writeFile(file,Buffer.concat([h,pcm]));const codec=new LightweightAudio();const wav=await codec.prepare(file,'audio/wav');assert.equal(wav.subarray(0,4).toString(),'RIFF');const opus=await codec.opus(wav);assert.equal(opus.subarray(0,4).toString(),'OggS');
    const {encode}=await import('silk-wasm');const silk=await encode(pcm,16000);const silkFile=join(root,'sample.silk');await writeFile(silkFile,silk.data);assert.equal((await codec.prepare(silkFile,'audio/silk')).subarray(0,4).toString(),'RIFF');
  }finally{process.chdir(previousCwd);await rm(root,{recursive:true,force:true});}
});
test('Telegram multipart encodes voice.ogg and JSON reply markup rather than object string',async()=>{
  const original=globalThis.fetch;let request:any;
  globalThis.fetch=async(_url:any,init:any)=>{request=init;return Response.json({ok:true,result:{message_id:1}});};
  try{await new TelegramBotApi('fixture').call('sendVoice',{chat_id:'123',voice:new Blob(['OggS'],{type:'audio/ogg'}),reply_markup:{inline_keyboard:[]}});
    assert.equal(request.body.get('voice').name,'voice.ogg');assert.deepEqual(JSON.parse(request.body.get('reply_markup')),{inline_keyboard:[]});
  }finally{globalThis.fetch=original;}
});

test('ASR identifies original events across rebatching but permits explicit resend of the same file',()=>fixture(async f=>{
  await f.settings.update({asr:true});const original={...message,attachments:[{...message.attachments[0],sourceMessageId:'raw-1'}]};
  await f.speech.preprocess(original);await f.speech.preprocess({...original,messageId:'merged-1-2'});assert.equal(f.count().asr,1);
  await f.speech.preprocess({...original,messageId:'new',attachments:[{...original.attachments[0],sourceMessageId:'raw-2'}]});assert.equal(f.count().asr,2);
}));

test('valid WeChat platform transcription works without ASR configuration, preserves position and source',()=>fixture(async f=>{
  f.client.configured=()=>false;f.codec.prepare=async()=>{throw Error('must not decode');};
  const incoming={...message,attachments:[{kind:'voice',sourceMessageId:'voice-event:0',remoteId:'voice-event',transcription:' 平台识别原文 ',transcriptionSource:'platform'}],
    platformMessages:[{accountId:'bot',conversationId:'wx',direction:'inbound',messageId:'voice-event',text:'before\n[附件索引 1]\nafter',attachments:[{kind:'voice',sourceMessageId:'voice-event:0'}]}]};
  const result=await f.speech.preprocess(incoming);
  assert.match(result.text,/before[\s\S]*平台识别原文[\s\S]*after/);assert.equal(result.attachments[0].transcriptionSource,'platform');assert.match(result.platformMessages[0].text,/平台识别原文/);
  assert.deepEqual(f.count(),{asr:0,tts:0});
  await assert.rejects(f.speech.preprocess({...incoming,attachments:[{...incoming.attachments[0],transcription:'  '}]}),/尚未配置/);
}));


test('legacy voice directions never reach synthesis or the transcript button',()=>fixture(async f=>{
  await f.settings.update({tts:true});
  let spoken='';f.client.synthesize=async(text:string)=>{spoken=text;return Buffer.from('wav');};
  assert.equal(await f.telegramVoice.send(f.api,'123','（动作说明）你好（停顿）再见','stage-legacy'),true);
  assert.equal(spoken,'你好 再见');
  const data=f.calls.find((c:any)=>c.method==='sendVoice').body.reply_markup.inline_keyboard[0][0].callback_data;
  await f.telegramVoice.callback({id:'q',from:{id:123},message:{message_id:42,date:1,chat:{id:123,type:'private'}},data},f.api);
  assert.equal(f.calls.find((c:any)=>c.method==='editMessageCaption').body.caption,'你好 再见');
}));
