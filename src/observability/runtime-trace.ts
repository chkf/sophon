import type { RuntimeTraceObserver, TraceStepFinish, TraceStepStart } from "./types.js";

/** Observability must never turn a safe model/tool operation into a retry. */
export function safeTraceStart(observer: RuntimeTraceObserver | undefined, event: TraceStepStart): string | undefined {
  try {
    if (observer?.captureContent === false) { const {input:_input,...metadata}=event; return observer.start(metadata); }
    return observer?.start(event);
  } catch { return undefined; }
}
export function safeTraceFinish(observer: RuntimeTraceObserver | undefined, id: string | undefined, event: TraceStepFinish): void {
  try {
    if (observer?.captureContent === false) { const {output:_output,error:_error,...metadata}=event; observer.finish(id,metadata); }
    else observer?.finish(id, event);
  } catch { /* The original operation is authoritative. */ }
}
