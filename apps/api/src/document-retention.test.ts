import assert from 'node:assert/strict';
import test from 'node:test';
import {canRetainDocumentDelete} from './document-retention.js';

test('document retention blocks active, retryable, and outcome-unknown print jobs',()=>{
  for(const status of ['QUEUED','LEASED','DOWNLOADED','SUBMITTING','OUTCOME_UNKNOWN'])
    assert.equal(canRetainDocumentDelete({orders:[{status:'OPEN',printJob:{mode:'REAL',status,physicalStatus:'UNKNOWN',attempt:1,maxAttempts:3}}]}),false,status);
  assert.equal(canRetainDocumentDelete({orders:[{status:'OPEN',printJob:{mode:'REAL',status:'FAILED',physicalStatus:'NOT_SUBMITTED',attempt:1,maxAttempts:3}}]}),false);
});

test('document retention allows aged orphan, cancelled, exhausted-failure, simulation, or confirmed output records',()=>{
  assert.equal(canRetainDocumentDelete({orders:[]}),true);
  assert.equal(canRetainDocumentDelete({orders:[{status:'CANCELLED',printJob:null}]}),true);
  assert.equal(canRetainDocumentDelete({orders:[{status:'OPEN',printJob:{mode:'REAL',status:'FAILED',physicalStatus:'NOT_SUBMITTED',attempt:3,maxAttempts:3}}]}),true);
  assert.equal(canRetainDocumentDelete({orders:[{status:'OPEN',printJob:{mode:'SIMULATED',status:'SIMULATED_COMPLETE',physicalStatus:'SIMULATED_ONLY',attempt:1,maxAttempts:3}}]}),true);
  assert.equal(canRetainDocumentDelete({orders:[{status:'READY_FOR_PICKUP',printJob:{mode:'REAL',status:'SPOOLER_ACCEPTED',physicalStatus:'OUTPUT_CONFIRMED',attempt:1,maxAttempts:3}}]}),true);
});
