import type { ChatRuntime } from '../runtime/types.js';
import type { MemoryStore, Job, Turn } from './store.js';
import { parseDigest, type Digest } from './tasks.js';
import { MemoryError } from './validation.js';
interface Progress {next:number;digests:Digest[];reduce?:Digest[]}
/** One bounded call per tick; the durable cursor covers all original chunks, including late cancellations. */
export async function prepareLongTurn(store:MemoryStore,job:Job,turn:Turn,runtime:ChatRuntime):Promise<{ready:boolean;digest?:Digest[]}> {
 if(turn.sources.reduce((n,s)=>n+s.content.length,0)<=20_000)return {ready:true};
 if(!runtime.runMemoryTask)throw new MemoryError('CLASSIFIER_UNAVAILABLE');
 const chunks:{source_id:number;role:string;offset:number;content:string}[]=[];
 for(const s of turn.sources)for(let offset=0;offset<s.content.length;offset+=16_000)chunks.push({source_id:s.rowid,role:s.role,offset,content:s.content.slice(offset,offset+16_000)});
 const sources=new Map(turn.sources.map(s=>[s.rowid,s.content]));
 const progress=(store.progress(job,turn.fingerprint) as Progress|undefined)??{next:0,digests:[]};
 if(progress.next<chunks.length){
   const chunk=chunks[progress.next]!;
   const digest=parseDigest(await runtime.runMemoryTask('digest',JSON.stringify({chunk,total:chunks.length})),new Map([[chunk.source_id,chunk.content]]));
   progress.digests.push(digest);progress.next++;
 }else if(JSON.stringify(progress.digests).length>16_000){
   const batch:Digest[]=[];let bytes=0;
   while(progress.digests.length&&bytes+JSON.stringify(progress.digests[0]).length<26_000){const d=progress.digests.shift()!;batch.push(d);bytes+=JSON.stringify(d).length;}
   if(!batch.length)throw new MemoryError('TASK_INPUT_LIMIT');
   const digest=parseDigest(await runtime.runMemoryTask('digest',JSON.stringify({materials:batch})),sources);
   (progress.reduce??=[]).push(digest);
   if(!progress.digests.length){progress.digests=progress.reduce;delete progress.reduce;}
 }else if(progress.reduce){progress.digests.push(...progress.reduce);delete progress.reduce;}
 else return {ready:true,digest:progress.digests};
 store.saveProgress(job,turn.fingerprint,progress);return {ready:false};
}

