import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeGateway} from '../setup.js';
import {ReplyTiming} from './reply-timing.js';
import {TelegramAdapter} from './telegram/adapter.js';
import {IlinkAdapter} from './ilink/adapter.js';

test('reply timing defaults to eight seconds and persists valid owner choices',async t=>{
 const root=await mkdtemp(join(tmpdir(),'sophon-reply-timing-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const data=join(root,"state");await initializeGateway(data);const timing=new ReplyTiming(data);
 assert.deepEqual(timing.get(),{seconds:8});assert.equal(timing.milliseconds(),8000);
 for(const seconds of [0,3,30]){timing.set(seconds);assert.equal(new ReplyTiming(data).milliseconds(),seconds*1000);}
 for(const seconds of [-1,31,1.5,NaN,'3',null])assert.throws(()=>timing.set(seconds as number));
 assert.deepEqual(timing.get(),{seconds:30});
});

test('changing wait reschedules pending Telegram input without shortening retry backoff',async t=>{
 let wait=8000;const delays:number[]=[];
 t.mock.method(Date,'now',()=>10000);
 t.mock.method(globalThis,'setTimeout',(_fn:unknown,ms:number)=>{delays.push(ms);return undefined;});
 const adapter=new TelegramAdapter({token:'synthetic',ownerId:'70001',dataDir:join(tmpdir(),'unused-reply-timing'),mediaStore:{} as never,getInputDebounceMs:()=>wait});
 const internal=adapter as any;internal.running=true;internal.state={offset:0,buffer:{lastReceivedAtMs:9000}};
 adapter.refreshInputTiming();wait=3000;adapter.refreshInputTiming();wait=0;adapter.refreshInputTiming();
 internal.state={offset:0,inFlight:{retryAtMs:20000}};adapter.refreshInputTiming();
 assert.deepEqual(delays,[7000,2000,0,10000]);internal.running=false;
});

test('WeChat wait follows the live setting but preserves the total batch deadline',async t=>{
 let wait=8000;const delays:number[]=[];
 t.mock.method(Date,'now',()=>10000);
 t.mock.method(globalThis,'setTimeout',(_fn:unknown,ms:number)=>{delays.push(ms);return undefined;});
 const state={batches:[{id:'sample-batch',firstAt:0,lastAt:9000}]};
 const adapter=new IlinkAdapter({store:{load:async()=>state},getInputDebounceMs:()=>wait} as any);
 (adapter as any).running=true;
 adapter.refreshInputTiming();await Promise.resolve();wait=30000;
 adapter.refreshInputTiming();await Promise.resolve();wait=0;
 adapter.refreshInputTiming();await Promise.resolve();
 assert.deepEqual(delays,[7000,20000,0]);(adapter as any).running=false;
});
