import type { RuntimeTool } from "../runtime/types.js";
export const HEARTBEAT_REPLAN_TOOL: RuntimeTool = {
  name: "gateway_heartbeat_replan", readOnly: false, replaySafe: true,
  description: "仅当用户明确要求调整主动联系安排时申请重新规划。普通闲聊不调用。创建具体时间提醒请使用提醒工具。",
  parameters: {type: "object", additionalProperties: false, required: ["reason"], properties: {reason: {type: "string", maxLength: 500}}},
};
