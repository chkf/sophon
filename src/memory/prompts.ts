import type { DatabaseSync } from 'node:sqlite';
import { getState, putState, transaction } from '../state/database.js';
import { classificationRequest } from './classifier.js';
import { memoryTaskRequest, type MemoryTask } from './tasks.js';
import { ControlDataError } from '../control/data.js';

export const MEMORY_PROMPTS_KEY = 'runtime/memory-prompts.json';
export const MEMORY_PROMPT_LABELS = {
 classify: '分类与主题选择', digest: '长对话摘要', organize: '主题整理', assign: '子主题归类',
 fuse: '记忆融合', verify: '融合核验', reinforce: '记忆强化',
} as const;
export type MemoryPromptId = keyof typeof MEMORY_PROMPT_LABELS;
export interface MemoryPrompts { revision: number; overrides: Partial<Record<MemoryPromptId, string>> }
export function defaultMemoryPrompt(id: MemoryPromptId): string {
 return (id === 'classify' ? classificationRequest('{}') : memoryTaskRequest(id as MemoryTask, '{}')).instructions!;
}
export function validateMemoryPrompts(value: unknown): MemoryPrompts {
 const v = value as MemoryPrompts;
 if (!v || !Number.isSafeInteger(v.revision) || v.revision < 0 || !v.overrides || typeof v.overrides !== 'object' || Array.isArray(v.overrides) ||
 Object.entries(v.overrides).some(([k,t]) => !Object.hasOwn(MEMORY_PROMPT_LABELS,k) || typeof t !== 'string' || !t.trim() || t.length > 24000 || t.includes('\0'))) throw new Error('记忆提示词设置损坏。');
 return v;
}
export function readMemoryPrompts(db: DatabaseSync): MemoryPrompts {
 const row = getState(db, MEMORY_PROMPTS_KEY);
 return row ? validateMemoryPrompts(JSON.parse(row.value)) : {revision:0,overrides:{}};
}
export function listMemoryPrompts(db: DatabaseSync) {
 const settings = readMemoryPrompts(db);
 return {revision:settings.revision,items:(Object.keys(MEMORY_PROMPT_LABELS) as MemoryPromptId[]).map(id=>({id,label:MEMORY_PROMPT_LABELS[id],
  model:['fuse','verify'].includes(id)?'SIWC 主聊天模型':'记忆小模型',content:settings.overrides[id] ?? defaultMemoryPrompt(id),
  defaultContent:defaultMemoryPrompt(id),customized:settings.overrides[id] !== undefined}))};
}
export function saveMemoryPrompt(db: DatabaseSync,input: Record<string,unknown>) {
 if (typeof input.id !== 'string' || !Object.hasOwn(MEMORY_PROMPT_LABELS,input.id) || !Number.isSafeInteger(input.expectedRevision) ||
   (input.reset !== undefined && typeof input.reset !== 'boolean') || (input.reset !== true && (typeof input.content !== 'string' || !input.content.trim() || input.content.length>24000 || input.content.includes('\0'))))
  throw new ControlDataError('invalid_request',400,'提示词不能为空，且不得超过 24000 字符。');
 return transaction(db,()=>{
  const settings=readMemoryPrompts(db);
  if(settings.revision!==input.expectedRevision)throw new ControlDataError('revision_conflict',409,'提示词已在别处更新，请重新读取后合并。');
  const id=input.id as MemoryPromptId;
  if(input.reset===true)delete settings.overrides[id];else settings.overrides[id]=input.content as string;
  settings.revision++;
  putState(db,{key:MEMORY_PROMPTS_KEY,category:'settings',value:JSON.stringify(settings)});
  return listMemoryPrompts(db);
 });
}
