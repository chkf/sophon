import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readJsonFile,writeJsonAtomic} from '../util/atomic-json.js';
import {SerialQueue} from '../util/serial-queue.js';
export interface ProactiveInterval {minIntervalMinutes:number;maxIntervalMinutes:number;revision:string}
interface Settings {enabled?:boolean;interval?:ProactiveInterval}
/** Explicit panel choices persist across restarts; environment is the initial default. */
export class ProactiveSettings {
 private readonly path:string;
 private readonly queue=new SerialQueue();
 constructor(dataDir:string,private readonly initialEnabled:boolean,private readonly initialInterval={minIntervalMinutes:60,maxIntervalMinutes:120},private readonly onChanged:()=>void=()=>{}){this.path=join(dataDir,'heartbeat','settings.json');}
 async migrateChannel(router:import('../channels/active.js').ActiveChannelRouter,fallback:import('../channels/types.js').ChannelName):Promise<void>{
  if(await router.getActive()!=="off")return;
  if(!await this.hasChoice())await this.setEnabled(false);
  await router.setActive(fallback);
 }
 async hasChoice():Promise<boolean>{return typeof (await this.read()).enabled==='boolean';}
 async explicitlyEnabled():Promise<boolean>{return (await this.read()).enabled===true;}
 async enabled():Promise<boolean>{const value=(await this.read()).enabled;return typeof value==='boolean'?value:this.initialEnabled;}
 private read():Promise<Settings>{return readJsonFile(this.path,{});}
 private update(change:(state:Settings)=>void):Promise<void>{return this.queue.run(async()=>{const state=await this.read();change(state);await writeJsonAtomic(this.path,state);this.onChanged();});}
 async setEnabled(enabled:boolean):Promise<void>{await this.update(state=>{state.enabled=enabled;});}
 async interval():Promise<ProactiveInterval>{return (await this.read()).interval??{...this.initialInterval,revision:'environment'};}
 async setInterval(min:number,max:number):Promise<void>{
  if(!Number.isSafeInteger(min)||!Number.isSafeInteger(max)||min<1||max<min||max>1440)throw Error('主动检查间隔须为 1–1440 分钟，最小值不得大于最大值。');
  await this.update(state=>{state.interval={minIntervalMinutes:min,maxIntervalMinutes:max,revision:randomUUID()};});
 }
}
