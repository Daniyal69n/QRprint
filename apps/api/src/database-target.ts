export function databaseNameFromUrl(value:string|undefined):string {
  if(!value)throw new Error('MONGODB_URI is required. Configure the isolated QR Print MongoDB URL.');
  let parsed:URL;
  try{parsed=new URL(value);}catch{throw new Error('Database URL is malformed; target could not be verified.');}
  if(!['mongodb:','mongodb+srv:'].includes(parsed.protocol))throw new Error('Database URL must use MongoDB.');
  const name=parsed.searchParams.get('dbName')||decodeURIComponent(parsed.pathname.replace(/^\//,''));
  if(!name)throw new Error('Database name is missing from the MongoDB URL. Set a database path or dbName query parameter.');
  return name;
}

export function assertDatabaseTarget(value:string|undefined,expected:string):string {
  const actual=databaseNameFromUrl(value);
  if(actual!==expected)throw new Error(`Refusing database operation: expected database ${expected}, configured target is ${actual}.`);
  return actual;
}
