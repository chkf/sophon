import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store.ts";
import { migrateState } from "../../src/state/migration.ts";
import { migrateSchemaDatabase } from "../../src/state/schema.ts";
import { mainPath, openDatabase } from "../../src/state/database.ts";
export const fixturePresets = {default:["CLEAR","HELPFUL"],formal:["PRECISE"],casual:["FRIENDLY"]};
export async function writeLegacyPersonaFixture(root,active="default",presets=fixturePresets) {
  await mkdir(join(root,"runtime"),{recursive:true});
  await writeFile(join(root,"runtime/persona.json"),JSON.stringify({version:2,active,presets}));
}
export async function seedPersonaDatabase(root,active="default",presets=fixturePresets) {
  await mkdir(join(root,"core"),{recursive:true});
  if(!existsSync(join(root,"core/core.md"))) await writeFile(join(root,"core/core.md"),"# Synthetic fixture Core\nDatabase-only Persona tests.");
  new SessionStore(root).close();
  await writeLegacyPersonaFixture(root,active,presets);
  await migrateState(root,true);
  const db=openDatabase(mainPath(root));try{migrateSchemaDatabase(db,root);}finally{db.close();}
}
