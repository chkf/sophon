import test from "node:test";
import assert from "node:assert/strict";
import { blockTextualToolCall, textualToolCall } from "./tool-call-integrity.js";

test("pseudo function calls remain inert text and become explicit delivery warnings", () => {
  const offered=["send_voice","gateway_recent_read"];
  for(const output of [
    'to=gateway.send_voice {"text":"你好"}',
    '（查看文档）\n{"name":"send_voice","arguments":{"text":"你好"}}',
    '<|assistant|> to=gateway.gateway_recent_read {"query":"今天"}',
    '{"name":"send_voice","arguments":{"text":"你好"}}',
    '```json\n{"name":"send_voice","arguments":{"text":"你好"}}\n```',
  ]){
    assert.equal(textualToolCall(output,offered),true,output);
    const rendered=blockTextualToolCall(output,offered,"siwc");
    assert.match(rendered,/没有真正调用工具/);
    assert.doesNotMatch(rendered,/gateway_recent_read|send_voice|query/);
  }
});

test("ordinary explanations and non-tool JSON are left intact", () => {
  for(const output of [
    "我可以通过 send_voice 发送语音，但当前没有执行。",
    '为了说明问题，请看 {"name":"send_voice","arguments":{}} 这个例子。',
    '{"name":"一个字段","status":"ok"}',
    '{"name":"schedule","type":"object"}',
    '{"name":"ordinaryLibraryFunction","arguments":{"sort":"asc"}}',
    "```python\nprint('send_voice')\n```",
  ]){
    assert.equal(textualToolCall(output,["send_voice"]),false,output);
    assert.equal(blockTextualToolCall(output,["send_voice"],"openrouter"),output);
  }
});
