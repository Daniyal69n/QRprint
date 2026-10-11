export type RetentionJob = {mode:string;status:string;physicalStatus:string;attempt:number;maxAttempts:number}|null;
export type RetentionOrder = {status:string;printJob:RetentionJob};
export type RetentionDocument = {orders:RetentionOrder[]};

/** Unknown and retryable output is retained. Failed jobs age out only after all attempts are spent. */
export function canRetainDocumentDelete(document:RetentionDocument):boolean {
  return document.orders.every(order=>{
    if(order.status==='CANCELLED') return true;
    const job=order.printJob;
    if(!job) return false;
    if(job.mode==='SIMULATED'&&job.status==='SIMULATED_COMPLETE') return true;
    if(job.status==='SPOOLER_ACCEPTED'&&job.physicalStatus==='OUTPUT_CONFIRMED') return true;
    if(job.status==='CANCELLED') return true;
    return job.status==='FAILED'&&job.attempt>=job.maxAttempts;
  });
}
