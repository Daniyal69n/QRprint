import {Router,type Request,type Response} from 'express';
import type {PrismaClient,PrintJobStatus,PhysicalPrintStatus,Prisma} from '@prisma/client';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {authenticateAgent,type AgentRequest} from './agent-auth.js';
import {hashSecret,canTransitionJob,canQueuePayment,canAdoptQueuedJob,claimCasWhere,claimSkipReason,expiredLeaseAction,verifySecret,atomicClaimNext,resolveAgentEvent,type AgentJobState} from './agent-core.js';
import {fitPdf} from './pdf-fit.js';
import {readPrivatePdf,writePrivatePdf,usesPrivateBlob,createPrivateDownloadUrl} from './private-storage.js';
import {describeDocumentDelivery,fittedBlobKey} from './agent-document.js';

const leaseSeconds=Math.max(15,Math.min(300,Number(process.env.AGENT_LEASE_SECONDS)||60));
const maxAttempts=Math.max(1,Math.min(10,Number(process.env.PRINT_MAX_ATTEMPTS)||3));
function routeParam(req:Request,key:string):string{return z.string().parse(req.params[key]);}
const log=(level:'info'|'warn'|'error',event:string,fields:Record<string,unknown>={})=>console.log(JSON.stringify({time:new Date().toISOString(),level,event,...fields}));
function fail(res:Response,status:number,code:string,message:string){return res.status(status).json({error:{code,message}});}
async function reapExpired(db:PrismaClient){
  const now=new Date();
  const safeToRequeue=(['LEASED','DOWNLOADED'] as AgentJobState[]).filter(s=>expiredLeaseAction(s)==='REQUEUE');
  const expired=await db.printJob.findMany({where:{status:{in:safeToRequeue},leaseExpiresAt:{lte:now}},select:{id:true,attempt:true}});
  let requeued=0;
  if(expired.length){
    const recovered=await db.$transaction(expired.map(job=>db.printJob.updateMany({
      where:{id:job.id,status:{in:safeToRequeue}},
      data:{status:'QUEUED',claimedById:null,leaseTokenHash:null,leaseExpiresAt:null,attempt:Math.max(0,job.attempt-1),error:'LEASE_EXPIRED_SAFE_TO_RETRY'},
    })));
    requeued=recovered.reduce((sum,result)=>sum+result.count,0);
  }
  const recoveredAttempts=await db.printJob.updateMany({where:{status:'QUEUED',physicalStatus:'NOT_SUBMITTED',attempt:{gte:maxAttempts}},data:{attempt:0,nextAttemptAt:null,error:'ATTEMPTS_RESET_FOR_UNSUBMITTED_JOB'}});
  const uncertain=await db.printJob.findMany({where:{status:'SUBMITTING',leaseExpiresAt:{lte:now}},select:{id:true,orderId:true}});
  if(uncertain.length)await db.$transaction([
    db.printJob.updateMany({where:{id:{in:uncertain.map(j=>j.id)},status:'SUBMITTING'},data:{status:'OUTCOME_UNKNOWN',physicalStatus:'UNKNOWN',claimedById:null,leaseTokenHash:null,leaseExpiresAt:null,error:'AGENT_DISCONNECTED_DURING_SUBMISSION'}}),
  ]);
  if(recoveredAttempts.count)log('warn','agent.job.attempts.recovered',{count:recoveredAttempts.count});
  return {requeued,outcomeUnknown:uncertain.length,attemptsRecovered:recoveredAttempts.count};
}
function leaseValid(job:{claimedById:string|null;leaseTokenHash:string|null;leaseExpiresAt:Date|null},agentId:string,token:string){return job.claimedById===agentId&&!!job.leaseTokenHash&&!!job.leaseExpiresAt&&job.leaseExpiresAt>new Date()&&verifySecret(token,job.leaseTokenHash);}

