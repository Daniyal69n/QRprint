import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {PrismaClient} from '@prisma/client';
import type {Response} from 'express';
import {atomicClaimNext,canAgentUseShop,canQueuePayment,expiredLeaseAction,isAgentCredential,mintAgentSecret,resolveAgentEvent,type AgentJobState} from './agent-core.js';
import {authenticateAgent,type AgentRequest} from './agent-auth.js';

test('agent credential format rejects missing or malformed secrets',()=>{const key=mintAgentSecret();assert.equal(isAgentCredential(key),true);assert.equal(isAgentCredential('agent-password'),false);});
test('unauthorized agent is rejected before database lookup',async()=>{let code=0;let body:unknown;const response={status(n:number){code=n;return this;},json(value:unknown){body=value;return this;}};await authenticateAgent({} as PrismaClient)({headers:{authorization:'Bearer invalid'}} as AgentRequest,response as unknown as Response,()=>assert.fail('next must not be called'));assert.equal(code,401);assert.equal((body as {error:{code:string}}).error.code,'AGENT_UNAUTHORIZED');});
test('agent cannot cross shop boundaries',()=>{assert.equal(canAgentUseShop('shop-a','shop-a'),true);assert.equal(canAgentUseShop('shop-a','shop-b'),false);});
test('atomic claim compare-and-set gives concurrent agents distinct jobs',async()=>{const jobs=[{id:'j1',state:'QUEUED' as AgentJobState},{id:'j2',state:'QUEUED' as AgentJobState}];const repo={candidate:async()=>jobs.find(j=>j.state==='QUEUED'),claimIfQueued:async(j:{id:string;state:AgentJobState})=>{if(j.state!=='QUEUED')return undefined;j.state='LEASED';return j;}};const claimed=await Promise.all([atomicClaimNext(repo),atomicClaimNext(repo)]);assert.deepEqual(claimed.map(x=>x?.id).sort(),['j1','j2']);});
test('expired leases distinguish safe requeue from uncertain submission',()=>{assert.equal(expiredLeaseAction('LEASED'),'REQUEUE');assert.equal(expiredLeaseAction('DOWNLOADED'),'REQUEUE');assert.equal(expiredLeaseAction('SUBMITTING'),'UNKNOWN');assert.equal(expiredLeaseAction('SPOOLER_ACCEPTED'),'IGNORE');});
test('agent status event key retries replay and conflicting duplicates reject',()=>{const prior={agentDeviceId:'a1',eventType:'SUBMITTING'};assert.equal(resolveAgentEvent(prior,'a1','SUBMITTING'),'REPLAY');assert.equal(resolveAgentEvent(prior,'a1','FAILED'),'CONFLICT');assert.equal(resolveAgentEvent(null,'a1','SUBMITTING'),'NEW');});
test('a submit interruption cannot be classified as an automatic retry',()=>{assert.equal(expiredLeaseAction('SUBMITTING'),'UNKNOWN');});
test('only verified online or owner-authorized cash payments may queue',()=>{assert.equal(canQueuePayment('VERIFIED'),true);assert.equal(canQueuePayment('CASH_AUTHORIZED'),true);assert.equal(canQueuePayment('PENDING'),false);assert.equal(canQueuePayment(null),false);});
