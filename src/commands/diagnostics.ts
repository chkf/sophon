import { randomUUID } from "node:crypto";
import { redactLogText } from "./host-logs.js";
import type { PanelView } from "../channels/telegram/panels.js";
export interface Diagnostic {
  id: string; group: string; label: string; description: string;
  cost?: string; timeoutMs?: number; cancellable?: boolean;
  run: (signal: AbortSignal) => Promise<string>;
}
/** Registered functions and validated UI choices only; no user shell or argv. */
export class DiagnosticRegistry {
  readonly items: Diagnostic[];
  private active?: { id: string; controller: AbortController; label: string };
  constructor(items: Diagnostic[]) {
    if (new Set(items.map(i=>i.id)).size!==items.length) throw new Error("诊断项目编号重复。");
    this.items=items;
  }
  async launch(item: Diagnostic, back: () => Promise<PanelView>): Promise<PanelView> {
    if(this.active)return {text:"已有诊断正在运行："+this.active.label,rows:[[{text:"返回",run:back}]]};
    const task={id:randomUUID(),controller:new AbortController(),label:item.label};this.active=task;
    const started=Date.now();
    // Cancellation waits for the actual operation to settle; don't release the
    // concurrency slot while an upstream paid request may still be executing.
    const completion=(async():Promise<PanelView>=>{
      const timer=setTimeout(()=>task.controller.abort(),item.timeoutMs??120_000);timer.unref?.();
      let details:string;let status:string;
      try {details=await item.run(task.controller.signal);status=task.controller.signal.aborted?"已停止或超时":/异常|不可用|失败|FAIL/.test(details)?"异常":"通过";}
      catch {details="检查未完成。请检查服务状态或查看对应时段日志。";status=task.controller.signal.aborted?"已停止或超时":"异常";}
      finally {clearTimeout(timer);if(this.active?.id===task.id)this.active=undefined;}
      const safe=redactLogText(details).slice(-3200);
      const summary=item.label+" · "+status+" · "+((Date.now()-started)/1000).toFixed(1)+"s\n"+safe.slice(0,600);
      const again=()=>item.cost?Promise.resolve(this.confirm(item,back)):this.launch(item,back);
      return {text:summary,autoDelete:true,rows:[[{text:"查看详情",run:async()=>({text:safe||"没有详细输出。",autoDelete:true,rows:[[{text:"返回诊断",run:back}]]})}],
        [{text:"重新运行",run:again},{text:"返回诊断",run:back}]]};
    })();
    const view:PanelView={text:"正在运行："+item.label+"\n"+item.description,rows:[],follow:completion};
    if(item.cancellable) view.rows.push([{text:"停止测试",run:async()=>{
      if(this.active?.id===task.id)task.controller.abort();
      return {text:"已请求停止，正在等待执行退出。",rows:[],follow:completion};
    }}]);
    return view;
  }
  confirm(item:Diagnostic,back:()=>Promise<PanelView>):PanelView {
    return {text:item.label+"\n"+item.description+"\n"+(item.cost??""),rows:[[{text:"运行测试",run:()=>this.launch(item,back)},{text:"返回",run:back}]]};
  }
  async menu(group?:string):Promise<PanelView> {
    if(!group)return {text:"诊断面板\n按功能选择；一键体检不调用模型。",rows:[...new Set(this.items.map(i=>i.group))].map(g=>[{text:g,run:()=>this.menu(g)}])};
    return {text:group,rows:[...this.items.filter(i=>i.group===group).map(item=>[{text:item.label+(item.cost?" · 消耗额度":""),run:async()=>this.confirm(item,()=>this.menu(group))}]),[{text:"返回分类",run:()=>this.menu()}]]};
  }
  stop() {if(this.active)this.active.controller.abort();}
}
