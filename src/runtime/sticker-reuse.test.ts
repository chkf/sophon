import test from 'node:test';
import assert from 'node:assert/strict';
import {StickerTurn} from './stickers.js';
import {historyFromMessages} from './history.js';
import type {InboundMessage,TelegramSticker} from '../channels/types.js';
const account='telegram-bot:70001',chat='70002';
const input:InboundMessage={channel:'telegram',conversationId:chat,senderId:chat,messageId:'1',text:'Document icon',attachments:[],platformMessages:[{accountId:account,conversationId:chat,direction:'inbound',messageId:'1',text:'Document icon'}]};
const stickers:TelegramSticker[]=Array.from({length:12},(_,n)=>({accountId:account,chatId:chat,fileId:'sample_asset_'+n,format:'static',emoji:'📄'}));
const entries=stickers.map(sticker=>({sticker,note:'Document icon'}));
const store={listTelegramReactions:async(a:string,c:string)=>a===account&&c===chat?entries:[],setTelegramReactionNote:async()=>{throw Error('Unused synthetic method');}} as any;

test('sticker lookup returns at most eight stable keys, usable across turns without another model lookup',async()=>{
 const history=historyFromMessages([]),first=new StickerTurn(history,input,store);
 const result=await first.execute({action:'list'}) as any;assert.equal(result.stickers.length,8);
 const key=result.stickers[0].key;assert.match(key,/^asset:[a-f0-9]{24}$/);
 const second=new StickerTurn(history,{...input,messageId:'2'},store);
 await second.execute({action:'select',key});assert.equal(second.prepared?.fileId,stickers[0]!.fileId);
 const anotherChat=new StickerTurn(history,{...input,conversationId:'70003',senderId:'70003'},store);
 await assert.rejects(anotherChat.execute({action:'select',key}));
 await assert.rejects(second.execute({action:'select',key:'asset:'+'0'.repeat(24)}));
});

test('duplicate current/history references do not displace distinct sticker candidates',async()=>{
 const duplicate={...input,platformMessages:[{...input.platformMessages![0]!,attachments:stickers.slice(0,1).map(sticker=>({kind:'image' as const,sticker}))}]};
 const history=historyFromMessages([{role:'user',content:'Document icon',source:{channel:'telegram',senderId:chat,platformMessages:duplicate.platformMessages}}] as any);
 const result=await new StickerTurn(history,duplicate,store).execute({action:'list'}) as any;
 assert.equal(result.stickers.length,8);assert.equal(new Set(result.stickers.map((s:any)=>s.key)).size,8);
});

test('multiple keywords rank distinct real assets and retain one selection per turn',async()=>{
 const notes=['document','chart','document chart','unrelated'];
 const saved={...store,listTelegramReactions:async()=>stickers.slice(0,4).map((sticker,index)=>({sticker,note:notes[index]}))};
 const turn=new StickerTurn(historyFromMessages([]),input,saved);
 const result=await turn.execute({action:'list',queries:['DOCUMENT','chart','document']}) as any;
 assert.deepEqual(result.stickers.map((item:any)=>item.note),['document chart','document','chart']);
 await turn.execute({action:'select',key:result.stickers[0].key});
 await turn.execute({action:'select',key:result.stickers[0].key});
 await assert.rejects(turn.execute({action:'select',key:result.stickers[1].key}),/只能选择一个/);
 for(const queries of [[],[''],['a','b','c','d'],[42]])await assert.rejects(turn.execute({action:'list',queries}));
 await assert.rejects(turn.execute({action:'list',query:'document',queries:['chart']}));
 assert.equal((await turn.execute({action:'list',queries:['no-match']}) as any).stickers.length,0);
});
