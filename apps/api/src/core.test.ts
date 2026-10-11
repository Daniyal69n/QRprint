import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {fitPdf} from './pdf-fit.js';
import {MockPaymentAdapter} from './payments.js';
import {agentCanReportJob,canAccessShop,resolveOrderIdempotency} from './policies.js';
import {calculatePrice} from '@qr-print/shared';

test('PDF Auto-Fit centers and scales pages to requested paper',async()=>{
  const input=await PDFDocument.create();input.addPage([1200,600]).drawText('test');const result=await fitPdf(await input.save(),{paperSize:'A4',orientation:'AUTO'});
  const output=await PDFDocument.load(result.pdf);assert.equal(output.getPageCount(),1);assert.equal(result.pages[0]!.orientation,'LANDSCAPE');assert.ok(result.pages[0]!.scale<1);assert.ok(Math.abs(result.pages[0]!.x-(result.pages[0]!.width-(1200*result.pages[0]!.scale))/2)<0.01);
});
test('payment verification accepts only adapter-issued mock references',async()=>{const p=new MockPaymentAdapter();const created=await p.create(10,'order');assert.equal(created.status,'PENDING');assert.equal(await p.verify(created.providerRef),true);assert.equal(await p.verify('untrusted'),false);});
test('tenant policy prevents cross-shop access',()=>{assert.equal(canAccessShop('SHOP_OWNER','owner-a','owner-b'),false);assert.equal(canAccessShop('SUPER_ADMIN','root','owner-b'),true);});
test('agent communication requires matching shop and execution mode',()=>{assert.equal(agentCanReportJob('shop-a','shop-a','SIMULATED','SIMULATED'),true);assert.equal(agentCanReportJob('shop-a','shop-b','REAL','REAL'),false);assert.equal(agentCanReportJob('shop-a','shop-a','REAL','SIMULATED'),false);});
test('order idempotency keys replay only to the same customer',()=>{const existing={customerId:'c1',id:'o1'};assert.deepEqual(resolveOrderIdempotency(undefined,'c1'),{kind:'NEW'});assert.deepEqual(resolveOrderIdempotency(existing,'c1'),{kind:'REPLAY',order:existing});assert.deepEqual(resolveOrderIdempotency(existing,'c2'),{kind:'HIDDEN'});});
test('pricing multiplies copies and pages',()=>assert.equal(calculatePrice(5,2,3),30));
