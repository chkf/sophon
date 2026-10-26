import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
async function check(path){
 for(const entry of await readdir(path,{withFileTypes:true})){
  const file=join(path,entry.name);
  if(entry.isDirectory())await check(file);
  else if(file.endsWith('.mjs')){
   const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});
   if(result.status!==0)throw Error('Host syntax check failed.');
  }
 }
}
await check(fileURLToPath(new URL('./',import.meta.url)));
