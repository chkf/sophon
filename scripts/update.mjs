import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {currentRelease,readJson} from './host/releases.mjs';
const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
try{
 const release=await currentRelease(root),protocol=await readJson(join(release.path,'update-protocol.json'),null);
 if(protocol?.host!==undefined&&protocol.host!==1)throw Error('Unsupported manager protocol.');
 const code=protocol?.host===1?release.path:root;
 const {runUpdateCLI}=await import(pathToFileURL(join(code,'scripts/host/update-cli.mjs')).href);
 await runUpdateCLI(root);
}catch{console.error('更新命令未完成，请检查上游配置、残留锁和本机更新日志。');process.exitCode=1;}
