import {ReminderStore,type Reminder} from './store.js';
import {SerialQueue} from '../util/serial-queue.js';
export class ReminderRunner {
 private timer?:NodeJS.Timeout;
 private pending?:Promise<void>;
 private running=false;
 private readonly queue=new SerialQueue();
 constructor(private readonly store:ReminderStore,private readonly available:(task:Reminder)=>Promise<boolean>,private readonly deliver:(task:Reminder)=>Promise<void>){}
 async start():Promise<void>{if(this.running)return;await this.store.recover();this.running=true;this.schedule(0);}
 private schedule(delay=1000):void{if(!this.running)return;this.timer=setTimeout(()=>{
  this.pending=this.tick().catch(()=>{console.error('[reminders] scheduler failed; inspect local task status');}).finally(()=>{this.schedule();});
 },delay);this.timer.unref?.();}
 async stop():Promise<void>{this.running=false;if(this.timer)clearTimeout(this.timer);await this.pending;}
 tick(now=new Date()):Promise<void>{return this.queue.run(async()=>{
  for(const item of await this.store.list()){
   if(item.status!=='pending'||Date.parse(item.dueAt)>now.getTime())continue;
   const expired=now.getTime()-Date.parse(item.dueAt)>86400_000;
   if(!expired&&!await this.available(item))continue;
   const claimed=await this.store.claim(item.id,now);if(!claimed)continue;
   // Claim is durable before any network side effect; interrupted or uncertain sends never replay.
   try{await this.deliver(claimed);await this.store.finish(item.id,'delivered',now);}
   catch{await this.store.finish(item.id,'unknown',now);}
  }
 });}
}
