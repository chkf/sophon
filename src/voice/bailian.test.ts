import assert from "node:assert/strict";
import test from "node:test";
import { BailianSpeech } from "./bailian.js";
import type { VoiceSettings } from "./settings.js";
import { trustedHttps } from "../util/bounded-http.js";
import { MAX_AUDIO_BYTES } from "./audio.js";

const settings:VoiceSettings={asr:false,asrModel:"qwen3-asr-flash",tts:true,ttsModel:"qwen3-tts-flash",voice:"Cherry",proactive:false,showTextButton:true};
const host="dashscope-result-bj.oss-cn-beijing.aliyuncs.com";
function fixture(url:string,download:()=>Response=()=>new Response("audio")) {
  const calls:{url:string;init:RequestInit|undefined}[]=[];
  const client=new BailianSpeech({apiKey:"fixture-key",baseUrl:"https://dashscope.aliyuncs.com"},async(input,init)=>{
    calls.push({url:String(input),init});
    return calls.length===1?Response.json({output:{audio:{url}}}):download();
  });
  return {client,calls};
}

test("Plus sends Gateway's free-form expression instruction alongside the user's fixed voice",async()=>{
  const signed="https://fixture.oss-ap-southeast-1.aliyuncs.com/model.wav?Signature=fixture";
  const calls:{url:string;init:RequestInit|undefined}[]=[];
  const client=new BailianSpeech({apiKey:"fixture-key",baseUrl:"https://workspace.ap-southeast-1.maas.aliyuncs.com"},async(input,init)=>{
    calls.push({url:String(input),init});
    return calls.length===1?Response.json({output:{audio:{url:signed}}}):new Response("fixture-wav");
  });
  const setting={...settings,ttsModel:"qwen-audio-3.1-tts-plus",voice:"longanlingxin_v3.1"};
  const instruction="发音清晰，语速适中，句尾自然停顿。";
  assert.equal((await client.synthesize("语音测试。",setting,instruction)).toString(),"fixture-wav");
  assert.equal(calls[0]?.url,"https://workspace.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)),{
    model:"qwen-audio-3.1-tts-plus",
    input:{text:"语音测试。",voice:"longanlingxin_v3.1",format:"wav",sample_rate:24000,instruction},
  });
  assert.equal(calls[1]?.url,signed);
  assert.equal(calls[1]?.init?.headers,undefined);
  assert.equal(calls[1]?.init?.redirect,"error");
});

test("older Qwen3 Flash ignores prosody instruction rather than changing synthesis protocol",async()=>{
  const url="https://fixture.oss-ap-southeast-1.aliyuncs.com/voice.wav";
  const f=fixture(url);
  await f.client.synthesize("你好。",settings,"平稳地说话。");
  const request=JSON.parse(String(f.calls[0]?.init?.body));
  assert.equal(request.model,"qwen3-tts-flash");
  assert.equal(request.input.voice,"Cherry");
  assert.equal(request.input.instruction,undefined);
  assert.equal(request.input.language_type,"Auto");
});

test("official Beijing HTTP audio is upgraded without changing signed bytes or forwarding credentials",async()=>{
  const url=`http://${host}/a%2Fb/test.wav?Expires=123&Signature=a%2Bb%2Fc%3D&x=hello+world&x=%20`;
  const {client,calls}=fixture(url);
  assert.equal((await client.synthesize("你好",settings)).toString(),"audio");
  assert.equal(calls.length,2);
  assert.equal(calls[1].url,url.replace("http:","https:"));
  assert.equal(calls[1].init?.headers,undefined);
  assert.equal(calls[1].init?.redirect,"error");
  assert.ok(calls[1].init?.signal instanceof AbortSignal);
  assert.throws(()=>trustedHttps(url,["aliyuncs.com"]),/Untrusted/);
});

test("existing HTTPS result URLs remain unchanged",async()=>{
  const url="https://fixture.oss-ap-southeast-1.aliyuncs.com/test.wav?Signature=a%2B";
  const {client,calls}=fixture(url);
  await client.synthesize("你好",settings);
  assert.equal(calls[1].url,url);
});

test("HTTP upgrade does not admit other hosts, credentials, ports or schemes",async()=>{
  for(const url of [
    "http://other.oss-cn-beijing.aliyuncs.com/a.wav",
    `http://${host}.example.com/a.wav`,
    `http://user:password@${host}/a.wav`,
    `http://${host}:8080/a.wav`,
    `http://${host}:443/a.wav`,
    `ftp://${host}/a.wav`,
    "https://evil.example/a.wav",
    `https://${host}:444/a.wav`,
  ]) {
    const {client,calls}=fixture(url);
    await assert.rejects(client.synthesize("你好",settings),/Untrusted/);
    assert.equal(calls.length,1);
  }
});

test("download failure or oversized audio never retries paid synthesis",async()=>{
  for(const download of [
    ()=>new Response(null,{status:403}),
    ()=>new Response("audio",{headers:{"content-length":String(MAX_AUDIO_BYTES+1)}}),
    ()=>{throw new TypeError("network failure");},
  ]) {
    const {client,calls}=fixture(`http://${host}/test.wav`,download);
    await assert.rejects(client.synthesize("你好",settings));
    assert.equal(calls.length,2);
  }
});
