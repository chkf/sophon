import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {animationPreview} from './animation-preview.js';
import {initializeGateway} from '../setup.js';
import {SessionStore} from '../sessions/store.js';
import {StickerTurn} from '../runtime/stickers.js';
import {historyFromMessages} from '../runtime/history.js';
const run=promisify(execFile);
test('generated test pattern produces a PNG contact sheet and invalid input falls back',async t=>{
 try{await run('ffmpeg',['-version']);}catch{t.skip('ffmpeg is optional');return;}
 const root=await mkdtemp(join(tmpdir(),'animation-test-'));
 try{const path=join(root,'pattern.mp4');await run('ffmpeg',['-nostdin','-loglevel','error','-f','lavfi','-i','testsrc=size=32x24:rate=4','-t','2','-pix_fmt','yuv420p',path]);
 const png=await animationPreview(path,2);assert.ok(png);assert.equal(Buffer.from(png).subarray(1,4).toString(),'PNG');
 assert.equal(await animationPreview(join(root,'missing.mp4')),undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('GIF catalog notes are scoped, durable and require a listed original material',async()=>{
 const base=await mkdtemp(join(tmpdir(),'reaction-test-')),root=join(base,'data');let sessions:SessionStore|undefined;
 try{await initializeGateway(root);sessions=new SessionStore(root);
 const sticker={fileId:'synthetic_gif',format:'gif' as const,accountId:'telegram-bot:70002',chatId:'70001'};
 await sessions.rememberTelegramReactions([sticker],new Date().toISOString());
 const message:any={channel:'telegram',conversationId:'70001',senderId:'70001',messageId:'sample',text:'合成素材',attachments:[],platformMessages:[{accountId:sticker.accountId}]};
 const turn=new StickerTurn(historyFromMessages([]),message,sessions);
 await assert.rejects(turn.note({key:'unknown',note:'文档整理完成'}),/先 list/);
 const listing:any=await turn.execute({action:'list'});const item=listing.stickers[0];assert.ok(item);
 await turn.note({key:item.key,note:'文档整理完成'});await turn.execute({action:'select',key:item.key});assert.equal(turn.prepared?.format,'gif');
 const fresh=new StickerTurn(historyFromMessages([]),message,sessions);const found:any=await fresh.execute({action:'list',query:'文档整理完成'});assert.equal(found.stickers.length,1);
 const other=new StickerTurn(historyFromMessages([]),{...message,conversationId:'70003',senderId:'70003'},sessions);assert.equal(((await other.execute({action:'list'})) as any).stickers.length,0);
 }finally{sessions?.close();await rm(base,{recursive:true,force:true});}
});
