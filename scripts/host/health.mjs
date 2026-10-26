import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export async function releaseRevision(release){
 if(/^[a-f0-9]{40}$/.test(release?.pointer?.sha??''))return release.pointer.sha;
 try{
  const {stdout}=await promisify(execFile)('git',['rev-parse','--verify','HEAD'],{cwd:release.path,timeout:4000,maxBuffer:256,windowsHide:true});
  return /^[a-f0-9]{40}$/.test(stdout.trim())?stdout.trim():undefined;
 }catch{return undefined;}
}

export async function waitForHealth({host='127.0.0.1',port,pid,request=fetch,attempts=10,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 if(!Number.isSafeInteger(pid)||pid<=0||!Number.isInteger(port)||port<1||port>65535)return false;
 // Wildcard bind addresses are not request destinations. IPv6 needs URL brackets.
 const target=host==='0.0.0.0'?'127.0.0.1':host==='::'?'::1':host;
 const address=target.includes(':')?'['+target+']':target;
 for(let i=0;i<attempts;i++){
  try{
   const response=await request('http://'+address+':'+port+'/healthz',{signal:AbortSignal.timeout(2500),redirect:'error'});
   if(response.ok){const value=await response.json();
    if(value?.ok===true&&value.pid===pid&&value.core?.available===true)return true;
   }
  }catch{}
  if(i+1<attempts)await sleep(1000);
 }
 return false;
}
export async function checkGatewayHealth(root,child){
 try{
  const {loadConfig}=await import(pathToFileURL(join(root,'dist/config/index.js')).href);
  const {server}=loadConfig();
  return await waitForHealth({...server,pid:child?.pid});
 }catch{return false;}
}
