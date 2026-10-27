import {join} from 'node:path';
import {readJsonFile,writeJsonAtomic} from '../util/atomic-json.js';

/** Explicit panel choices persist across restarts; environment is the initial default. */
export class ProactiveSettings {
 private readonly path:string;
 constructor(dataDir:string,private readonly initialEnabled:boolean){this.path=join(dataDir,'heartbeat','settings.json');}
 async explicitlyEnabled():Promise<boolean>{return (await this.read())===true;}
 async enabled():Promise<boolean>{return (await this.read())??this.initialEnabled;}
 private async read():Promise<boolean|undefined>{
  const state=await readJsonFile<{enabled?:boolean}>(this.path,{});
  return typeof state.enabled==='boolean'?state.enabled:undefined;
 }
 async setEnabled(enabled:boolean):Promise<void>{await writeJsonAtomic(this.path,{enabled});}
}
