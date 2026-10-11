import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';

export function privateStorageRoot(configured=process.env.QRPRINT_STORAGE_DIR,cwd=process.cwd()):string {
  return path.resolve(configured||path.join(cwd,'storage'));
}

export function privateStoragePath(storageKey:string,root=privateStorageRoot()):string {
  if(!/^[A-Za-z0-9_-]+\.pdf$/.test(storageKey)) throw new Error('Invalid private document storage key.');
  const base=path.resolve(root),file=path.resolve(base,storageKey);
  if(!file.startsWith(`${base}${path.sep}`)) throw new Error('Document storage path is outside the private storage directory.');
  return file;
}

export async function writePrivatePdf(storageKey:string,bytes:Buffer):Promise<void> {
  const root=privateStorageRoot(),file=privateStoragePath(storageKey,root);
  await mkdir(root,{recursive:true,mode:0o700});
  await writeFile(file,bytes,{flag:'wx',mode:0o600});
}

export async function readPrivatePdf(storageKey:string):Promise<Buffer> {
  return readFile(privateStoragePath(storageKey));
}

export async function removePrivatePdf(storageKey:string):Promise<void> {
  await rm(privateStoragePath(storageKey),{force:true});
}
