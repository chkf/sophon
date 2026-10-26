import { isBackfillJob } from './bootstrap.js';
import { MemoryOrganizer } from './organizer.js';
import { MemoryRecent } from './recent.js';
import { prepareLongTurn } from './long-turn.js';
import { jsonObject } from './tasks.js';
import type { ChatRuntime } from '../runtime/types.js';
import { classificationInput } from './classifier.js';
import { MemoryStore } from './store.js';
import { MemoryError, parseClassification } from './validation.js';
import { isSubscriptionUsageLimitError } from '../runtime/retry-policy.js';
/** One model call at a time; durable leases survive restarts. No raw content in errors/logs. */
export class MemoryWorker {
  private timer?:NodeJS.Timeout;
  private active?:Promise<void>;
  private stopped=true;
  private pausedUntil=0;
  private lastModel?:string;
  private pausedCode?:string;
  private runtimeState?:string;
  status():string|undefined{return this.runtimeState;}
  constructor(private readonly store:MemoryStore,private readonly runtime:ChatRuntime,private readonly canStart:()=>boolean=()=>true){}
  start():void { if(!this.stopped)return;this.stopped=false;this.schedule(); }
  private schedule():void {
    if(this.stopped)return;
    this.timer=setTimeout(()=>{void this.tick().catch(()=>console.error('[memory] worker_failed')).finally(()=>this.schedule());},5000);
    this.timer.unref();
  }
  async tick(now=new Date()):Promise<void> {
    if(this.active||!this.canStart())return;
    if(this.runtime.getMemoryModel) {
      try {
        const model=await this.runtime.getMemoryModel();
        if(this.lastModel!==undefined && model!==this.lastModel) {
          this.store.resumeAfterModelChange(now);
          if(this.pausedCode!=='QUOTA_UNAVAILABLE')this.pausedUntil=0;
        }
        this.lastModel=model;
      } catch { this.runtimeState='MODEL_UNAVAILABLE';return; }
    }
    if(+now<this.pausedUntil)return;
    new MemoryRecent(this.store).sync();
    const job=this.store.claim(now);
    this.active=(async()=>{
      try {
        if(!job){await new MemoryOrganizer(this.store).tick(this.runtime,now);this.runtimeState=undefined;return;}
        if(!this.runtime.classifyMemory)throw new MemoryError('CLASSIFIER_UNAVAILABLE');
        const turn=this.store.collect(job.assistant_rowid),revision=this.store.revision();
        const prepared=await prepareLongTurn(this.store,job,turn,this.runtime);
        if(!prepared.ready){this.store.yield(job);return;}
        const input=classificationInput(turn,this.store.topics(),revision,prepared.digest);
        const output=await this.runtime.classifyMemory(input);
        this.runtimeState=undefined;
        const classification=parseClassification(output);
        // Optional reinforcement never blocks recording a delivered turn when unavailable.
        let evidence:unknown;
        if(!isBackfillJob(this.store,job)&&this.canStart()&&this.runtime.runMemoryTask){
          const candidate=this.store.reinforcementInput(turn);
          if(candidate)try{evidence=jsonObject(await this.runtime.runMemoryTask('reinforce',JSON.stringify(candidate))).evidence;}catch{ /* No unverified reinforcement. */ }
        }
        this.store.complete(job,turn,revision,classification,new Date());
        if(evidence)try{this.store.reinforce(turn,evidence);}catch{console.error('[memory] reinforcement_rejected');}
      } catch(error) {
        const code=error instanceof MemoryError?error.code:isSubscriptionUsageLimitError(error)?'QUOTA_UNAVAILABLE':'MODEL_UNAVAILABLE';
        this.runtimeState=code;
        if(job&&code==='NO_USER_TURN'){this.store.finishEmpty(job);return;}
        const delay=job?this.store.retry(job,code,new Date()):60_000;
        // A missing model/quota should not probe once per queued turn.
        if(['CLASSIFIER_UNAVAILABLE','MODEL_UNAVAILABLE','QUOTA_UNAVAILABLE'].includes(code)){this.pausedUntil=Date.now()+delay;this.pausedCode=code;}
        console.error('[memory] job='+(job?.id??'organize')+' status=retry code='+code);
      }
    })();
    try{await this.active;}finally{this.active=undefined;}
  }
  async stop():Promise<void> { this.stopped=true;if(this.timer)clearTimeout(this.timer);await this.active; }
}

