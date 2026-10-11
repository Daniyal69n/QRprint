export function databaseNameFromUrl(value:string|undefined):string {
  if(!value)throw new Error('DATABASE_URL is required. Configure the isolated QR Print database URL.');
  let parsed:URL;
  try{parsed=new URL(value);}catch{throw new Error('Database URL is malformed; target could not be verified.');}
  if(!['postgres:','postgresql:'].includes(parsed.protocol))throw new Error('Database URL must use PostgreSQL.');
  const name=decodeURIComponent(parsed.pathname.replace(/^\//,''));
  if(!name)throw new Error('Database name is missing from DATABASE_URL.');
  return name;
}

export function assertDatabaseTarget(value:string|undefined,expected:string):string {
  const actual=databaseNameFromUrl(value);
  if(actual!==expected)throw new Error(`Refusing database operation: expected database ${expected}, configured target is ${actual}.`);
  return actual;
}
