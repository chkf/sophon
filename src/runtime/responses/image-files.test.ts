import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentPart, normalizeImageFileInput } from './attachments.js';
test('image documents use visual input even with generic MIME and opaque cache names',async t=>{
 const root=await mkdtemp(join(tmpdir(),'image-input-')); t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'cache');await writeFile(path,'synthetic bytes');
 for(const mimeType of ['application/octet-stream; charset=binary','IMAGE/PNG; charset=binary']) {
  const part=await attachmentPart({kind:'file',path,fileName:'diagram.png',mimeType});
  assert.equal(part?.type,'input_image'); assert.match(String(part?.image_url),/^data:image\/png;base64,/);
 }
 const pdf=await attachmentPart({kind:'file',path,fileName:'document.pdf',mimeType:'application/pdf'});
 assert.equal(pdf?.type,'input_file');
});
test('checkpoint normalization preserves source, tool results and other files',()=>{
 const image={type:'input_file',file_data:'data:image/png;base64,c3ludGhldGlj',filename:'diagram.png'};
 const pdf={type:'input_file',file_data:'data:application/pdf;base64,c3ludGhldGlj'};
 const tool={type:'function_call_output',output:JSON.stringify(image)};
 const source=[{role:'user',content:[image,pdf]},tool]; const before=JSON.stringify(source);
 const result=normalizeImageFileInput(source) as typeof source;
 assert.equal((result[0] as any).content[0].type,'input_image');
 assert.deepEqual((result[0] as any).content[1],pdf);assert.deepEqual(result[1],tool);
 assert.equal(JSON.stringify(source),before);assert.deepEqual(normalizeImageFileInput(result),result);
});
test('WebSocket sends repaired image wrappers without changing saved event',async()=>{
 const {ResponsesTransport}=await import('../siwc/responses-transport.js');
 const event={input:[{role:'user',content:[{type:'input_file',file_data:'data:image/png;base64,c3ludGhldGlj'}]}]};
 const before=JSON.stringify(event);let sent:unknown;
 const transport=new ResponsesTransport(1000,async()=>{});
 await transport.completedResponseWithRetry({send(value){sent=value;},async *stream(){yield {type:'message',message:{type:'response.completed',response:{id:'synthetic-response',status:'completed',output:[]}}};},close(){}},event);
 assert.equal((sent as typeof event).input[0]!.content[0]!.type,'input_image');assert.equal(JSON.stringify(event),before);
});
