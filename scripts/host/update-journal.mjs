import {appendFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {atomicJson,readJson,stateDirectory} from './releases.mjs';

export async function saveUpdateStatus(root,result){
 const dir=await stateDirectory(root);
 if(result.id&&['completed','current','failed','rolled_back','interrupted','unhealthy','prepared'].includes(result.phase)){
  const prior=await readJson(join(dir,'results.json'),[]);
  await atomicJson(join(dir,'results.json'),[...prior.filter(item=>item.id!==result.id),result].slice(-50));
 }
 await atomicJson(join(dir,'status.json'),result);
}

export const stageNames={lock:'更新锁检查',fetch:'检查上游',protocol:'更新协议检查',dependencies:'准备依赖',build:'构建',tests:'测试',components:'检查可选组件',schema:'数据库兼容性检查',shutdown:'停止原进程',startup:'启动服务',activation:'保存版本',health:'健康检查'};
export function failureHint(stage){
 return {fetch:'请检查上游仓库、分支和网络。',dependencies:'请检查 npm 网络、Node.js 版本和可用磁盘空间。',build:'请在本机更新日志中查看编译错误。',tests:'请在本机更新日志中查看失败用例；完整测试需要 ffmpeg 和 ffprobe。',schema:'现有数据与目标版本不兼容；请按迁移说明处理。',startup:'请检查本机服务日志和端口占用。',health:'服务未通过健康检查，已尝试恢复上一版本。',protocol:'所选上游不支持当前更新协议。'}[stage]??'请检查本机更新日志和更新状态。';
}
export function statusText(value){
 const phases={idle:'尚无更新记录',preparing:'正在准备更新',switching:'正在切换版本',completed:'更新成功',current:'已是最新版本',unhealthy:'服务健康检查未通过',failed:'更新失败',rolled_back:'已恢复原版本',interrupted:'上次更新中断',prepared:'已准备，下次启动时生效'};
 const lines=[phases[value.phase]??'更新状态未知'];
 if(stageNames[value.stage])lines.push('阶段：'+stageNames[value.stage]);
 if(/^[a-z][a-z0-9_-]{0,31}$/.test(value.source??''))lines.push('上游：'+value.source);
 if(/^[a-f0-9]{40}$/.test(value.sha??''))lines.push('版本：'+value.sha.slice(0,12));
 if(value.phase==='failed'||value.phase==='rolled_back')lines.push(failureHint(value.stage));
 if(value.plan)lines.push('依赖：'+(value.plan.dependencies?'安装':'复用')+'；构建：'+(value.plan.build?'执行':'复用')+'；测试：'+(value.plan.tests?'执行':'无需执行'));
 lines.push('本机日志：.sophon-updates/update.log');
 return lines.join('\n');
}
export async function createUpdateJournal(root,initial){
 const dir=await stateDirectory(root),file=join(dir,'update.log');
 await writeFile(file,'',{mode:0o600});
 let state={...initial,phase:'preparing'},size=0,chain=Promise.resolve(),pending='',discarding=false;
 const secrets=Object.entries(process.env).filter(([key,value])=>/token|secret|password|api.?key|credential/i.test(key)&&value?.length>=6).map(([,value])=>value);
 const append=text=>{
  let safe=String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g,'https://[redacted]@');
  for(const secret of secrets)safe=safe.split(secret).join('[redacted]');
  const bytes=Buffer.from(safe),remaining=2*1024*1024-size;
  if(remaining<=0)return;
  const chunk=bytes.subarray(0,remaining);size+=chunk.length;
  chain=chain.then(()=>appendFile(file,chunk)).catch(()=>{});
 };
 const output=text=>{
  // Redact complete lines so a credential split across stream chunks is still removed.
  const parts=String(text).split('\n');
  for(let i=0;i<parts.length;i++){
   if(!discarding)pending+=parts[i];
   if(pending.length>64*1024){pending='';discarding=true;}
   if(i<parts.length-1){append(discarding?'[oversized output line omitted]\n':pending+'\n');pending='';discarding=false;}
  }
 };
 const stage=async(name,details={})=>{
  state={...state,...details,stage:name,at:new Date().toISOString()};
  output('\n['+state.at+'] '+(stageNames[name]??name)+'\n');
  await atomicJson(join(dir,'status.json'),state);
  console.log('[update] '+(stageNames[name]??name));
 };
 return {stage,output,flush:()=>{if(pending||discarding)output('\n');return chain;},get value(){return state;}};
}
