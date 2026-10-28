import {ReminderStore,type Reminder} from './store.js';
import {SerialQueue} from '../util/serial-queue.js';
/** Timer-free delivery step; durable claims prevent replay after uncertain sends. */
export class ReminderRunner {
 private readonly queue=new SerialQueue();
 constructor(private readonly store:ReminderStore,private readonly available:(task:Reminder)=>Promise<boolean>,private readonly deliver:(task:Reminder)=>Promise<void>){}
 async start():Promise<void>{await this.store.recover();}
 async stop():Promise<void>{await this.queue.drain();}
 tick(now=new Date()):Promise<boolean>{return this.queue.run(async()=>{
  let attempted=false;
  for(const item of await this.store.list()){
   if(item.status!=='pending'||Date.parse(item.dueAt)>now.getTime())continue;
   const expired=now.getTime()-Date.parse(item.dueAt)>86400_000;
   if(!expired&&!await this.available(item))continue;
   const claimed=await this.store.claim(item.id,now);if(!claimed)continue;
   attempted=true;
   try{await this.deliver(claimed);await this.store.finish(item.id,'delivered',now);}
   catch{await this.store.finish(item.id,'unknown',now);}
  }
  return attempted;
 });}
}
