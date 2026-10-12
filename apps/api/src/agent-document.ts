export function fittedBlobKey(jobId:string){return `agent-jobs/${jobId}.pdf`;}
export function describeDocumentDelivery(usesBlob:boolean){return usesBlob?{contentType:'application/json',storage:'private-blob-fitted' as const}:{contentType:'application/pdf',storage:'inline-fitted' as const};}
export function redactDocumentUrl(url:string){
  try{
    const parsed=new URL(url);
    return `${parsed.protocol}//${parsed.host}/[redacted]`;
  }catch{
    return 'invalid-url';
  }
}
export function documentDownloadRequiresLease(headers:{'x-job-lease'?:string;authorization?:string}){
  return {hasAuthorization:!!headers.authorization,hasJobLease:!!headers['x-job-lease']};
}
