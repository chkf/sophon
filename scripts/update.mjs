import {prepareControlDependency} from './host/cloudflared-install.mjs';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {readSources,selectSource,stateDirectory,readJson,acquireLock,prepareRelease,currentRelease,saveRelease,atomicJson,runCommand,releaseFromPointer} from './host/releases.mjs';
const root=resolve(fileURLToPath(new URL('../',import.meta.url))),args=process.argv.slice(2);
if(args.length>1)throw Error('Usage: npm run update -- [source-name|sources|status|rollback]');
const config=await readSources(root),dir=await stateDirectory(root),action=args[0];
if(action==='sources'){console.log(JSON.stringify(config,null,2));}
else if(action==='status'){console.log(JSON.stringify(await readJson(join(dir,'status.json'),{phase:'idle'}),null,2));}
else{
 const source=action==='rollback'?{name:'rollback'}:selectSource(config,action),owner=await readJson(join(dir,'host.lock','owner.json'),null);
 let running=false;if(owner?.pid)try{process.kill(owner.pid,0);running=true;}catch(error){if(error.code==='EPERM')running=true;}
 if(running&&owner.role!=='supervisor')throw Error('Another offline update is running.');
 if(running){
  await writeFile(join(dir,'request.json'),JSON.stringify({id:randomUUID(),source:source.name}),{mode:0o600,flag:'wx'});
  console.log('Update requested. Inspect: npm run update -- status');
 }else{
  const hostUnlock=await acquireLock(root,'host',{role:'offline-update'});
  let unlock;
  try{
   unlock=await acquireLock(root,'update');
   const previous=await currentRelease(root);
   const prior=action==='rollback'?await readJson(join(dir,'previous.json'),undefined):undefined;
   if(action==='rollback'&&prior===undefined)throw Error('No previous release available.');
   const candidate=action==='rollback'?{...await releaseFromPointer(root,prior),unchanged:false}:await prepareRelease(root,source);
   await prepareControlDependency(root);
   if(candidate.unchanged)console.log('Already running this upstream commit.');
   else{
    await runCommand(process.execPath,[fileURLToPath(new URL('./host/check-release.mjs',import.meta.url)),candidate.path],root,process.env);
    await atomicJson(join(dir,'previous.json'),previous.pointer);await saveRelease(root,candidate.pointer);
    await atomicJson(join(dir,'status.json'),{phase:'prepared',source:source.name,sha:candidate.pointer?.sha??"initial"});
    console.log('Release prepared. Start it with npm start. Directly started processes are not restarted.');
   }
  }finally{await unlock?.();await hostUnlock();}
 }
}
