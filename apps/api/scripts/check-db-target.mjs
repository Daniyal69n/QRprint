import { config } from 'dotenv';
import path from 'node:path';

const workspace=process.cwd();
const root=path.resolve(workspace,'../..');
config({path:path.join(root,'.env')});
config({path:path.join(workspace,'.env')});
function inspect(name,expected){
  const value=process.env[name];
  if(!value)throw new Error(`${name} is not configured; target cannot be verified.`);
  let url;
  try{url=new URL(value);}catch{throw new Error(`${name} is malformed; target cannot be verified.`);}
  if(!['postgres:','postgresql:'].includes(url.protocol))throw new Error(`${name} is not a PostgreSQL URL.`);
  const database=decodeURIComponent(url.pathname.replace(/^\//,''));
  if(database!==expected)throw new Error(`Refusing: ${name} must target ${expected}; configured database is ${database}.`);
  console.log(`${name}: verified database=${database}; host=${url.hostname}; port=${url.port||'5432'}`);
}
inspect('DATABASE_URL','qr_print');
inspect('TEST_DATABASE_URL','qr_print_test');
