import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from 'dotenv';

const workspace=process.cwd();
const root=path.resolve(workspace,'../..');
config({path:path.join(root,'.env')});
config({path:path.join(workspace,'.env')});
async function findIntegrationTests(dir){
  const found=[];
  for(const item of await readdir(dir,{withFileTypes:true})){
    const full=path.join(dir,item.name);
    if(item.isDirectory())found.push(...await findIntegrationTests(full));
    else if(item.isFile()&&item.name.endsWith('.integration.test.ts'))found.push(full);
  }
  return found;
}
const files=await findIntegrationTests(path.join(workspace,'src'));
if(files.length===0){console.log('No database integration tests are registered; nothing was run.');process.exit(0);}
const value=process.env.TEST_MONGODB_URI;
if(!value)throw new Error('Refusing integration tests: TEST_MONGODB_URI is not configured.');
let url;
try{url=new URL(value);}catch{throw new Error('Refusing integration tests: TEST_MONGODB_URI target could not be verified.');}
const database=url.searchParams.get('dbName')||decodeURIComponent(url.pathname.replace(/^\//,''));
if(!['mongodb:','mongodb+srv:'].includes(url.protocol)||database!=='qr_print_test')throw new Error(`Refusing integration tests: expected MongoDB database qr_print_test, configured database is ${database||'unknown'}.`);
const cli=path.join(root,'node_modules','tsx','dist','cli.mjs');
const result=spawnSync(process.execPath,[cli,'--test',...files],{cwd:workspace,env:{...process.env,MONGODB_URI:value,NODE_ENV:'test',PAYMENT_MODE:'mock',PRINT_EXECUTION_MODE:'simulated'},stdio:'inherit'});
process.exit(result.status??1);
