import type { ContextSource, RuntimeTraceObserver } from "../observability/types.js";
import type { TaskTraceStore } from "../observability/store.js";
import { safeTraceStart, safeTraceFinish } from "../observability/runtime-trace.js";

/** All recording is best effort; storage errors must never cause a model/tool retry. */
export function beginCallTrace(getStore: (() => TaskTraceStore | undefined) | undefined, channel: string) {
  try {
    const store = getStore?.();
    if (!store) return undefined;
    const id = store.begin({kind:"chat",trigger:"inbound_message",channel});
    const observer = store.observer(id);
    return { id, observer,
      finish(error?: unknown) {
        try { store.finish(id, error === undefined
          ? {status:"completed",reason:"runtime_completed"}
          : {status:"failed",reason:error instanceof Error ? error.message : "runtime_failed"}); }
        catch { /* Diagnostics cannot affect chat delivery. */ }
      },
    };
  } catch { return undefined; }
}

export function recordContextSources(observer: RuntimeTraceObserver | undefined, sources: ContextSource[]): void {
  if (!observer) return;
  for (const source of sources) {
    const id = safeTraceStart(observer, {kind:"context",name:source.label,
      input:{source:source.id,placement:source.placement,content:source.placement === "policy" ? source.content.slice(0,24000) : "〔内容快照已省略 · " + source.content.length + " 字符；仅影响诊断展示〕",contentTruncated:source.placement === "policy" && source.content.length>24000}});
    safeTraceFinish(observer,id,{status:"completed"});
  }
}
