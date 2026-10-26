import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {readFile,writeFile,mkdir,lstat,mkdtemp,rename,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stateDirectory,acquireLock,buildEnvironment} from './releases.mjs';

const release=JSON.parse(await readFile(new URL('./cloudflared-release.json',import.meta.url),'utf8'));
const pending=new Map();
const MAX_BYTES=96*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function failure(code){return Object.assign(Error('cloudflared component: '+code),{code});}
export async function executableAvailable(binary){
 try{
  const {stdout}=await promisify(execFile)(binary,['--version'],{timeout:5000,maxBuffer:4096,windowsHide:true,env:buildEnvironment()});
  return /^cloudflared version /m.test(stdout);
 }catch{return false;}
}
export function releaseAsset(platform,arch,manifest=release){
 const asset=manifest.assets[platform+'-'+arch];
 if(!asset)throw failure('unsupported_platform');
 return {...asset,version:manifest.version,url:'https://github.com/cloudflare/cloudflared/releases/download/'+manifest.version+'/'+asset.name};
}
/** Read a single regular executable from a verified archive; never extract paths or links. */
export function executableBytes(bytes,asset){
 if(bytes.length!==asset.size||hash(bytes)!==asset.sha256)throw failure('checksum_failed');
 if(!asset.name.endsWith('.tgz'))return bytes;
 const tar=gunzipSync(bytes,{maxOutputLength:MAX_BYTES});let executable;
 for(let offset=0;offset+512<=tar.length;){
  const header=tar.subarray(offset,offset+512);if(header.every(value=>value===0))break;
  const name=header.subarray(0,100).toString().split('\0')[0],prefix=header.subarray(345,500).toString().split('\0')[0];
  const sizeText=header.subarray(124,136).toString().replace(/\0/g,'').trim();
  if(!/^[0-7]+$/.test(sizeText))throw failure('invalid_archive');
  const size=parseInt(sizeText,8),start=offset+512;
  if(!Number.isSafeInteger(size)||start+size>tar.length)throw failure('invalid_archive');
  if(!prefix&&['cloudflared','./cloudflared'].includes(name)){
   if(executable||![0,48].includes(header[156]))throw failure('invalid_archive');
   executable=tar.subarray(start,start+size);
  }
  offset=start+Math.ceil(size/512)*512;
 }
 if(!executable?.length)throw failure('invalid_archive');return executable;
}
async function plainDirectory(path){
 await mkdir(path,{recursive:true,mode:0o700});const info=await lstat(path);
 if(!info.isDirectory()||info.isSymbolicLink())throw failure('unsafe_cache');
}
async function boundedRead(path){
 const info=await lstat(path);
 if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_BYTES)throw failure('unsafe_cache');
 return readFile(path);
}
async function download(asset,request,signal){
 try{
  const response=await request(asset.url,{signal:AbortSignal.any([AbortSignal.timeout(120_000),...(signal?[signal]:[])]),redirect:'follow'});
  if(!response.ok||!response.body)throw failure('download_failed');
  if(response.url&&!response.url.startsWith('https://'))throw failure('download_failed');
  const chunks=[];let size=0;
  for await(const part of response.body){size+=part.length;if(size>asset.size||size>MAX_BYTES)throw failure('checksum_failed');chunks.push(Buffer.from(part));}
  return Buffer.concat(chunks);
 }catch(error){if(error.code==='checksum_failed')throw error;throw failure('download_failed');}
}

/** Explicit binary, then PATH, then a verified per-deployment copy. No system installation. */
export function ensureCloudflared(root,options={}){
 const key=resolve(root)+'\0'+(options.binary??'');
 if(pending.has(key))return pending.get(key);
 const task=install(root,options).finally(()=>pending.delete(key));pending.set(key,task);return task;
}
async function install(root,{binary,platform=process.platform,arch=process.arch,probe=executableAvailable,request=fetch,manifest=release,signal}={}){
 if(binary){if(await probe(binary))return binary;throw failure('configured_binary_unavailable');}
 if(await probe('cloudflared'))return 'cloudflared';
 const asset=releaseAsset(platform,arch,manifest),state=await stateDirectory(root),base=join(state,'bin');
 await plainDirectory(base);
 const directory=join(base,'cloudflared-'+asset.version+'-'+platform+'-'+arch),name=platform==='win32'?'cloudflared.exe':'cloudflared';
 const readCached=async()=>{
  let info;
  try{info=await lstat(directory);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  try{
   if(!info.isDirectory()||info.isSymbolicLink())throw failure('unsafe_cache');
   const executable=await boundedRead(join(directory,name));
   const expected=executableBytes(asset.name.endsWith('.tgz')?await boundedRead(join(directory,'artifact.tgz')):executable,asset);
   if(hash(executable)!==hash(expected))throw failure('checksum_failed');
   if(!await probe(join(directory,name)))throw failure('binary_unavailable');
   return join(directory,name);
  }catch(error){if(error.code==='ENOENT')throw failure('unsafe_cache');throw error;}
 };
 const cached=await readCached();if(cached)return cached;
 const unlock=await acquireLock(root,'cloudflared');let stage;
 try{
  const existing=await readCached();if(existing)return existing;
  if(signal?.aborted)throw failure('download_failed');
  const bytes=await download(asset,request,signal),executable=executableBytes(bytes,asset);
  stage=await mkdtemp(join(base,'cloudflared-staging-'));
  await writeFile(join(stage,name),executable,{flag:'wx',mode:0o700});
  if(asset.name.endsWith('.tgz'))await writeFile(join(stage,'artifact.tgz'),bytes,{flag:'wx',mode:0o600});
  if(!await probe(join(stage,name)))throw failure('binary_unavailable');
  if(signal?.aborted)throw failure('download_failed');
  await rename(stage,directory);stage=undefined;return join(directory,name);
 }finally{if(stage)await rm(stage,{recursive:true,force:true});await unlock();}
}

export async function prepareControlDependency(root,{codeRoot=root,...options}={}){
 const {loadConfig}=await import(pathToFileURL(join(codeRoot,'dist/config/index.js')).href);
 if(loadConfig().control?.tunnel!=='cloudflare')return;
 try{return await ensureCloudflared(root,{binary:process.env.GATEWAY_CLOUDFLARED_BIN?.trim()||undefined,...options});}
 catch(error){console.error('[host] optional cloudflared preparation failed ('+safeComponentCode(error)+'); Gateway update may continue.');}
}
export function safeComponentCode(error){
 return ['download_failed','checksum_failed','unsupported_platform','configured_binary_unavailable','binary_unavailable','invalid_archive','unsafe_cache'].includes(error?.code)?error.code:'component_unavailable';
}
