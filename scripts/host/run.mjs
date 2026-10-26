import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {launchHost} from './launcher.mjs';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const controller=new AbortController();
const stop=()=>controller.abort();
process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{await launchHost(root,{signal:controller.signal});}
catch{console.error('[host] manager stopped; inspect the local update status and logs.');process.exitCode=1;}
finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
