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
export function resolveAgentEvent(prior:{agentDeviceId:string;eventType:string}|null,agentDeviceId:string,eventType:string):'NEW'|'REPLAY'|'CONFLICT'{if(!prior)return 'NEW';return prior.agentDeviceId===agentDeviceId&&prior.eventType===eventType?'REPLAY':'CONFLICT';}

export interface ClaimRepository<T>{candidate():Promise<T|undefined>;claimIfQueued(candidate:T):Promise<T|undefined>}
export async function atomicClaimNext<T>(repo:ClaimRepository<T>,maxTries=3):Promise<T|undefined>{for(let i=0;i<maxTries;i++){const candidate=await repo.candidate();if(!candidate)return undefined;const claimed=await repo.claimIfQueued(candidate);if(claimed)return claimed;}return undefined;}
