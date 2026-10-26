import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';
// The deployment cwd owns configuration; the candidate owns the reader implementation.
const release=resolve(process.argv[2]);
const load=path=>import(pathToFileURL(join(release,'dist',path)).href);
const {loadConfig}=await load('config/index.js');
const {mainPath,openDatabase,schemaVersion,integrity}=await load('state/database.js');
const config=loadConfig(),path=mainPath(config.dataDir);
if(!existsSync(path))throw Error('Existing initialized data directory required.');
const db=openDatabase(path,true);
try{
 const version=schemaVersion(db);if(version!==2)throw Error('Automatic updates require schema v2; migrate explicitly first.');
 const {validateSixSchema}=await load('state/schema.js');validateSixSchema(db);integrity(db);
}finally{db.close();}
