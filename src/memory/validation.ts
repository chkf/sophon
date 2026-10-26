export class MemoryError extends Error { constructor(readonly code: string) { super(code); } }
export interface TopicProposal { client_temp_id: string; parent_id: string|null; name: string; description: string; aliases: string[] }
export interface Classification {
 schema_version: 1; decision: 'STORE'|'SKIP'; kind?: 'chat'|'event'|'plan'|'correction'|'preference';
 gist?: string; importance?: number; labels: {topic_id:string;score:number}[];
 proposed_topics: TopicProposal[]; relation_hints: {a:string;b:string;strength:number}[];
}
export function normalizeName(value: string): string { return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,''); }
function object(v: unknown): v is Record<string,unknown> { return !!v && typeof v==='object' && !Array.isArray(v); }
function text(v: unknown, max: number): v is string { return typeof v==='string' && !!v.trim() && v.length<=max && !/[\u0000-\u0008]/.test(v); }
function score(v:unknown): v is number { return typeof v==='number' && Number.isFinite(v) && v>=0 && v<=1; }
export function parseClassification(raw: string, stage: 'roots'|'final'='final'): Classification {
  let v: unknown; try { v=JSON.parse(raw); } catch { throw new MemoryError('INVALID_JSON'); }
  const bad=()=>{throw new MemoryError('INVALID_CLASSIFICATION');};
  if (!object(v) || Object.keys(v).some(k=>!['schema_version','decision','kind','gist','importance','labels','proposed_topics','relation_hints'].includes(k)) ||
    v.schema_version!==1 || !['STORE','SKIP'].includes(String(v.decision))) return bad();
  const labels=v.labels??[],proposed=v.proposed_topics??[],hints=v.relation_hints??[];
  if (!Array.isArray(labels)||labels.length>2||!Array.isArray(proposed)||proposed.length>6||!Array.isArray(hints)||hints.length>1) return bad();
  if (labels.some(x=>!object(x)||!text(x.topic_id,100)||!score(x.score)) || new Set(labels.map(x=>x.topic_id)).size!==labels.length) return bad();
  if (proposed.some(x=>!object(x)||!text(x.client_temp_id,100)||!(x.parent_id===null||text(x.parent_id,100))||!text(x.name,60)||
    !normalizeName(x.name)||!text(x.description,240)||!Array.isArray(x.aliases)||x.aliases.length>8||x.aliases.some(a=>!text(a,60)||!normalizeName(a)))) return bad();
  if (new Set(proposed.map(x=>x.client_temp_id)).size!==proposed.length) return bad();
  if (hints.some(x=>!object(x)||!text(x.a,100)||!text(x.b,100)||x.a===x.b||!score(x.strength))) return bad();
  if(v.decision==='SKIP') {
    if(labels.length||proposed.length||hints.length)return bad();
    return {schema_version:1,decision:'SKIP',labels:[],proposed_topics:[],relation_hints:[]};
  }
  const validKind=['chat','event','plan','correction','preference'].includes(String(v.kind));
  if (!labels.length || (stage==='final' && (!text(v.gist,200) || !score(v.importance) || !validKind)) ||
    (stage==='roots' && ((v.gist!==undefined && !text(v.gist,200)) ||
      (v.importance!==undefined && !score(v.importance)) || (v.kind!==undefined && !validKind)))) return bad();
  return {...v,labels,proposed_topics:proposed,relation_hints:hints} as unknown as Classification;
}

