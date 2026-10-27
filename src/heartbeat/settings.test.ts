import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProactiveSettings} from './settings.js';
import {ActiveChannelRouter} from '../channels/active.js';
import {CommandPanels} from '../commands/panels.js';
import {SessionStore} from '../sessions/store.js';

test('panel toggles persist, override environment defaults, and gate routing without losing channel choice',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sophon-proactive-switch-'));
 const sessions=new SessionStore(root);
 try{
  const settings=new ProactiveSettings(root,false);
  let sends=0;
  const channels=new ActiveChannelRouter(root,{telegram:{channel:'telegram',async availableTarget(){return '70001';},async sendText(){sends++;}}},'telegram',()=>settings.enabled());
  const panels=new CommandPanels({} as never,channels,{} as never,{} as never,root,'UTC',async()=>'',undefined,undefined,settings);
  assert.equal(await settings.enabled(),false);assert.equal(await settings.explicitlyEnabled(),false);
  assert.equal(await channels.resolve(),undefined);
  let panel=await panels.proactive();assert.match(panel.text,/已关闭/);
  panel=await panel.rows.flat().find(b=>b.text.startsWith('开启主动模式'))!.run!();
  assert.match(panel.text,/已开启/);
  assert.equal(await new ProactiveSettings(root,false).enabled(),true);
  assert.equal(await settings.explicitlyEnabled(),true);
  assert.deepEqual(await channels.resolve(),{channel:'telegram',target:'70001'});
  await channels.sendIfActive('telegram','70001','Synthetic message');assert.equal(sends,1);
  panel=await panel.rows.flat().find(b=>b.text==='关闭主动模式')!.run!();
  assert.match(panel.text,/已关闭/);
  assert.equal(await new ProactiveSettings(root,true).enabled(),false);
  assert.equal(await channels.getActive(),'telegram');
  assert.equal(await channels.sendIfActive('telegram','70001','Synthetic message'),false);assert.equal(sends,1);
 }finally{sessions.close();await rm(root,{recursive:true,force:true});}
});

test('legacy channel off migrates to the single switch without enabling unsolicited activity',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sophon-proactive-legacy-'));const sessions=new SessionStore(root);
 try{
  const settings=new ProactiveSettings(root,true);
  const channels=new ActiveChannelRouter(root,{telegram:{channel:'telegram',async availableTarget(){return '70001';},async sendText(){}}},'telegram');
  await channels.setActive('off');await settings.migrateChannel(channels,'telegram');
  assert.equal(await settings.enabled(),false);assert.equal(await channels.getActive(),'telegram');
  await settings.setEnabled(true);await channels.setActive('off');await settings.migrateChannel(channels,'telegram');assert.equal(await settings.enabled(),true);
  const panels=new CommandPanels({} as never,channels,{} as never,{} as never,root,'UTC',async()=>'',undefined,undefined,settings);
  const buttons=(await panels.proactive()).rows.flat();assert.equal(buttons.filter(b=>b.text.includes('关闭')).length,1);
 }finally{sessions.close();await rm(root,{recursive:true,force:true});}
});

test('interval panel persists changes without losing the enabled preference',async()=>{
 const root=await mkdtemp(join(tmpdir(),'sophon-proactive-interval-'));const sessions=new SessionStore(root);
 try{
  const settings=new ProactiveSettings(root,false,{minIntervalMinutes:90,maxIntervalMinutes:180});
  const channels=new ActiveChannelRouter(root,{},'off');
  const panels=new CommandPanels({} as never,channels,{} as never,{} as never,root,'UTC',async()=>'',undefined,undefined,settings);
  await Promise.all([settings.setEnabled(true),settings.setInterval(30,60)]);
  assert.equal(await settings.enabled(),true);assert.equal((await settings.interval()).minIntervalMinutes,30);
  const page=await panels.proactiveInterval();await page.rows.flat().find(b=>b.text==='120–240 分钟')!.run!();
  assert.equal((await new ProactiveSettings(root,false).interval()).maxIntervalMinutes,240);
  assert.equal(await settings.enabled(),true);
  await assert.rejects(settings.setInterval(0,30));await assert.rejects(settings.setInterval(60,30));
 }finally{sessions.close();await rm(root,{recursive:true,force:true});}
});
