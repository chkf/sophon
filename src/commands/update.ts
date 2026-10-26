import {randomUUID} from 'node:crypto';

/** Requests travel only on the IPC channel created by the local managed host. */
export async function requestHostUpdate(args:string):Promise<string>{
 if(!process.send||!process.connected||process.env.SOPHON_MANAGED_HOST!=='1')return '当前未由更新管理进程启动。请在部署目录使用 npm start；命令行可用 npm run update。';
 const value=args.trim();if(value&&!/^[a-z][a-z0-9_-]{0,31}$/.test(value))return '用法：/update [已配置上游名]；/update sources；/update status。';
 const action=value==='status'||value==='sources'?value:'update',id=randomUUID();
 return new Promise(resolve=>{
  const done=(text:string)=>{clearTimeout(timer);process.off('message',receive);resolve(text);};
  const receive=(raw:unknown)=>{const message=raw as {type?:string;id?:string;text?:string};if(message?.type==='sophon:host-response'&&message.id===id&&typeof message.text==='string')done(message.text);};
  const timer=setTimeout(()=>done('管理进程未及时响应，请在部署目录检查更新状态。'),5000);
  process.on('message',receive);
  process.send!({type:'sophon:host-request',id,action,...(action==='update'&&value?{source:value}:{})},error=>{if(error)done('更新管理进程连接已断开。');});
 });
}
