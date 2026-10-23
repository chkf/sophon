import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SessionStore } from "./store.js";
import { cleanTestEnvironment } from "../../scripts/testing/environment.mjs";
test("session CLI checks SQLite and exports complete rollback history",async()=>{
  const root=await mkdtemp(join(tmpdir(),"sqlite-cli-"));
  try {
    const digest=createHash("sha256").update("telegram:fixture").digest("hex");
    const store=new SessionStore(root);
    await store.append("telegram","fixture","owner",[{id:"first",role:"user",at:"2026-10-11T00:00:00Z",content:"hello"}]);
    store.close();
    const run=async(...args:string[])=>JSON.parse((await promisify(execFile)(process.execPath,
      ["--import",import.meta.resolve("tsx"),fileURLToPath(new URL("../../scripts/session-storage.mjs",import.meta.url)),...args],
      {cwd:root,env:cleanTestEnvironment()})).stdout);
    assert.deepEqual(await run("status",root),{sqlite:true});
    assert.deepEqual(await run("check",root,"telegram","fixture"),{count:1,segments:0});
    const output=join(root,"exported");
    assert.deepEqual(await run("export-all",root,output),{conversations:1,messages:1});
    assert.equal(JSON.parse(await readFile(join(output,digest+".json"),"utf8")).messages[0].id,"first");
  }finally{await rm(root,{recursive:true,force:true});}
});
