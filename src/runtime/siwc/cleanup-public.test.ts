import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {initializeGateway} from '../../setup.js';
import {LaneStore} from './lane-store.js';
import {cleanupBackgroundArchives} from './background-cleanup.js';
import {mainPath,openDatabase} from '../../state/database.js';
test('archive cleanup removes only settled background reset archives',async()=>{
 const base=await mkdtemp(join(tmpdir(),'cleanup-public-')),root=join(base,'data');
 try{await initializeGateway(root);const store=new LaneStore(root);
 const state=(id:string)=>({version:2 as const,sessionId:id,model:'fixture',contextItems:[{role:'user',content:'合成后台请求'}]});
 const retired='background:'+randomUUID(),pending='background:'+randomUUID(),formal='telegram:70001';
 await store.archive(retired,state(retired),'explicit-reset');
 await store.archive(pending,{...state(pending),pendingDeliveryId:'fixture-pending'},'explicit-reset');
 await store.archive(formal,state(formal),'explicit-reset');
 await store.write(formal,state(formal));
 assert.equal(await cleanupBackgroundArchives(root),1);assert.equal(await cleanupBackgroundArchives(root),0);
 assert.ok(await store.read(formal));const db=openDatabase(mainPath(root),true);
 try{assert.equal(db.prepare("SELECT count(*) n FROM gateway_state WHERE key LIKE 'runtime/context/%'").get()!.n,3);}finally{db.close();}
 }finally{await rm(base,{recursive:true,force:true});}
});
