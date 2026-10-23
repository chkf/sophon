import { DatabaseSync } from "node:sqlite";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { loadCore } from "../core/loader.js";
import { HostTestRunner } from "./host-tests.js";
import type { Diagnostic } from "./diagnostics.js";
export function systemDiagnostics(dataDir:string, checks:{services:()=>Promise<string>;queue:()=>string;heartbeat:()=>Promise<string>}):Diagnostic[] {
  const scripts=new HostTestRunner();
  const core=async()=>{await loadCore(dataDir);return "Core：通过（未展示正文）";};
  const database=async()=>{
    const db=new DatabaseSync(join(dataDir,"sessions","gateway.sqlite"),{readOnly:true});
    try { const rows=db.prepare("PRAGMA quick_check").all();
      const okay=rows.length===1 && Object.values(rows[0]!).includes("ok");
      return "SQLite 完整性："+(okay?"通过":"异常，请通过 SSH 检查并保留备份");
    } finally {db.close();}
  };
  const disk=async()=>{const s=await statfs(dataDir);return "磁盘可用："+(s.bavail*s.bsize/1024**3).toFixed(2)+" GiB";};
  const basic=[{label:"服务与认证",run:checks.services},{label:"Core",run:core},{label:"数据库",run:database},{label:"磁盘",run:disk}];
  return [
    {id:"quick",group:"一键体检",label:"基础体检",description:"检查服务、认证、Core、数据库和磁盘；不调用模型。",run:async()=>{
      const results=[];for(const c of basic){try{results.push(await c.run());}catch{results.push(c.label+"：异常或不可用");}}return results.join("\n");
    }},
    {id:"services",group:"服务状态",label:"服务与认证",description:"读取登录状态并检查本地 Core，不调用模型。",run:checks.services},
    {id:"queue",group:"会话与队列",label:"待回复队列",description:"查看消息数、暂停原因和重试状态，不展示聊天正文。",run:async()=>checks.queue()},
    {id:"heartbeat",group:"主动消息",label:"计划与静默状态",description:"读取渠道、下次唤醒与当前发送条件。",run:checks.heartbeat},
    {id:"core",group:"本地数据",label:"Core 校验",description:"校验文件，不读取到聊天中。",run:core},
    {id:"database",group:"本地数据",label:"SQLite 完整性",description:"只读 quick_check，不修改历史。",run:database},
    {id:"disk",group:"本地数据",label:"磁盘空间",description:"检查数据目录所在磁盘的可用容量。",run:disk},
    ...(["typecheck","test"] as const).map(script=>({id:script,group:"开发测试",label:({typecheck:"类型检查",test:"单元测试"}[script]),description:"运行固定脚本 "+script+"。",cancellable:true,timeoutMs:300_000,run:(signal:AbortSignal)=>scripts.run(script,signal)})),
  ];
}