export function createAgentRouter(db:PrismaClient){
 const router=Router();router.use(authenticateAgent(db));
 router.post('/heartbeat',async(req:AgentRequest,res,next)=>{try{const agent=req.agent!,now=new Date();const capabilities=z.object({source:z.string().max(80),supportsColor:z.boolean(),canDuplex:z.boolean(),paperSizes:z.array(z.string().max(80)).max(100),resolutions:z.array(z.string().max(80)).max(100)}).optional();const b=z.object({observedQueue:z.object({name:z.string().max(250),installedQueue:z.boolean(),available:z.boolean(),status:z.string().max(80),capabilities}).optional()}).parse(req.body??{});await reapExpired(db);const expires=new Date(now.getTime()+leaseSeconds*1000);const [device]=await Promise.all([
   db.agentDevice.update({where:{id:agent.id},data:{lastSeenAt:now}}),
   db.printJob.updateMany({where:{claimedById:agent.id,status:{in:['LEASED','DOWNLOADED','SUBMITTING']}},data:{leaseExpiresAt:expires}}),
 ]);if(b.observedQueue){if(b.observedQueue.name!==((await db.printer.findUnique({where:{id:agent.printerId},select:{queueName:true}}))?.queueName??''))return fail(res,400,'QUEUE_BINDING_MISMATCH','Observed queue does not match this agent printer binding.');await db.printer.update({where:{id:agent.printerId},data:{status:b.observedQueue.available&&b.observedQueue.installedQueue?`AVAILABLE:${b.observedQueue.status}`:`UNAVAILABLE:${b.observedQueue.status}`,...(b.observedQueue.capabilities?{capabilities:b.observedQueue.capabilities as Prisma.InputJsonValue}:{})}});}const printer=await db.printer.findUnique({where:{id:agent.printerId}});res.json({ok:true,serverTime:now.toISOString(),leaseSeconds,device:{id:device.id,name:device.name,shopId:agent.shopId,printerId:agent.printerId,mode:agent.mode},printer:printer&&{id:printer.id,name:printer.name,queueName:printer.queueName,status:printer.status,capabilities:printer.capabilities}});}catch(e){next(e);}});
 router.post('/jobs/claim',async(req:AgentRequest,res,next)=>{try{
  await reapExpired(db);
  const agent=req.agent!,now=new Date(),expires=new Date(now.getTime()+leaseSeconds*1000);
  let token='';
  const skipped=new Set<string>();
  let raceLostCount=0;
  const connectedDevices=await db.agentDevice.findMany({where:{shopId:agent.shopId,lastSeenAt:{gt:new Date(now.getTime()-45_000)},user:{is:{isActive:true}}},select:{printerId:true}});
  const connectedPrinterIds=new Set(connectedDevices.flatMap(device=>device.printerId?[device.printerId]:[]));
  const adoptJob=(job:{printerId:string|null;createdAt:Date;printer:{shopId:string}|null})=>canAdoptQueuedJob({printerId:job.printerId,createdAt:job.createdAt,printerShopId:job.printer?.shopId},agent,connectedPrinterIds,now);
  const claimed=await atomicClaimNext({
   candidate:async()=>{
    while(true){
     const candidates=await db.printJob.findMany({
      where:{status:'QUEUED',order:{shopId:agent.shopId},...(skipped.size?{id:{notIn:[...skipped]}}:{})},
      orderBy:{createdAt:'asc'},
      take:25,
      select:{id:true,orderId:true,printerId:true,mode:true,attempt:true,maxAttempts:true,nextAttemptAt:true,claimedById:true,leaseExpiresAt:true,createdAt:true,printer:{select:{shopId:true}}},
     });
     for(const candidate of candidates){
      const reassignPrinter=candidate.printerId!==agent.printerId&&adoptJob(candidate);
      const reason=candidate.claimedById&&candidate.leaseExpiresAt&&candidate.leaseExpiresAt>now?'ACTIVE_LEASE':claimSkipReason(candidate,agent,now,maxAttempts,reassignPrinter);
      if(reason){skipped.add(candidate.id);log('warn','agent.job.claim.skipped',{agentId:agent.id,shopId:agent.shopId,printerId:agent.printerId,jobId:candidate.id,reason});continue;}
      const payment=await db.payment.findUnique({where:{orderId:candidate.orderId},select:{status:true}});
      if(!canQueuePayment(payment?.status)){skipped.add(candidate.id);log('warn','agent.job.claim.skipped',{agentId:agent.id,shopId:agent.shopId,printerId:agent.printerId,jobId:candidate.id,reason:'PAYMENT_NOT_ELIGIBLE',paymentStatus:payment?.status??'MISSING'});continue;}
      return candidate;
     }
     if(candidates.length<25)return undefined;
    }
   },
   claimIfQueued:async(candidate:{id:string;orderId:string;printerId:string|null;mode:string;attempt:number;maxAttempts:number;nextAttemptAt:Date|null;createdAt:Date;printer:{shopId:string}|null})=>{
    if(candidate.printerId!==agent.printerId&&candidate.printerId!==null){
     if(candidate.printer&&candidate.printer.shopId!==agent.shopId){skipped.add(candidate.id);log('warn','agent.job.claim.skipped',{agentId:agent.id,shopId:agent.shopId,printerId:agent.printerId,jobId:candidate.id,reason:'PRINTER_MISMATCH'});return undefined;}
     const oldPrinterStillConnected=await db.agentDevice.findFirst({where:{shopId:agent.shopId,printerId:candidate.printerId,lastSeenAt:{gt:new Date(now.getTime()-45_000)},user:{is:{isActive:true}}},select:{id:true}});
     if(oldPrinterStillConnected&&!adoptJob(candidate)){skipped.add(candidate.id);log('warn','agent.job.claim.skipped',{agentId:agent.id,shopId:agent.shopId,printerId:agent.printerId,jobId:candidate.id,reason:'PRINTER_MISMATCH'});return undefined;}
    }
    const payment=await db.payment.findUnique({where:{orderId:candidate.orderId},select:{status:true}});
    if(!canQueuePayment(payment?.status)){skipped.add(candidate.id);log('warn','agent.job.claim.skipped',{agentId:agent.id,shopId:agent.shopId,printerId:agent.printerId,jobId:candidate.id,reason:'PAYMENT_NOT_ELIGIBLE',paymentStatus:payment?.status??'MISSING'});return undefined;}
    token=`qpl_${randomUUID()}`;
    const updated=await db.printJob.updateMany({
     where:claimCasWhere(candidate),
     data:{printerId:agent.printerId,status:'LEASED',claimedById:agent.id,leaseTokenHash:hashSecret(token),leaseExpiresAt:expires,attempt:{increment:1},error:null},
    });
    if(!updated.count){skipped.add(candidate.id);raceLostCount++;log('info','agent.job.claim.race_lost',{agentId:agent.id,shopId:agent.shopId,printerId:agent.printerId,jobId:candidate.id,candidatePrinterId:candidate.printerId,candidateMode:candidate.mode,attempt:candidate.attempt,maxAttempts:candidate.maxAttempts,nextAttemptAt:candidate.nextAttemptAt?.toISOString()??null});}
    return updated.count?candidate:undefined;
   },
  });
  if(!claimed){
   const [allJobs,queuedCount]=await Promise.all([
    db.printJob.count({where:{order:{shopId:agent.shopId}}}),
    db.printJob.count({where:{status:'QUEUED',order:{shopId:agent.shopId}}}),
   ]);
   const queued=await db.printJob.findMany({where:{status:'QUEUED',order:{shopId:agent.shopId}},take:101,orderBy:{createdAt:'asc'},select:{id:true,printerId:true,mode:true,attempt:true,maxAttempts:true,nextAttemptAt:true,claimedById:true,leaseExpiresAt:true,createdAt:true,printer:{select:{shopId:true}},order:{select:{payment:{select:{status:true}}}}}});
   const inspected=queued.slice(0,100);
   const reasons:Record<string,number>={status:Math.max(0,allJobs-queuedCount),lease:0,printer:0,mode:0,payment:0,attempt:0,retry:0,eligible:0};
   const examples:Array<{jobId:string;reason:string;paymentStatus?:string}>=[];
   for(const job of inspected){
    const reassignPrinter=job.printerId!==agent.printerId&&adoptJob(job);
    const reason=job.claimedById&&job.leaseExpiresAt&&job.leaseExpiresAt>now?'ACTIVE_LEASE':claimSkipReason(job,agent,now,maxAttempts,reassignPrinter)??(canQueuePayment(job.order.payment?.status)?'ELIGIBLE':'PAYMENT_NOT_ELIGIBLE');
    const reasonKey=reason==='ACTIVE_LEASE'?'lease':reason==='PRINTER_MISMATCH'?'printer':reason==='MODE_MISMATCH'?'mode':reason==='PAYMENT_NOT_ELIGIBLE'?'payment':reason==='ATTEMPT_LIMIT'?'attempt':reason==='RETRY_SCHEDULED'?'retry':'eligible';
    reasons[reasonKey]=(reasons[reasonKey]??0)+1;
    if(examples.length<10)examples.push({jobId:job.id,reason,...(job.order.payment?.status?{paymentStatus:job.order.payment.status}:{})});
   }
   if(!queuedCount)reasons.NO_QUEUED_JOBS=1;
   const diagnostics={agentId:agent.id,shopId:agent.shopId,printerId:agent.printerId,mode:agent.mode,queueName:agent.queueName,totalJobsForShop:allJobs,queuedJobsForShop:queuedCount,queuedJobsInspected:inspected.length,inspectionTruncated:queuedCount>inspected.length,raceLostCandidates:raceLostCount,reasons,examples};
   log('warn','agent.job.claim.empty',diagnostics);
   return res.json({job:null,leaseSeconds,diagnostics:{queueName:agent.queueName,mode:agent.mode,totalJobsForShop:allJobs,queuedJobsForShop:queuedCount,queuedJobsInspected:inspected.length,inspectionTruncated:queuedCount>inspected.length,raceLostCandidates:raceLostCount,reasons,examples}});
  }
  const job=await db.printJob.findUniqueOrThrow({where:{id:claimed.id},include:{order:{include:{document:true,payment:true}}}});
  log('info','agent.job.claimed',{agentId:agent.id,shopId:agent.shopId,printerId:agent.printerId,jobId:job.id,attempt:job.attempt,paymentStatus:job.order.payment?.status});
  res.json({job:{id:job.id,idempotencyKey:job.idempotencyKey,mode:job.mode,status:job.status,attempt:job.attempt,leaseToken:token,leaseExpiresAt:expires.toISOString(),order:{id:job.order.id,paperSize:job.order.paperSize,copies:job.order.copies,color:job.order.color,pageCount:job.order.document.pageCount,paymentStatus:job.order.payment?.status}},leaseSeconds});
 }catch(e){next(e);}});
 router.get('/jobs/:id/state',async(req:AgentRequest,res,next)=>{try{const agent=req.agent!,id=routeParam(req,"id");await reapExpired(db);const job=await db.printJob.findUnique({where:{id},select:{id:true,printerId:true,mode:true,status:true,physicalStatus:true,claimedById:true,leaseTokenHash:true,leaseExpiresAt:true,order:{select:{shopId:true}}}});if(!job||job.printerId!==agent.printerId||job.mode!==agent.mode||job.order.shopId!==agent.shopId)return fail(res,404,'JOB_NOT_FOUND','Job is not assigned to this agent.');const supplied=String(req.headers['x-job-lease']||'');res.json({id:job.id,status:job.status,physicalStatus:job.physicalStatus,leaseExpiresAt:job.leaseExpiresAt?.toISOString()??null,leaseOwned:!!supplied&&leaseValid(job,agent.id,supplied),claimedByThisAgent:job.claimedById===agent.id});}catch(e){next(e);}});
 router.get('/jobs/:id/print-options',async(req:AgentRequest,res,next)=>{try{const agent=req.agent!,token=String(req.headers['x-job-lease']||'');const job=await db.printJob.findUnique({where:{id:routeParam(req,'id')},include:{order:{select:{shopId:true,doubleSided:true}}}});if(!job||job.printerId!==agent.printerId||job.mode!==agent.mode||job.order.shopId!==agent.shopId)return fail(res,404,'JOB_NOT_FOUND','Job is not assigned to this agent.');if(!leaseValid(job,agent.id,token))return fail(res,409,'LEASE_INVALID','Job lease is invalid or expired.');res.setHeader('Cache-Control','private, no-store');res.json({doubleSided:job.order.doubleSided});}catch(e){next(e);}});
 router.get('/jobs/:id/document',async(req:AgentRequest,res,next)=>{
  const agent=req.agent!,jobId=String(req.params.id),started=Date.now();
  try{
   const token=String(req.headers['x-job-lease']||'');
   if(!token)return fail(res,409,'LEASE_INVALID','Job lease is invalid or expired.');
   const job=await db.printJob.findUnique({where:{id:routeParam(req,'id')},include:{order:{include:{document:true}}}});
   if(!job||job.printerId!==agent.printerId||job.mode!==agent.mode||job.order.shopId!==agent.shopId)return fail(res,404,'JOB_NOT_FOUND','Job is not assigned to this agent.');
   if(!leaseValid(job,agent.id,token))return fail(res,409,'LEASE_INVALID','Job lease is invalid or expired.');
   if(!['LEASED','DOWNLOADED'].includes(job.status))return fail(res,409,'JOB_NOT_DOWNLOADABLE','Job is not ready for download.');
   const doc=job.order.document;
   if(doc.deletedAt)return fail(res,410,'DOCUMENT_EXPIRED','The source document is no longer retained.');
   const sourceKey=doc.storageKey;
   const fitted=await fitPdf(await readPrivatePdf(sourceKey),{paperSize:job.order.paperSize as 'A4'|'A3'|'LETTER',orientation:'AUTO'});
   if(job.status==='LEASED')await db.printJob.updateMany({where:{id:job.id,status:'LEASED',claimedById:agent.id,leaseTokenHash:hashSecret(token)},data:{status:'DOWNLOADED'}});
   res.setHeader('Cache-Control','private, no-store');
   res.setHeader('X-Print-Job-Id',job.id);
   res.setHeader('X-Page-Count',String(fitted.pageCount));
   const bytes=Buffer.from(fitted.pdf);
   const delivery=describeDocumentDelivery(usesPrivateBlob());
   if(usesPrivateBlob()){
    const key=fittedBlobKey(job.id);
    await writePrivatePdf(key,bytes,{overwrite:true});
    const downloadUrl=await createPrivateDownloadUrl(key);
    log('info','agent.job.document.ready',{agentId:agent.id,shopId:agent.shopId,printerId:agent.printerId,jobId:job.id,bytes:bytes.length,pageCount:fitted.pageCount,contentType:delivery.contentType,storage:delivery.storage,fittedKey:key,sourceStored:true,durationMs:Date.now()-started});
    return res.json({downloadUrl,pageCount:fitted.pageCount,expiresInSeconds:300});
   }
   log('info','agent.job.document.ready',{agentId:agent.id,shopId:agent.shopId,printerId:agent.printerId,jobId:job.id,bytes:bytes.length,pageCount:fitted.pageCount,contentType:delivery.contentType,storage:delivery.storage,durationMs:Date.now()-started});
   res.setHeader('Content-Type','application/pdf');
   res.setHeader('Content-Disposition',`attachment; filename="${job.id}.pdf"`);
   res.send(bytes);
  }catch(e){
   log('error','agent.job.document.download_failed',{agentId:agent.id,shopId:agent.shopId,printerId:agent.printerId,jobId,errorType:e instanceof Error?e.name:'unknown',durationMs:Date.now()-started});
   next(e);
  }
 });
 router.post('/jobs/:id/status',async(req:AgentRequest,res,next)=>{try{const b=z.object({eventKey:z.string().min(12).max(100),status:z.enum(['SUBMITTING','SPOOLER_ACCEPTED','SIMULATED_COMPLETE','FAILED','OUTCOME_UNKNOWN']),leaseToken:z.string().min(20),error:z.string().max(500).optional(),externalJobId:z.string().max(200).optional()}).parse(req.body);const agent=req.agent!;const job=await db.printJob.findUnique({where:{id:routeParam(req, "id")}});if(!job||job.printerId!==agent.printerId||job.mode!==agent.mode)return fail(res,404,'JOB_NOT_FOUND','Job is not assigned to this agent.');const prior=await db.agentEvent.findUnique({where:{jobId_eventKey:{jobId:routeParam(req, "id"),eventKey:b.eventKey}}});const duplicate=resolveAgentEvent(prior,agent.id,b.status);if(duplicate==='REPLAY')return res.json({ok:true,idempotentReplay:true,status:b.status});if(duplicate==='CONFLICT')return fail(res,409,'EVENT_KEY_CONFLICT','Event key was already used for a different update.');if(!leaseValid(job,agent.id,b.leaseToken))return fail(res,409,'LEASE_INVALID','Job lease is invalid or expired.');if(!canTransitionJob(job.status as AgentJobState,b.status as AgentJobState))return fail(res,409,'INVALID_JOB_TRANSITION',`Cannot transition ${job.status} to ${b.status}.`);if(b.status==='SPOOLER_ACCEPTED'&&job.mode!=='REAL')return fail(res,409,'MODE_MISMATCH','Simulated jobs cannot report spooler acceptance.');if(b.status==='SIMULATED_COMPLETE'&&job.mode!=='SIMULATED')return fail(res,409,'MODE_MISMATCH','Real jobs cannot report simulated completion.');if(b.status==='FAILED'&&job.status==='SUBMITTING')return fail(res,409,'OUTCOME_MUST_BE_UNKNOWN','After submission begins, interruptions must be reported as OUTCOME_UNKNOWN.');
  const physical:PhysicalPrintStatus=b.status==='SPOOLER_ACCEPTED'?'SPOOLER_ACCEPTED':b.status==='SIMULATED_COMPLETE'?'SIMULATED_ONLY':b.status==='OUTCOME_UNKNOWN'?'UNKNOWN':job.physicalStatus;
  const now=new Date(),terminal=['SPOOLER_ACCEPTED','SIMULATED_COMPLETE','FAILED','OUTCOME_UNKNOWN'].includes(b.status);await db.$transaction(async tx=>{await tx.agentEvent.create({data:{jobId:job.id,agentDeviceId:agent.id,eventKey:b.eventKey,eventType:b.status,payload:{error:b.error,externalJobId:b.externalJobId} as Prisma.InputJsonValue}});const changed=await tx.printJob.updateMany({where:{id:job.id,status:job.status,claimedById:agent.id,leaseTokenHash:hashSecret(b.leaseToken),leaseExpiresAt:{gt:now}},data:{status:b.status as PrintJobStatus,physicalStatus:physical,error:b.error??null,externalJobId:b.externalJobId??job.externalJobId,submissionStartedAt:b.status==='SUBMITTING'?now:job.submissionStartedAt,completedAt:terminal?now:undefined,...(terminal?{claimedById:null,leaseTokenHash:null,leaseExpiresAt:null}:{})}});if(!changed.count){const conflict=Object.assign(new Error('Job state changed before status update committed.'),{code:'AGENT_JOB_CONFLICT'});throw conflict;}});log('info','agent.job.status',{agentId:agent.id,shopId:agent.shopId,jobId:job.id,status:b.status,mode:job.mode});res.json({ok:true,status:b.status,physicalStatus:physical,physicalPrintConfirmed:false});
 }catch(e){if((e as {code?:string})?.code==='P2002')return fail(res,409,'DUPLICATE_EVENT','A concurrent status event already used this key.');if((e as {code?:string})?.code==='AGENT_JOB_CONFLICT')return fail(res,409,'JOB_STATE_CONFLICT','The job lease or status changed; refresh the job state.');next(e);}});
 return router;
}

export {reapExpired};
