import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { SessionStore } from "../src/sessions/store.ts";
const [action,dataDir,arg1,arg2]=process.argv.slice(2);
if(!dataDir||!["status","check","export-all"].includes(action)) {
  throw new Error("Usage: npm run sessions -- <status|check|export-all> <dataDir> [channel] [conversationId]");
}
const root=resolve(dataDir),store=new SessionStore(root);
try {
  let result;
  if(action==="status") {
    const names=await readdir(join(root,"sessions"));
    result={sqlite:names.includes("gateway.sqlite")};
  }else if(action==="export-all") {
    if(!arg1)throw new Error("Provide a new empty output directory outside sessions.");
    result=await store.exportAll(resolve(arg1));
  }else{
    if(!["telegram","wechat"].includes(arg1)||!arg2)throw new Error("Check requires channel and conversationId.");
    result=await store.check(arg1,arg2);
  }
  console.log(JSON.stringify(result));
}finally{store.close();}
