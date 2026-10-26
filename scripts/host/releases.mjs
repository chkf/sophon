import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rename,rm,lstat,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {commandSpec} from './process.mjs';
import {updatePlan,reusableArtifacts,copyArtifacts,changedTreeFiles,runtimeIdentity} from './update-plan.mjs';

export const DEFAULT_SOURCES={default:'official',sources:{official:{repository:'chkf/sophon',branch:'main'}}};
const namePattern=/^[a-z][a-z0-9_-]{0,31}$/;
const shaPattern=/^[a-f0-9]{40}$/;
export function validateSources(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['default','sources'].includes(k))||
 typeof value.default!=='string'||!namePattern.test(value.default)||!value.sources||typeof value.sources!=='object'||Array.isArray(value.sources)||!Object.hasOwn(value.sources,value.default))throw Error('Invalid update source configuration.');
 const entries=Object.entries(value.sources);
 if(!entries.length||entries.length>16)throw Error('Configure between 1 and 16 update sources.');
 for(const [name,source] of entries){
  if(['sources','status','rollback'].includes(name)||!namePattern.test(name)||!source||typeof source!=='object'||Object.keys(source).some(k=>!['repository','branch'].includes(k))||
   typeof source.repository!=='string'||! /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(source.repository)||source.repository.endsWith('.git')||
   typeof source.branch!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(source.branch)||source.branch.includes('..')||source.branch.includes('//')||source.branch.endsWith('/')||source.branch.endsWith('.lock'))throw Error('Invalid configured update source.');
 }
 return value;
}
export async function readSources(root){
 try{return validateSources(JSON.parse(await readFile(join(root,'update-sources.json'),'utf8')));}
 catch(error){if(error.code==='ENOENT')return structuredClone(DEFAULT_SOURCES);throw error;}
}
export function selectSource(config,name=config.default){
 if(!namePattern.test(name)||!Object.hasOwn(config.sources,name))throw Error('Unknown configured update source.');
 return {name,...config.sources[name]};
}
async function plainDirectory(path){
 await mkdir(path,{recursive:true,mode:0o700});const stat=await lstat(path);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Update directories must not be symbolic links.');
}
export async function stateDirectory(root){
 const dir=join(resolve(root),'.sophon-updates');await plainDirectory(dir);await plainDirectory(join(dir,'releases'));return dir;
}
export async function atomicJson(path,value){
 const temp=path+'.'+randomUUID()+'.tmp';
 try{await writeFile(temp,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});await rename(temp,path);}
 finally{await rm(temp,{force:true});}
}
export async function readJson(path,fallback){try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
export async function acquireLock(root,name,metadata={}){
 const dir=await stateDirectory(root),path=join(dir,name+'.lock');
 try{await mkdir(path,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw Error(name+' lock exists; another operation may be running. See docs/updating.md for interrupted-lock recovery.');throw error;}
 await atomicJson(join(path,'owner.json'),{...metadata,pid:process.pid,startedAt:new Date().toISOString()});
 return ()=>rm(path,{recursive:true,force:true});
}
export function buildEnvironment(env=process.env){
 const result={GIT_TERMINAL_PROMPT:'0',CI:'true'};
 const allowed=new Set(['PATH','PATHEXT','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SYSTEMROOT','SYSTEMDRIVE','WINDIR','COMSPEC','TEMP','TMP','TMPDIR','LANG','TZ','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY']);
 for(const [key,value] of Object.entries(env))if(value&&allowed.has(key.toUpperCase()))result[key]=value;
 return result;
}
export async function runCommand(command,args,cwd,env=buildEnvironment(),{onOutput=()=>{},signal}={}){
 const spec=commandSpec(command,args);
 return new Promise((resolve,reject)=>{
  const child=spawn(spec.file,spec.args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe'],signal,timeout:20*60_000});
  let stdout='',failed=false;
  for(const [stream,capture] of [[child.stdout,true],[child.stderr,false]]){
   stream.setEncoding('utf8');stream.on('data',chunk=>{
    onOutput(chunk);if(capture){stdout+=chunk;if(Buffer.byteLength(stdout)>8*1024*1024){failed=true;child.kill();stdout='';}}
   });
  }
  child.once('error',()=>{failed=true;});
  // Wait for close: output is drained and no candidate process is left running.
  child.once('close',code=>{
   if(code===0&&!failed)resolve(stdout.trim());
   else reject(Object.assign(Error('Update command failed; inspect the local update log.'),{exitCode:Number.isInteger(code)?code:undefined}));
  });
 });
}
export async function currentRelease(root){
 const dir=await stateDirectory(root),pointer=await readJson(join(dir,'current.json'),null);
 return releaseFromPointer(root,pointer);
}
export async function releaseFromPointer(root,pointer){
 const dir=await stateDirectory(root);
 if(pointer===null)return {path:resolve(root),pointer:null};
 if(pointer.version!==1||!shaPattern.test(pointer.sha)||typeof pointer.directory!=='string'||!new RegExp('^'+pointer.sha+'-[a-f0-9-]{36}$').test(pointer.directory))throw Error('Invalid active release pointer.');
 const path=join(dir,'releases',pointer.directory),stat=await lstat(path);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Invalid active release directory.');
 return {path,pointer};
}
export async function saveRelease(root,pointer){const dir=await stateDirectory(root);await atomicJson(join(dir,'current.json'),pointer);}

/** Only public GitHub repository coordinates from local configuration reach git. */
export async function prepareRelease(root,source,run=runCommand,onStage=async()=>{}){
 const dir=await stateDirectory(root),stage=await mkdtemp(join(dir,'releases','staging-'));
 try{
  await onStage('fetch');
  await run('git',['clone','--depth','1','--single-branch','--branch',source.branch,'--','https://github.com/'+source.repository+'.git','.'],stage);
  const sha=await run('git',['rev-parse','HEAD'],stage);if(!shaPattern.test(sha))throw Error('Invalid upstream commit.');
  const active=await currentRelease(root);
  const reusable=await reusableArtifacts(active);
  if(active.pointer?.sha===sha&&reusable)return {unchanged:true,...active};
  await onStage('protocol');
  const protocol=await readJson(join(stage,'update-protocol.json'),null);
  if(protocol?.version!==1||protocol.stateChanges!=='explicit-only'||(protocol.host!==undefined&&protocol.host!==1))throw Error('Upstream does not support the update protocol; manual upgrade required.');
  let files=['package.json'],clean=false;
  if(reusable){
   try{
    clean=!(await run('git',['status','--porcelain','--untracked-files=no'],active.path));
    files=changedTreeFiles(await run('git',['ls-tree','-rz','--full-tree','HEAD'],active.path),await run('git',['ls-tree','-rz','--full-tree','HEAD'],stage));
   }catch{clean=false;}
  }
  const plan=updatePlan(files,{reusable:reusable&&clean});
  await onStage('dependencies',{plan});
  await copyArtifacts(active.path,stage,plan);
  if(plan.dependencies)await run('npm',['ci','--prefer-offline','--no-audit','--no-fund'],stage);
  if(plan.build){await onStage('build');await run('npm',['run','build'],stage);}
  if(plan.tests){
   await onStage('tests');
   // Versioned managers require syntax validation as well as application tests.
   if(protocol.host===1)await run(process.execPath,['scripts/check-host.mjs'],stage);
   await run('npm',['test'],stage);
  }
  const directory=sha+'-'+randomUUID(),path=join(dir,'releases',directory),pointer={version:1,sha,directory,source:source.name,repository:source.repository,branch:source.branch,runtime:runtimeIdentity(),preparedAt:new Date().toISOString()};
  await atomicJson(join(stage,'.release.json'),pointer);await rename(stage,path);
  return {path,pointer,plan,unchanged:false};
 }finally{await rm(stage,{recursive:true,force:true});}
}

/** Candidate readiness is observed before publishing its pointer. Never rewind user data. */
export async function switchRelease(previous,candidate,{validate,stop,start,save}){
 await validate(candidate);
 await stop();
 try{await start(candidate);await save(candidate.pointer);}
 catch(error){
  // stop must confirm process exit. If it fails, never launch a second writer.
  await stop();
  await start(previous);await save(previous.pointer);
  throw Object.assign(Error('New release failed to start; previous code restarted. User data was not restored or migrated.'),{rolledBack:true});
 }
}
