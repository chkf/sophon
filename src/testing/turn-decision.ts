import type { ChatRequest } from '../runtime/types.js';
import { DECISION_TOOL_NAME } from '../runtime/turn-decision.js';

/** Synthetic model decision for integration tests that exercise a specific capability. */
export async function selectTestTurn(request: ChatRequest, options: {groups?: string[]; voice?: boolean; sticker?: boolean; quote?: boolean} = {}): Promise<void> {
  const definition = request.tools?.find(tool => tool.name === DECISION_TOOL_NAME);
  if (!definition) return;
  const properties = definition.parameters.properties as Record<string, any>;
  await request.executeTool!(DECISION_TOOL_NAME, {
    stage_direction: '查看示例文档', reply_mode: options.voice ? 'voice' : 'text',
    memory: {need_score: 0, query: null, ids: null},
    sticker: options.sticker ? 'consider' : 'skip', quote: options.quote ? 'consider' : 'skip', image: 'skip',
    ...(properties.tool_groups ? {tool_groups: options.groups ?? []} : {}),
  });
}
