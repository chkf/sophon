import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {mkdtemp,rm,readFile,readdir,writeFile,mkdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ensureCloudflared,releaseAsset,executableBytes,prepareControlDependency} from '../host/cloudflared-install.mjs';
const bytes=Buffer.from('synthetic executable bytes');
const hash=data=>createHash('sha256').update(data).digest('hex');
function manifest(data=bytes,name='cloudflared-windows-amd64.exe',key='win32-x64'){
 return {version:'2026.1.0',assets:{[key]:{name,size:data.length,sha256:hash(data)}}};
}
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'component-install-'));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
const defaults={platform:'win32',arch:'x64',manifest:manifest(),probe:async binary=>binary!=='cloudflared'};
const unavailable=async()=>{throw Error('unexpected network request');};
test('existing explicit and PATH executables are reused without downloading',()=>fixture(async root=>{
 assert.equal(await ensureCloudflared(root,{binary:'C:/Tools/cloudflared.exe',probe:async()=>true,request:unavailable}),'C:/Tools/cloudflared.exe');
 assert.equal(await ensureCloudflared(root,{probe:async()=>true,request:unavailable}),'cloudflared');
 await assert.rejects(ensureCloudflared(root,{binary:'missing.exe',probe:async()=>false,request:unavailable}),{code:'configured_binary_unavailable'});
}));
test('fresh install verifies bytes, installs atomically and reuses cache without a second download',()=>fixture(async root=>{
 let requests=0;const options={...defaults,request:async url=>{requests++;assert.equal(url,'https://github.com/cloudflare/cloudflared/releases/download/2026.1.0/cloudflared-windows-amd64.exe');return new Response(bytes);}};
 const [a,b]=await Promise.all([ensureCloudflared(root,options),ensureCloudflared(root,options)]);
 assert.equal(a,b);assert.equal(requests,1);assert.deepEqual(await readFile(a),bytes);
 assert.equal(await ensureCloudflared(root,{...options,request:unavailable}),a);
 assert.deepEqual(await readdir(join(root,'.sophon-updates/bin')),['cloudflared-2026.1.0-win32-x64']);
 await writeFile(a,'modified bytes');await assert.rejects(ensureCloudflared(root,{...options,request:unavailable}),{code:'checksum_failed'});
}));
test('checksum mismatch and failed executable validation never publish or execute unchecked bytes',()=>fixture(async root=>{
 let managedProbes=0;const probe=async binary=>{if(binary!=='cloudflared')managedProbes++;return false;};
 await assert.rejects(ensureCloudflared(root,{...defaults,probe,request:async()=>new Response('unexpected bytes')}),{code:'checksum_failed'});
 assert.equal(managedProbes,0);
 await assert.rejects(ensureCloudflared(root,{...defaults,probe,request:async()=>new Response(bytes)}),{code:'binary_unavailable'});
 assert.equal(managedProbes,1);assert.deepEqual(await readdir(join(root,'.sophon-updates/bin')),[]);
 assert.deepEqual((await readdir(join(root,'.sophon-updates'))).filter(name=>name.endsWith('.lock')),[]);
}));
test('a network failure can be retried and unsupported platforms do not download',()=>fixture(async root=>{
 await assert.rejects(ensureCloudflared(root,{...defaults,request:async()=>{throw Error('synthetic network failure');}}),{code:'download_failed'});
 await assert.rejects(ensureCloudflared(root,{...defaults,platform:'unsupported',request:unavailable}),{code:'unsupported_platform'});
 assert.ok(await ensureCloudflared(root,{...defaults,request:async()=>new Response(bytes)}));
}));
function archive(name='cloudflared',type=48){
 const tar=Buffer.alloc(2048);tar.write(name,0);tar.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);tar[156]=type;bytes.copy(tar,512);return gzipSync(tar);
}
test('macOS archive handling selects a regular executable without extracting archive paths',()=>{
 const packed=archive(),asset=manifest(packed,'cloudflared-darwin-arm64.tgz','darwin-arm64').assets['darwin-arm64'];
 assert.deepEqual(executableBytes(packed,asset),bytes);
 for(const packed of [archive('../cloudflared'),archive('cloudflared',50)]){
  const asset={name:'cloudflared-darwin-arm64.tgz',size:packed.length,sha256:hash(packed)};
  assert.throws(()=>executableBytes(packed,asset),{code:'invalid_archive'});
 }
 for(const [platform,arch] of [['win32','x64'],['linux','arm64'],['darwin','x64'],['darwin','arm64']]){
  assert.match(releaseAsset(platform,arch).url,/^https:\/\/github.com\/cloudflare\/cloudflared\/releases\/download\//);
  assert.match(releaseAsset(platform,arch).sha256,/^[a-f0-9]{64}$/);
 }
});
test('disabled control tunnel skips optional dependency preparation entirely',()=>fixture(async root=>{
 await mkdir(join(root,'dist/config'),{recursive:true});await writeFile(join(root,'package.json'),'{"type":"module"}');
 await writeFile(join(root,'dist/config/index.js'),'export const loadConfig=()=>({});');
 assert.equal(await prepareControlDependency(root,{probe:async()=>assert.fail('disabled tunnel must not probe'),request:unavailable}),undefined);
}));
test('enabled update preparation installs a missing optional component',()=>fixture(async root=>{
 await mkdir(join(root,'dist/config'),{recursive:true});await writeFile(join(root,'package.json'),'{"type":"module"}');
 await writeFile(join(root,'dist/config/index.js'),"export const loadConfig=()=>({control:{tunnel:'cloudflare'}});");
 assert.ok(await prepareControlDependency(root,{...defaults,binary:undefined,request:async()=>new Response(bytes)}));
}));
test('linked cache directories cannot redirect component installation',t=>fixture(async root=>{
 const {stateDirectory}=await import('../host/releases.mjs');await stateDirectory(root);const outside=join(root,'outside');await mkdir(outside);
 try{await symlink(outside,join(root,'.sophon-updates/bin'),'junction');}catch(error){if(process.platform==='win32'&&error.code==='EPERM'){t.skip('Symbolic-link privilege unavailable');return;}throw error;}
 await assert.rejects(ensureCloudflared(root,{...defaults,request:unavailable}),{code:'unsafe_cache'});
 assert.deepEqual(await readdir(outside),[]);
}));
