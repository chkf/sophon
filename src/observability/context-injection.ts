import type { ContextInjection, ContextSource } from "./types.js";

type Sources = Array<Omit<ContextSource, "content">> | undefined;
export function contextAttribution(sources: Sources, policy: ContextInjection["delivery"]): ContextInjection[] {
  return (sources ?? []).map(source=>({source:source.id,delivery:source.placement === "turn" ? "sent" : policy}));
}

/** Transport facts only: never infer the content of an opaque checkpoint. */
export function siwcContextAttribution(input: { sources: Sources; policySent: boolean; continues: boolean;
  replay: boolean; memoryRevision?: number; historyItems: number; historyTruncated: boolean; currentUserSent: boolean;
  toolResults: number; tools: number; liveContextSent: boolean }): ContextInjection[] {
  const policy = input.policySent ? "sent" : input.continues ? "inherited" : input.replay ? "replayed" : "omitted";
  return [...contextAttribution(input.sources, policy).map(item => input.sources?.find(source=>source.id===item.source)?.placement === "recovery"
    ? {...item, delivery:input.liveContextSent ? "sent" as const : input.continues ? "inherited" as const : input.replay ? "replayed" as const : "omitted" as const} : item),
    {source:"runtime_guidance",delivery:policy,detail:"Provider 协议与工具调用指导；与基础指令一起处理。"},
    {source:"history",delivery:input.historyItems ? "sent" : input.continues ? "inherited" : input.replay ? "replayed" : "omitted",
      detail:input.historyItems ? `本次输入含 ${input.historyItems} 个历史 / 恢复条目${input.historyTruncated ? "；历史窗口已裁剪" : ""}。` : "未单独重发聊天历史；沿用或恢复的内容无法逐条枚举。"},
    {source:"memory_seed",delivery:input.memoryRevision ? input.continues ? "inherited" : input.replay ? "replayed" : "omitted" : "omitted",
      detail:input.memoryRevision ? `记忆图重建摘要，修订 ${input.memoryRevision}；在建立或重建会话时提供。` : "本次未使用记忆图重建摘要。"},
    {source:"checkpoint",delivery:input.replay ? "replayed" : input.continues ? "inherited" : "omitted",
      detail:input.replay ? "从本地恢复项重放；可能包含记忆种子或压缩检查点，不展示不透明内容。" : input.continues ? "通过 previous_response_id 延续已有会话。" : "本次没有沿用服务端会话或重放检查点。"},
    {source:"current_user",delivery:input.currentUserSent ? "sent" : "inherited",detail:"本轮消息、引用上下文及受支持的附件；附件字节不记录。"},
    {source:"tool_results",delivery:input.toolResults ? "sent" : "omitted",detail:`本次传入 ${input.toolResults} 个工具返回。`},
    {source:"tools",delivery:input.tools ? "sent" : "omitted",detail:`实际提供 ${input.tools} 个工具定义。`},
    {source:"live_context",delivery:input.liveContextSent ? "sent" : "omitted",detail:"会话建立或恢复时的数据快照；Recent 已单独归类。"},
  ];
}
