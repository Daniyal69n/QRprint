import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
export type AgentJobState='QUEUED'|'LEASED'|'DOWNLOADED'|'SUBMITTING'|'SPOOLER_ACCEPTED'|'SIMULATED_COMPLETE'|'FAILED'|'OUTCOME_UNKNOWN'|'CANCELLED';
const next:Record<AgentJobState,AgentJobState[]>={QUEUED:['LEASED','CANCELLED'],LEASED:['DOWNLOADED','FAILED','QUEUED'],DOWNLOADED:['SUBMITTING','FAILED','QUEUED'],SUBMITTING:['SPOOLER_ACCEPTED','SIMULATED_COMPLETE','FAILED','OUTCOME_UNKNOWN'],SPOOLER_ACCEPTED:[],SIMULATED_COMPLETE:[],FAILED:['QUEUED','CANCELLED'],OUTCOME_UNKNOWN:['SPOOLER_ACCEPTED','FAILED'],CANCELLED:[]};
export const canTransitionJob=(from:AgentJobState,to:AgentJobState)=>next[from].includes(to);
export function expiredLeaseAction(state:AgentJobState):'REQUEUE'|'UNKNOWN'|'IGNORE'{if(state==='LEASED'||state==='DOWNLOADED')return 'REQUEUE';if(state==='SUBMITTING')return 'UNKNOWN';return 'IGNORE';}
export const mintAgentSecret=()=>`qpa_${randomBytes(32).toString('base64url')}`;
export const isAgentCredential=(secret:string)=>/^qpa_[A-Za-z0-9_-]{40,60}$/.test(secret);
export const hashSecret=(secret:string)=>createHash('sha256').update(secret).digest('hex');
export function equalSecret(a:string,b:string){const aa=Buffer.from(hashSecret(a),'hex'),bb=Buffer.from(hashSecret(b),'hex');return aa.length===bb.length&&timingSafeEqual(aa,bb);}
export function verifySecret(secret:string,storedHash:string){const aa=Buffer.from(hashSecret(secret),'hex'),bb=Buffer.from(storedHash,'hex');return aa.length===bb.length&&timingSafeEqual(aa,bb);}
export const canAgentUseShop=(agentShopId:string,resourceShopId:string)=>agentShopId===resourceShopId;
export const canQueuePayment=(status:string|undefined|null)=>status==='VERIFIED'||status==='CASH_AUTHORIZED'||status==='CUSTOMER_ATTESTED';
export type ClaimSkipReason='PRINTER_MISMATCH'|'MODE_MISMATCH'|'ATTEMPT_LIMIT'|'RETRY_SCHEDULED'|'PAYMENT_NOT_ELIGIBLE';
export function claimSkipReason(job:{printerId:string|null;mode:string;attempt:number;maxAttempts:number;nextAttemptAt:Date|null},agent:{printerId:string;mode:string},now:Date,configuredMaxAttempts:number,canReassignPrinter=false):Exclude<ClaimSkipReason,'PAYMENT_NOT_ELIGIBLE'>|null{
  if(job.printerId!==null&&job.printerId!==agent.printerId&&!canReassignPrinter)return 'PRINTER_MISMATCH';
  if(job.mode!==agent.mode)return 'MODE_MISMATCH';
  if(job.attempt>=Math.min(job.maxAttempts,configuredMaxAttempts))return 'ATTEMPT_LIMIT';
  if(job.nextAttemptAt&&job.nextAttemptAt>now)return 'RETRY_SCHEDULED';
  return null;
}
export const QUEUED_JOB_STALE_MS=20_000;
export function canAdoptQueuedJob(job:{printerId:string|null;createdAt:Date;printerShopId:string|undefined},agent:{printerId:string;shopId:string},connectedPrinterIds:ReadonlySet<string>,now:Date,staleMs=QUEUED_JOB_STALE_MS):boolean{
  if(job.printerId===null||job.printerId===agent.printerId)return true;
  if(job.printerShopId!==undefined&&job.printerShopId!==agent.shopId)return false;
  if(!connectedPrinterIds.has(job.printerId))return true;
  return now.getTime()-job.createdAt.getTime()>=staleMs;
}
export function claimCasWhere(job:{id:string;mode:'SIMULATED'|'REAL'|string}){
  // Prisma MongoDB updateMany cannot apply relation filters or null-OR predicates, so the
  // compare-and-set only uses scalar fields. Eligibility is already checked on the candidate.
  return {id:job.id,mode:job.mode as 'SIMULATED'|'REAL',status:'QUEUED' as const};
}
export function resolveAgentEvent(prior:{agentDeviceId:string;eventType:string}|null,agentDeviceId:string,eventType:string):'NEW'|'REPLAY'|'CONFLICT'{if(!prior)return 'NEW';return prior.agentDeviceId===agentDeviceId&&prior.eventType===eventType?'REPLAY':'CONFLICT';}

export interface ClaimRepository<T>{candidate():Promise<T|undefined>;claimIfQueued(candidate:T):Promise<T|undefined>}
export async function atomicClaimNext<T>(repo:ClaimRepository<T>):Promise<T|undefined>{while(true){const candidate=await repo.candidate();if(!candidate)return undefined;const claimed=await repo.claimIfQueued(candidate);if(claimed)return claimed;}}
