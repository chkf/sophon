import test from 'node:test';
import assert from 'node:assert/strict';
import { classificationInput, classificationRequest, selectRoots, finishClassification, branchClassificationInput, advanceBranches, topicDirectoryHash } from './classifier.js';
import type { Topic, Turn } from './store.js';
import type { Classification } from './validation.js';

const topic=(id:string,parent_id:string|null=null,name=id):Topic=>({id,parent_id,name,description:'Synthetic topic',aliases:'[]',occurrence_mass:1,mass_updated_at:'2026-01-01T00:00:00Z'});
const turn:Turn={assistant:2,fingerprint:'synthetic',context:[],sources:[{rowid:1,seq:0,role:'user',content:'请在周日整理文档。',at:'2026-01-01T00:00:00Z',origin:'chat',partial:0}]};
const result=(id:string):Classification=>({schema_version:1,decision:'STORE',kind:'plan',importance:0.5,gist:'文档整理计划',labels:[{topic_id:id,score:0.9}],proposed_topics:[],relation_hints:[]});
const skip:Classification={schema_version:1,decision:'SKIP',labels:[],proposed_topics:[],relation_hints:[]};

test('root routing supplies all roots and expands only selected branches',()=>{
 const topics=[topic('documents'),topic('index','documents'),topic('schedule'),topic('dates','schedule')];
 const first=JSON.parse(classificationInput(turn,topics,1));
 assert.equal(first.stage,'roots');assert.equal(first.directory_truncated,false);
 assert.deepEqual(first.topics.map((t:Topic)=>t.id),['documents','schedule']);
 const selection=selectRoots(result('documents'),topics);
 const second=JSON.parse(classificationInput(turn,topics,1,undefined,selection));
 assert.equal(second.stage,'branches');assert.deepEqual(second.topics.map((t:Topic)=>t.id),['documents','index']);
 assert.deepEqual(finishClassification(result('index'),topics,selection).labels,result('index').labels);
 assert.throws(()=>finishClassification(result('dates'),topics,selection),/TOPIC_INVALID/);
 assert.throws(()=>selectRoots(result('index'),topics),/TOPIC_INVALID/);
});

test('root aliases reuse existing topics and new root proposals wait for final classification',()=>{
 const topics=[{...topic('documents'),aliases:'["document index"]'}];
 const proposal={client_temp_id:'new-root',parent_id:null,name:'Document Index',description:'Synthetic category',aliases:[]};
 const draft={...result('new-root'),proposed_topics:[proposal]};
 assert.deepEqual(selectRoots(draft,topics),{labels:[{topic_id:'documents',score:0.9}],proposed_topics:[]});
 const selection=selectRoots({...draft,proposed_topics:[{...proposal,name:'Schedules'}]},topics);
 assert.equal(selection.proposed_topics.length,1);
 assert.deepEqual(finishClassification(skip,topics,selection),skip);
 assert.equal(finishClassification(result('new-root'),topics,selection).proposed_topics.length,1);
});

test('large branches descend through complete child lists without losing siblings',()=>{
 const topics=[topic('root'),topic('section','root'),...Array.from({length:250},(_,i)=>({...topic('item-'+i,'section'),description:'x'.repeat(240)}))];
 const selection=selectRoots(result('root'),topics);
 const step=branchClassificationInput(turn,topics,1,undefined,selection);
 assert.equal(step.descend,true);
 assert.deepEqual(JSON.parse(step.input).topics.map((t:Topic)=>t.id),['root','section']);
 assert.deepEqual(advanceBranches(result('section'),topics,selection,step.focus),[{id:'section',shallow:false}]);
 assert.throws(()=>advanceBranches(result('item-0'),topics,selection,step.focus),/TOPIC_INVALID/);
 const locked=advanceBranches(result('root'),topics,selection,step.focus);
 assert.throws(()=>advanceBranches(result('section'),topics,selection,locked),/TOPIC_INVALID/);
});

test('oversized roots fail explicitly and directory hashes ignore usage weights',()=>{
 const topics=Array.from({length:250},(_,i)=>({...topic('root-'+i),description:'x'.repeat(240)}));
 assert.throws(()=>classificationInput(turn,topics,1),/TOPIC_DIRECTORY_LIMIT/);
 const original=[topic('root')];
 assert.equal(topicDirectoryHash(original),topicDirectoryHash([{...original[0]!,occurrence_mass:99}]));
 assert.notEqual(topicDirectoryHash(original),topicDirectoryHash([{...original[0]!,name:'Changed category'}]));
});

test('final proposals cannot create another root or bypass an unexpanded existing child',()=>{
 const topics=[topic('root'),topic('section','root')],selection=selectRoots(result('root'),topics);
 const proposal={client_temp_id:'new',parent_id:null,name:'New category',description:'Synthetic category',aliases:[]};
 assert.throws(()=>finishClassification({...result('new'),proposed_topics:[proposal]},topics,selection),/TOPIC_INVALID/);
 assert.throws(()=>finishClassification({...result('new'),proposed_topics:[{...proposal,parent_id:'section'}]},topics,selection,[{id:'root',shallow:true}]),/TOPIC_INVALID/);
});

test('classification instructions separate clarification-only turns from grounded corrections',()=>{
 const request=classificationRequest(classificationInput(turn,[],1));
 assert.equal(request.maxToolRounds,0);
 assert.match(request.instructions!,/澄清往返/);
 assert.match(request.instructions!,/不按.*关键词一律跳过/);
 assert.match(request.instructions!,/不是周六，是周日/);
 assert.match(request.instructions!,/助手的猜测性追问不构成已确认事实/);
 assert.match(request.instructions!,/stage=roots/);
 assert.match(request.instructions!,/stage=branches/);
});
