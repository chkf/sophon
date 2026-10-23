import type { RuntimeTool } from "../types.js";

export const FUNCTION_CALL_GUIDANCE = "工具必须通过真实 function_call 执行，并根据真实回执确认结果；禁止文字模拟工具调用或把登记意图说成已经送达。";

export function toolNamespace(tools: RuntimeTool[]): Record<string, unknown>[] {
  if (!tools.length) return [];
  return [{
    type: "namespace",
    name: "gateway",
    description: FUNCTION_CALL_GUIDANCE,
    tools: tools.map((tool) => ({
      type: "function",
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
      strict: false,
    })),
  }];
}
