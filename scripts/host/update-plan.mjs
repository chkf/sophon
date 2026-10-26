import {cp,lstat} from 'node:fs/promises';
import {join} from 'node:path';

export const runtimeIdentity=()=>({abi:process.versions.modules,platform:process.platform,arch:process.arch});
export function updatePlan(files,{reusable=false}={}){
 const docs=files.every(path=>/^(docs\/|README(?:\.|$)|LICENSE$|THIRD_PARTY_NOTICES\.md$)/.test(path));
 const dependencies=!reusable||files.some(path=>['package.json','package-lock.json','.npmrc'].includes(path));
 const build=dependencies||files.includes('scripts/build.mjs')||!docs&&files.some(path=>!path.startsWith('scripts/')&&!path.startsWith('docs/'));
 return {dependencies,build,tests:!reusable||!docs,restart:!reusable||!docs};
}
export async function reusableArtifacts(release){
 const runtime=release.pointer?.runtime;
 if(!runtime||JSON.stringify(runtime)!==JSON.stringify(runtimeIdentity()))return false;
 for(const file of ['node_modules/.package-lock.json','dist/main.js','dist/config/index.js']){
  try{const info=await lstat(join(release.path,file));if(!info.isFile()||info.isSymbolicLink())return false;}catch{return false;}
 }
 return true;
}
export async function copyArtifacts(previous,candidate,plan){
 // Each release owns its files. Never share writable dependencies or build output.
 for(const name of [...(!plan.dependencies?['node_modules']:[]),...(!plan.build?['dist']:[])]){
  await cp(join(previous,name),join(candidate,name),{recursive:true,verbatimSymlinks:true,errorOnExist:true,force:false});
 }
}
export function changedTreeFiles(before,after){
 const entries=value=>new Map(value.split('\0').filter(Boolean).map(line=>{
  const index=line.indexOf('\t');if(index<0)throw Error('Invalid Git tree.');
  return [line.slice(index+1),line.slice(0,index)];
 }));
 const a=entries(before),b=entries(after);
 return [...new Set([...a.keys(),...b.keys()])].filter(path=>a.get(path)!==b.get(path));
}
