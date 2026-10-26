import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForHealth,releaseRevision} from '../host/health.mjs';
import {updateResultText} from '../host/notifications.mjs';
const response=value=>({ok:true,json:async()=>value});
test('health confirmation requires the expected PID, usable Core and healthy runtime',async()=>{
 for(const body of [{ok:true,pid:99,core:{available:true}},{ok:false,pid:42,core:{available:true}},{ok:true,pid:42,core:{available:false}}]){
  assert.equal(await waitForHealth({pid:42,port:8790,attempts:1,request:async()=>response(body)}),false);
 }
 assert.equal(await waitForHealth({pid:42,port:8790,attempts:1,request:async()=>response({ok:true,pid:42,core:{available:true}})}),true);
});
test('health retry handles transient errors and uses IPv6 loopback for wildcard binds',async()=>{
 let calls=0,waits=0;
 const healthy=await waitForHealth({pid:42,port:8790,host:'::',attempts:2,sleep:async()=>{waits++;},request:async url=>{
  assert.equal(url,'http://[::1]:8790/healthz');if(calls++===0)throw Error('synthetic connection failure');
  return response({ok:true,pid:42,core:{available:true}});
 }});
 assert.equal(healthy,true);assert.equal(waits,1);
 assert.equal(await waitForHealth({pid:undefined,port:8790,request:async()=>assert.fail('invalid PID must not request')}),false);
});
test('release reports use selected code revision and show changes without untrusted error strings',async()=>{
 const sha='a'.repeat(40),beforeSha='b'.repeat(40);
 assert.equal(await releaseRevision({pointer:{sha}}),sha);
 const text=updateResultText({phase:'failed',stage:'tests',beforeSha,sha,source:'official',message:'synthetic raw output'});
 assert.match(text,/测试/);assert.match(text,/bbbbbbbbbbbb → aaaaaaaaaaaa/);assert.doesNotMatch(text,/synthetic raw output/);
 assert.match(updateResultText({phase:'current',sha,beforeSha:sha}),/未变化/);
 assert.match(updateResultText({phase:'failed',stage:'synthetic-secret'}),/未能核验/);
 assert.doesNotMatch(updateResultText({phase:'failed',stage:'synthetic-secret'}),/synthetic-secret/);
});
