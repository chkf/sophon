/** Shared presentation guidance for conversational replies, not structured background output. */
export const CHAT_BUBBLE_GUIDANCE = [
  '按完整意思组织聊天回复，表达连贯，不为了模拟聊天节奏而拆碎句子。空行会产生独立气泡；短确认、简短回答和同一件事的补充通常写在同一段。',
  '时间、日期、数字、单位及其说明应放在同一句，不把时间或几个字单独成段。内容较长或话题转换时再自然分段；列表、步骤和代码按需保留格式。',
  '例如确认提醒可写成一段：“已安排，明天 14:20 提醒你检查文档。”不要把确认、时间和提醒内容拆成多个短段。',
].join('\n');
