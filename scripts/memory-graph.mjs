import { inspectMemory, migrateMemory, manageMemory, inspectBootstrap } from '../src/memory/migration.ts';
const args=process.argv.slice(2),[action,root,...flags]=args;
const usage='用法：npm run memory -- inspect <data-dir>；migrate <data-dir> --stopped；bootstrap <data-dir> --owner <id> --stopped；status <data-dir> --owner <id>；recent-migrate <data-dir> --owner <id> --stopped；undo <data-dir> --owner <id> --operation <id> --stopped';
if(!['inspect','migrate','bootstrap','status','recent-migrate','undo'].includes(action)||!root)throw Error(usage);
let owner,operation,stopped=false;
for(let i=0;i<flags.length;i++){
 const flag=flags[i];
 if(flag==='--stopped'&&!stopped)stopped=true;
 else if(flag==='--owner'&&!owner&&/^\d+$/.test(flags[i+1]??''))owner=flags[++i];
 else if(flag==='--operation'&&!operation&&flags[i+1])operation=flags[++i];
 else throw Error(usage);
}
if(['inspect','migrate'].includes(action)&&(owner||operation))throw Error(usage);
if(['bootstrap','status','recent-migrate','undo'].includes(action)&&(!owner||(action==='undo'&&!operation)))throw Error(usage);
if(action!=='undo'&&operation)throw Error(usage);
const result=action==='status'?await inspectBootstrap(root,'telegram:'+owner):action==='inspect'?await inspectMemory(root):action==='migrate'?await migrateMemory(root,stopped):await manageMemory(root,'telegram:'+owner,action,stopped,operation);
console.log(JSON.stringify(result,null,2));

