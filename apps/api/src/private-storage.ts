import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {del,get,issueSignedToken,list,presignUrl,put} from '@vercel/blob';

export const MAX_DOCUMENT_BYTES=25*1024*1024;
export const MAX_FUNCTION_PDF_RESPONSE_BYTES=4*1024*1024;
const keyPattern=/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(pdf|docx)$/;

export function usesPrivateBlob(env:NodeJS.ProcessEnv=process.env):boolean{return env.QRPRINT_STORAGE_PROVIDER==='vercel-blob';}
export async function checkPrivateBlob():Promise<void>{await list({limit:1});}
export function privateStorageRoot(configured=process.env.QRPRINT_STORAGE_DIR,cwd=process.cwd()):string {
  return path.resolve(configured||path.join(cwd,'storage'));
}

export function privateStoragePath(storageKey:string,root=privateStorageRoot()):string {
  if(!keyPattern.test(storageKey)) throw new Error('Invalid private document storage key.');
  const base=path.resolve(root),file=path.resolve(base,...storageKey.split('/'));
  if(!file.startsWith(`${base}${path.sep}`)) throw new Error('Document storage path is outside the private storage directory.');
  return file;
}

export function documentMimeType(storageKey:string):string{return storageKey.endsWith('.docx')?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/pdf';}
export async function writePrivatePdf(storageKey:string,bytes:Buffer,options:{overwrite?:boolean}={}):Promise<void> {
  if(!keyPattern.test(storageKey))throw new Error('Invalid private document storage key.');
  if(usesPrivateBlob()){
    await put(storageKey,bytes,{access:'private',contentType:documentMimeType(storageKey),allowOverwrite:options.overwrite??false,addRandomSuffix:false,cacheControlMaxAge:60});
    return;
  }
  const file=privateStoragePath(storageKey),root=path.dirname(file);
  await mkdir(root,{recursive:true,mode:0o700});
  await writeFile(file,bytes,{flag:options.overwrite?'w':'wx',mode:0o600});
}

export async function readPrivatePdf(storageKey:string):Promise<Buffer> {
  if(!keyPattern.test(storageKey))throw new Error('Invalid private document storage key.');
  if(usesPrivateBlob()){
    const blob=await get(storageKey,{access:'private',useCache:false});
    if(!blob||blob.statusCode!==200)throw new Error('Private PDF was not found.');
    return Buffer.from(await new Response(blob.stream).arrayBuffer());
  }
  return readFile(privateStoragePath(storageKey));
}

export async function removePrivatePdf(storageKey:string):Promise<void> {
  if(!keyPattern.test(storageKey))throw new Error('Invalid private document storage key.');
  if(usesPrivateBlob()){await del(storageKey);return;}
  await rm(privateStoragePath(storageKey),{force:true});
}

export async function createPrivateUploadUrl(storageKey:string,validForMs=10*60*1000):Promise<{url:string;validUntil:number}> {
  if(!usesPrivateBlob())throw new Error('Direct uploads are available only when private Blob storage is configured.');
  if(!keyPattern.test(storageKey))throw new Error('Invalid private document storage key.');
  const contentType=documentMimeType(storageKey);
  const validUntil=Date.now()+Math.max(60_000,Math.min(validForMs,60*60*1000));
  const token=await issueSignedToken({pathname:storageKey,operations:['put'],allowedContentTypes:[contentType],maximumSizeInBytes:MAX_DOCUMENT_BYTES,validUntil});
  const {presignedUrl}=await presignUrl(token,{access:'private',pathname:storageKey,operation:'put',validUntil,allowedContentTypes:[contentType],maximumSizeInBytes:MAX_DOCUMENT_BYTES,addRandomSuffix:false});
  return {url:presignedUrl,validUntil};
}

export async function createPrivateDownloadUrl(storageKey:string,validForMs=5*60*1000):Promise<string> {
  if(!usesPrivateBlob())throw new Error('Signed downloads are available only when private Blob storage is configured.');
  if(!keyPattern.test(storageKey))throw new Error('Invalid private document storage key.');
  const validUntil=Date.now()+Math.max(30_000,Math.min(validForMs,60*60*1000));
  const token=await issueSignedToken({pathname:storageKey,operations:['get'],validUntil});
  return (await presignUrl(token,{access:'private',pathname:storageKey,operation:'get',validUntil})).presignedUrl;
}

export function privateDocumentKey(ownerId:string,id:string,ext:'pdf'|'docx'='pdf'):string {
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(ownerId)||!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw new Error('Invalid private document identity.');
  return `documents/${ownerId}/${id}.${ext}`;
}
export function isDocxKey(storageKey:string):boolean{return storageKey.endsWith('.docx');}
