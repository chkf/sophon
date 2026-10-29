/** Optional DOM acceptance, using only synthetic local API responses. No browser layout assertions. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {JSDOM}=await import(process.env.SOPHON_UI_DOM_MODULE || 'jsdom');
const html=await readFile(new URL('../src/control/assets/index.html',import.meta.url),'utf8');
const dom=new JSDOM(html,{url:'https://control.example/control/',runScripts:'outside-only'});
const w=dom.window,doc=w.document,errors=[];
let poll;w.setInterval=fn=>{poll=fn;return 1;};w.scrollTo=()=>{};Object.defineProperty(doc,'hidden',{value:false});
const today=new Date().toISOString().slice(0,10);
w.matchMedia=()=>({matches:false,addEventListener(){}});w.confirm=()=>true;
w.ResizeObserver=class{observe(){}disconnect(){}};
w.HTMLElement.prototype.scrollIntoView=function(){};
w.addEventListener('error',event=>errors.push(event.message));
let replySeconds=8;
let reminderStatus='pending';
let prompt='输出带引用的 JSON。',revision=0,topicName='文档',nodeGist='你计划整理目录。',saves=0;
const at='2026-01-01T10:00:00Z';
const run={id:'fixture-call',kind:'chat',status:'completed',channel:'telegram',startedAt:at,durationMs:100,steps:[
 {id:'source',kind:'context',name:'Core',status:'completed',startedAt:at,input:{source:'core',placement:'policy',content:'中性指导'}},
 {id:'model',kind:'model',name:'模型调用',status:'completed',startedAt:at,context:[{source:'core',delivery:'sent'}],input:{message:'合成请求'},output:{message:'合成答复'}}]};
w.fetch=async(url,init)=>{
 const action=url.split('/').at(-1),body=JSON.parse(init.body);let data;
 if(action==='session') data={authenticated:true,csrfToken:'fixture-csrf'};
 else if(action==='tasks') data={runs:[],nextBefore:null,replyTiming:{seconds:replySeconds},heartbeat:{enabled:true,planningEnabled:true,activeChannel:'telegram',timezone:'UTC',plan:{date:today,channel:'telegram',wakes:[{time:'09:00',intent:'Review sample report'}]}},reminders:[{id:'rem_'+'a'.repeat(32),text:'检查合成文档 <script>literal</script>',dueAt:today+'T10:00:00Z',status:reminderStatus,channel:'telegram'}]};
 else if(action==='reply-timing-save'){assert.equal(body.seconds,3);replySeconds=body.seconds;data={seconds:replySeconds};}
 else if(action==='reminder-cancel'){assert.equal(body.id,'rem_'+'a'.repeat(32));reminderStatus='cancelled';data={};}
 else if(action==='context') data={calls:[run],checkpoints:[],usage:{note:'合成用量'}};
 else if(action==='call') data=run;
 else if(action==='graph') data={available:true,enabled:true,topics:1,counts:{active:1},progress:{jobs:{},operations:{},missingTurns:0,staleTurns:0,ready:true,initialized:true}};
 else if(action==='graph-prompts')data={revision,items:[{id:'classify',label:'分类',model:'记忆模型',content:prompt,customized:revision>0}]};
 else if(action==='graph-prompt-save'){assert.equal(body.expectedRevision,revision++);prompt=body.reset?'输出带引用的 JSON。':body.content;saves++;data={};}
 else if(action==='graph-topics')data={items:body.parentId?[]:[{id:'topic',name:topicName,children:0,memories:1}],path:[],related:[],nextOffset:null,selectedTopic:body.parentId?{id:'topic',name:topicName,description:'文档处理',revision:1}:null};
 else if(action==='graph-topic-save'){assert.equal(body.expectedRevision,1);topicName=body.name;saves++;data={};}
 else if(action==='graph-nodes')data={items:[{id:'node',kind:'turn',gist:nodeGist,status:'active',activation:1}],nextOffset:null};
 else if(action==='graph-node')data={id:'node',kind:'turn',status:'active',gist:nodeGist,summary:'我建议检查结构。',revision:1,memberships:[],sources:[],nextOffset:null};
 else if(action==='graph-node-save'){assert.equal(body.expectedRevision,1);nodeGist=body.gist;saves++;data={};}
 else throw Error('Unexpected synthetic action: '+action);
 return new Response(JSON.stringify({ok:true,data}),{headers:{'content-type':'application/json'}});
};
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const click=async(selector)=>{assert.ok(doc.querySelector(selector),selector);doc.querySelector(selector).click();await settle();};
const save=async(container)=>{const button=[...doc.querySelectorAll(container+' button')].find(b=>b.textContent==='保存修改');assert.ok(button);button.click();await settle();};
try{
 w.eval((await readFile(new URL('../src/control/assets/app.js',import.meta.url),'utf8')).replace(/\}\)\(\);\s*$/, 'window.__traceTest={traceBody,traceText};})();'));await settle();
 {
 const {traceBody,traceText}=w.__traceTest;
 const input={tools:[{type:'function',function:{name:'sample_read',description:'Read a synthetic document'}}],instructions:'Sample instruction',input:[{type:'message',role:'user',content:[{type:'input_text',text:'Document <script>literal</script>\nSecond line'}]}]};
 const step={kind:'model',name:'sample',provider:'api',model:'sample-model',input};
 const original=JSON.stringify(input);
 const readable=traceBody(input,'fixture:input',step,{...step});doc.body.append(readable);
 assert.match(readable.textContent,/与上一次模型调用相同/);
 assert.match(readable.textContent,/Document <script>literal<\/script>/);assert.equal(readable.querySelector('script'),null);
 assert.ok(readable.querySelector('.trace-text'));assert.equal(readable.querySelectorAll('details').length,2);
 assert.equal(JSON.stringify(input),original);
 const raw=readable.querySelectorAll('details')[1];raw.open=true;await settle();
 assert.equal(traceBody(input,'fixture:input',step,{...step}).querySelectorAll('details')[1].open,true);
 for(const change of [{model:'another-model'},{provider:'siwc'},{truncated:true}])
  assert.doesNotMatch(traceBody(input,'different',step,{...step,...change}).textContent,/与上一次模型调用相同/);
 const truncated={...input,tools:['[trace projection truncated]']};
 assert.doesNotMatch(traceBody(truncated,'truncated',{...step,input:truncated},step).textContent,/可用工具：与上一次/);
 assert.match(traceText({tools:[{type:'namespace',name:'gateway',tools:[{name:'sample_read'},{name:'sample_write'}]},null]}),/sample_read、sample_write、未命名/);
 assert.equal(traceText({unknown_field:'Sample value'}),'unknown_field：Sample value');
 assert.match(traceText({type:'function_call',name:'sample_read',arguments:'{"query":"document"}'}),/query：document/);
 assert.match(traceText(input.input),/用户消息：Document/);
 const placeholder={role:'user',content:'〔聊天正文已省略；仅影响展示〕'};
 const grouped=traceText([placeholder,{...placeholder,role:'assistant'},{type:'function_call_output',output:'sample result'},placeholder]);
 assert.match(grouped,/聊天消息 × 2 条/);assert.match(grouped,/聊天消息 × 1 条/);assert.ok(grouped.indexOf('sample result')>grouped.indexOf('× 2'));
 const metadata={input:[placeholder],attempt:2,continuation:'sample cursor',context:'sample attribution'};
 const filtered=traceBody(metadata,'filtered',null,{kind:'model'});
 assert.doesNotMatch(filtered.querySelector('.trace-text').textContent,/attempt|sample cursor|sample attribution/);
 assert.match(filtered.querySelector('pre').textContent,/sample cursor/);
 assert.equal(metadata.attempt,2);
 readable.remove();delete w.__traceTest;
 }
 assert.deepEqual([...doc.querySelectorAll('[data-task-kind]')].map(node=>node.dataset.taskKind),['proactive','reminder']);
 const delayInput=doc.querySelector('[aria-label="回复等待秒数"]');assert.equal(delayInput.value,'8');delayInput.value='3';delayInput.dispatchEvent(new w.Event('input'));await poll();await settle();assert.equal(delayInput.value,'3');await click('#reply-timing-panel button');assert.equal(replySeconds,3);
 assert.match(doc.querySelector('#reminder-panel').textContent,/检查合成文档/);assert.equal(doc.querySelector('#reminder-panel script'),null);
 await click('#reminder-panel button');assert.equal(reminderStatus,'cancelled');assert.match(doc.querySelector('#reminder-panel').textContent,/已取消/);
 await click('[data-page="context"]');assert.match(doc.querySelector('#page-content').textContent,/完整调用流程/);assert.doesNotMatch(doc.querySelector('#call-detail').textContent,/本次传入|本轮上下文来源/);
 const detail=doc.querySelector('#call-detail'),step=detail.querySelector('[data-step-id="model"]');step.open=true;await settle();
 const pre=step.querySelector('pre');pre.scrollTop=73;pre.scrollLeft=19;await poll();await settle();assert.equal(detail.querySelector('[data-step-id="model"] pre'),pre,'unchanged trace retains DOM');
 run.steps[1].output={message:'Revised sample response'};await poll();await settle();
 const revised=detail.querySelector('[data-step-id="model"]');assert.equal(revised.open,true);assert.equal(revised.querySelector('pre').scrollTop,73);assert.equal(revised.querySelector('pre').scrollLeft,19);
 await click('[data-page="graph"]');assert.ok(doc.querySelector('#graph-prompts textarea'));
 doc.querySelector('#graph-prompts details').open=true;
 const editor=doc.querySelector('#graph-prompts textarea');assert.equal(editor.rows,18);editor.value='仅根据原文输出 JSON。';editor.dispatchEvent(new w.Event('input'));await save('#graph-prompts');assert.equal(prompt,'仅根据原文输出 JSON。');assert.equal(doc.querySelector('#graph-prompts details').open,true);
 await click('.graph-topic');const title=doc.querySelector('[aria-label="主题名称"]');assert.equal(title.tagName,'INPUT');title.value='资料';title.dispatchEvent(new w.Event('input'));await save('#graph-topics');assert.equal(topicName,'资料');
 await click('.graph-node');const gist=doc.querySelector('[aria-label="检索线索"]');gist.value='你计划整理资料。';gist.dispatchEvent(new w.Event('input'));await save('#graph-detail');assert.equal(nodeGist,'你计划整理资料。');
 assert.equal(saves,3);assert.deepEqual(errors,[]);assert.notEqual(doc.querySelector('#notice').className,'notice error');
 console.log(JSON.stringify({passed:true,checks:['readable trace, literal HTML and raw data','identical settings fold only when complete and matching','trace disclosure refresh persistence','unified task ordering and reminder cancellation','trace refresh scroll retention','graph editor sizing','request-only presentation and grouped placeholders','graph prompt save','topic save','node save','revision payloads'],layoutVerified:false}));
}finally{w.close();}
