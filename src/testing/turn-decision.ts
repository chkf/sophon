import type { ChatRequest } from '../runtime/types.js';
import { DECISION_TOOL_NAME } from '../runtime/turn-decision.js';

/** Synthetic model decision for integration tests that exercise a specific capability. */
export async function selectTestTurn(request: ChatRequest, options: {groups?: string[]; voice?: boolean; sticker?: boolean; quote?: boolean} = {}): Promise<void> {
  const definition = request.tools?.find(tool => tool.name === DECISION_TOOL_NAME);
  if (!definition) return;
  if (options.groups?.length) await request.executeTool!("gateway_load_tools", {groups: options.groups});
  await request.executeTool!(DECISION_TOOL_NAME, {
    stage_direction: '查看示例文档', reply_mode: options.voice ? 'voice' : 'text',
    sticker: options.sticker ? 'consider' : 'skip', quote: options.quote ? 'consider' : 'skip', image: 'skip',
  });
}
