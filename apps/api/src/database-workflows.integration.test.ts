import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import jwt from 'jsonwebtoken';
import { PDFDocument } from 'pdf-lib';
import { PrismaClient } from '@prisma/client';
import { issueToken } from './auth.js';
import { hashSecret, mintAgentSecret } from './agent-core.js';
import { createApp } from './app.js';
import { assertDatabaseTarget } from './database-target.js';

const db = new PrismaClient();
assertDatabaseTarget(process.env.MONGODB_URI, 'qr_print_test');
const actualDatabase = async () => {
  const result = await db.$runCommandRaw({ ping: 1 });
  assert.equal(Number(result.ok), 1, 'MongoDB must confirm a successful ping before fixtures or cleanup');
};

const tag = `qr-it-${randomUUID()}`;
const userIds: string[] = [];
const shopIds: string[] = [];
const printerIds: string[] = [];
const agentIds: string[] = [];
const documentIds: string[] = [];
const orderIds: string[] = [];
const paymentIds: string[] = [];
const jobIds: string[] = [];
const auditTargetIds: string[] = [];
let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
let baseUrl = '';
let pdfPath = '';

before(async () => {
  await actualDatabase();
  const app = createApp(db);
  server = app.listen(0);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Integration HTTP server failed to bind an ephemeral port.');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test('public shop-owner registration atomically creates a fixed-role owner and shop',async()=>{
  const email=`${tag}-self-service@example.invalid`;
  const slug=`${tag}-self-service`;
  const body={ownerName:'Self-service Owner',email,password:'integration-test-password',shopName:'Self-service Print Shop',slug};
  const roleOverride=await fetch(`${baseUrl}/auth/register/shop-owner`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,role:'SUPER_ADMIN'})});
  assert.equal(roleOverride.status,400);
  const roleError=await roleOverride.json() as {error:{details:Array<{field:string;message:string}>}};
  assert.ok(roleError.error.details.some(issue=>issue.message?.includes('Unrecognized key')));
  assert.equal(await db.user.findUnique({where:{email},select:{id:true}}),null);

  const invalidSlug=await fetch(`${baseUrl}/auth/register/shop-owner`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,slug:'Elite'})});
  assert.equal(invalidSlug.status,400);
  const slugError=await invalidSlug.json() as {error:{details:Array<{field:string;message:string}>}};
  assert.ok(slugError.error.details.some(issue=>issue.field==='slug'));

  const response=await fetch(`${baseUrl}/auth/register/shop-owner`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(response.status,201);
  const registered=await response.json() as {token:string;role:string;shop:{id:string;name:string;slug:string}};
  assert.equal(registered.role,'SHOP_OWNER');
  assert.ok(registered.token);
  assert.equal(registered.shop.slug,slug);
  const owner=await db.user.findUniqueOrThrow({where:{email},include:{shops:true}});
  userIds.push(owner.id);
  shopIds.push(...owner.shops.map(shop=>shop.id));
  auditTargetIds.push(...owner.shops.map(shop=>shop.id));
  assert.equal(owner.role,'SHOP_OWNER');
  assert.equal(owner.name,'Self-service Owner');
  assert.equal(owner.shops.length,1);
  assert.equal(owner.shops[0]!.ownerId,owner.id);

  const duplicateEmail=await fetch(`${baseUrl}/auth/register/shop-owner`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,email:email.toUpperCase(),slug:`${slug}-other`})});
  assert.equal(duplicateEmail.status,409);
  const duplicateSlug=await fetch(`${baseUrl}/auth/register/shop-owner`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,email:`${tag}-other@example.invalid`})});
  assert.equal(duplicateSlug.status,409);

  const ownerShops=await fetch(`${baseUrl}/owner/shops`,{headers:{authorization:`Bearer ${registered.token}`}});
  assert.equal(ownerShops.status,200);
  const shops=await ownerShops.json() as Array<{id:string;slug:string}>;
  assert.deepEqual(shops.map(shop=>shop.id),[owner.shops[0]!.id]);
  const ownerProfile=await fetch(`${baseUrl}/owner/profile`,{headers:{authorization:`Bearer ${issueToken(owner.id,'SHOP_OWNER')}`}});
  assert.equal(ownerProfile.status,200);
  const profile=await ownerProfile.json() as {name:string;email:string;shops:Array<{id:string;slug:string}>};
  assert.equal(profile.name,'Self-service Owner');
  assert.equal(profile.email,email);
  assert.equal(profile.shops[0]?.id,owner.shops[0]!.id);

  const qr=await fetch(`${baseUrl}/shops/${encodeURIComponent(slug)}/qr.png`);
  assert.equal(qr.status,200);
  assert.match(qr.headers.get('content-type')??'',/image\/png/);
  assert.deepEqual(Array.from(new Uint8Array(await qr.arrayBuffer()).slice(0,8)),[137,80,78,71,13,10,26,10]);
});

test('public guest checkout gets a short-lived customer session without an account login',async()=>{
  const roleOverride=await fetch(`${baseUrl}/auth/guest`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'SUPER_ADMIN'})});
  assert.equal(roleOverride.status,400,'guest registration does not accept a client-selected role');
  const response=await fetch(`${baseUrl}/auth/guest`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,201);
  const session=await response.json() as {token:string;role:string};
  assert.equal(session.role,'CUSTOMER');
  assert.ok(session.token);
  const claims=jwt.decode(session.token) as {id:string;iat:number;exp:number};
  assert.equal(claims.exp-claims.iat,7200,'guest sessions expire after two hours');
  const user=await db.user.findUniqueOrThrow({where:{id:claims.id}});
  userIds.push(user.id);
  assert.match(user.email,/^guest-[0-9a-f-]+@guest\.qrprint\.invalid$/);
  assert.equal(user.name,null);
  const shops=await fetch(`${baseUrl}/owner/shops`,{headers:{authorization:`Bearer ${session.token}`}});
  assert.equal(shops.status,403);
  const profile=await fetch(`${baseUrl}/owner/profile`,{headers:{authorization:`Bearer ${session.token}`}});
  assert.equal(profile.status,403);
});

after(async () => {
  if (server) { server.close(); await once(server, 'close'); }
  await actualDatabase();
  // Delete only primary keys captured from this run's UUID-tagged fixture.
  await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: userIds } }, { targetId: { in: auditTargetIds } }] } });
  await db.agentEvent.deleteMany({ where: { jobId: { in: jobIds } } });
  await db.printJob.deleteMany({ where: { id: { in: jobIds } } });
  await db.payment.deleteMany({ where: { id: { in: paymentIds } } });
  await db.order.deleteMany({ where: { id: { in: orderIds } } });
  await db.document.deleteMany({ where: { id: { in: documentIds } } });
  await db.pricing.deleteMany({ where: { shopId: { in: shopIds } } });
  await db.agentDevice.deleteMany({ where: { id: { in: agentIds } } });
  await db.printer.deleteMany({ where: { id: { in: printerIds } } });
  await db.shop.deleteMany({ where: { id: { in: shopIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  if (pdfPath) await rm(pdfPath, { force: true });
  await db.$disconnect();
});

test('database-backed tenant, payment, queue, agent lease, event, and retry workflows', async () => {
  await actualDatabase();
  const [owner, otherOwner, customer, agentUser, contenderUser, admin] = await Promise.all([
    db.user.create({ data: { email: `${tag}-owner@integration.invalid`, passwordHash: 'test-only', role: 'SHOP_OWNER' } }),
    db.user.create({ data: { email: `${tag}-other@integration.invalid`, passwordHash: 'test-only', role: 'SHOP_OWNER' } }),
    db.user.create({ data: { email: `${tag}-customer@integration.invalid`, passwordHash: 'test-only', role: 'CUSTOMER' } }),
    db.user.create({ data: { email: `${tag}-agent@integration.invalid`, passwordHash: 'test-only', role: 'AGENT' } }),
    db.user.create({ data: { email: `${tag}-contender@integration.invalid`, passwordHash: 'test-only', role: 'AGENT' } }),
    db.user.create({ data: { email: `${tag}-admin@integration.invalid`, passwordHash: 'test-only', role: 'SUPER_ADMIN' } }),
  ]);
  userIds.push(owner.id, otherOwner.id, customer.id, agentUser.id, contenderUser.id, admin.id);
  const [shop, otherShop] = await Promise.all([
    db.shop.create({ data: { ownerId: owner.id, name: `${tag} shop`, slug: `${tag}-shop` } }),
    db.shop.create({ data: { ownerId: otherOwner.id, name: `${tag} other`, slug: `${tag}-other` } }),
  ]);
  shopIds.push(shop.id, otherShop.id);
  const printer = await db.printer.create({ data: { shopId: shop.id, name: `${tag} simulated printer`, queueName: `${tag}-queue`, status: 'UNKNOWN' } });
  printerIds.push(printer.id);
  const stalePrinter = await db.printer.create({ data: { shopId: shop.id, name: `${tag} previous printer`, queueName: `${tag}-old-queue`, status: 'UNKNOWN' } });
  printerIds.push(stalePrinter.id);
  await db.pricing.create({ data: { shopId: shop.id, paperSize: 'A4', color: true, pricePerPage: 5, colorSurcharge: 2.5, updatedAt: new Date() } });

  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText('QR Print database integration fixture');
  const pdfBytes = await pdf.save();
  const docId = randomUUID();
  const storageKey = `${docId}.pdf`;
  pdfPath = path.resolve('storage', storageKey);
  await mkdir(path.dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, pdfBytes);
  const document = await db.document.create({ data: { id: docId, ownerId: customer.id, storageKey, mimeType: 'application/pdf', pageCount: 2 } });
  documentIds.push(document.id);

  const agentToken = mintAgentSecret();
  const agent = await db.agentDevice.create({ data: { shopId: shop.id, printerId: printer.id, userId: agentUser.id, name: `${tag} agent`, deviceKeyHash: hashSecret(agentToken), mode: 'SIMULATED' } });
  const contenderToken = mintAgentSecret();
  const contender = await db.agentDevice.create({ data: { shopId: shop.id, printerId: printer.id, userId: contenderUser.id, name: `${tag} contender`, deviceKeyHash: hashSecret(contenderToken), mode: 'SIMULATED' } });
  agentIds.push(agent.id, contender.id);
  const customerAuth = `Bearer ${issueToken(customer.id, 'CUSTOMER')}`;
  const ownerAuth = `Bearer ${issueToken(owner.id, 'SHOP_OWNER')}`;
  const otherOwnerAuth = `Bearer ${issueToken(otherOwner.id, 'SHOP_OWNER')}`;
  const adminAuth = `Bearer ${issueToken(admin.id, 'SUPER_ADMIN')}`;
  const agentTokens = [agentToken, contenderToken];
  const call = (route: string, init: RequestInit = {}) => fetch(`${baseUrl}${route}`, init);
  const json = (body: unknown, authorization = customerAuth): RequestInit => ({ method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const claimOne = async () => {
    const responses = await Promise.all(agentTokens.map(token => call('/agent/jobs/claim', { method: 'POST', headers: { authorization: `Bearer ${token}` } })));
    assert.ok(responses.every(response => response.status === 200));
    const claims = await Promise.all(responses.map(response => response.json() as Promise<{ job: { id: string; leaseToken: string; attempt: number } | null }>));
    const winners = claims.map((result, index) => ({ result, token: agentTokens[index]! })).filter(item => item.result.job !== null);
    assert.equal(winners.length, 1, 'concurrent agents must yield exactly one database claim');
    return { ...winners[0]!.result.job!, agentToken: winners[0]!.token };
  };

  const unauthenticated = await call(`/shops/${shop.id}/orders`);
  assert.equal(unauthenticated.status, 401, 'shop orders require authentication');
  const priorVercel=process.env.VERCEL;
  try {
    process.env.VERCEL='1';
    const prefixedHealth=await call('/api/health');
    assert.equal(prefixedHealth.status,200,'Vercel /api prefix is routed to the Express health endpoint');
    assert.equal((await prefixedHealth.json() as {database:string}).database,'ready');
    const protectedUpload=await call('/api/documents/upload-url',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(protectedUpload.status,401,'Vercel upload URL requires customer authentication before storage access');
    const prefixedPreview=await call(`/api/documents/${document.id}/preview?paperSize=A4&orientation=AUTO`,{headers:{authorization:customerAuth}});
    assert.equal(prefixedPreview.status,200,'Vercel /api prefix reaches the authenticated preview route');
    assert.match(prefixedPreview.headers.get('content-type')??'',/application\/pdf/);
    const prefixedOrder=await call('/api/orders',json({shopId:shop.id,documentId:document.id,copies:1,paperSize:'A4',color:true,idempotencyKey:`${tag}-prefixed`}));
    assert.equal(prefixedOrder.status,201,'Vercel /api prefix reaches order creation and resolves the supplied shop/document');
    const prefixedOrderData=await prefixedOrder.json() as {id:string};
    orderIds.push(prefixedOrderData.id);
    auditTargetIds.push(prefixedOrderData.id);
  } finally { if(priorVercel===undefined)delete process.env.VERCEL;else process.env.VERCEL=priorVercel; }
  const missingPreview=await call(`/documents/${randomUUID()}/preview?paperSize=A4`,{headers:{authorization:customerAuth}});
  assert.equal(missingPreview.status,404);
  assert.equal((await missingPreview.json() as {error:{code:string}}).error.code,'DOCUMENT_NOT_FOUND');
  const missingShopOrder=await call('/orders',json({shopId:`${tag}-unknown-shop`,documentId:document.id,copies:1,paperSize:'A4',color:true,idempotencyKey:`${tag}-missing-shop`}));
  assert.equal(missingShopOrder.status,404);
  assert.equal((await missingShopOrder.json() as {error:{code:string}}).error.code,'SHOP_NOT_FOUND');
  const missingDocumentOrder=await call('/orders',json({shopId:shop.id,documentId:randomUUID(),copies:1,paperSize:'A4',color:true,idempotencyKey:`${tag}-missing-doc`}));
  assert.equal(missingDocumentOrder.status,404);
  assert.equal((await missingDocumentOrder.json() as {error:{code:string}}).error.code,'DOCUMENT_NOT_FOUND');
  const qr = await call(`/shops/${shop.slug}/qr.svg`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type')||'',/image\/svg\+xml/);
  assert.match(await qr.text(),/<svg/);
  assert.equal(qr.headers.get('x-qr-public-url'),`http://localhost:3000/upload?shop=${shop.slug}`,'the QR exposes only the local public customer URL and shop slug');
  const crossShop = await call(`/shops/${shop.id}/orders`, { headers: { authorization: otherOwnerAuth } });
  assert.equal(crossShop.status, 404, 'another owner cannot read this shop');
  assert.equal((await call('/customer/orders')).status,401,'customer order history requires authentication');
  assert.equal((await call('/owner/shops',{headers:{authorization:customerAuth}})).status,403,'customer accounts cannot access shop-enrollment choices');
  const ownerShopChoices=await call('/owner/shops',{headers:{authorization:ownerAuth}});
  assert.equal(ownerShopChoices.status,200);
  assert.deepEqual((await ownerShopChoices.json() as Array<{id:string}>).map(s=>s.id),[shop.id]);
  assert.equal((await call('/admin/metrics',{headers:{authorization:ownerAuth}})).status,403,'shop owners cannot access platform metrics');
  assert.equal((await call('/admin/platform-settings',{headers:{authorization:ownerAuth}})).status,403,'shop owners cannot alter platform commission settings');
  assert.equal((await call('/admin/accounts/shop-owner',json({email:`${tag}-forbidden@integration.invalid`,password:'integration-password-123'},ownerAuth))).status,403,'shop owners cannot provision platform accounts');
  const provisionedOwner=await call('/admin/accounts/shop-owner',json({email:`${tag}-provisioned@integration.invalid`,password:'integration-password-123'},adminAuth));
  assert.equal(provisionedOwner.status,201);
  const provisionedOwnerRecord=await provisionedOwner.json() as {id:string;role:string};
  userIds.push(provisionedOwnerRecord.id);
  assert.equal(provisionedOwnerRecord.role,'SHOP_OWNER');
  const ownerPrinters=await call(`/shops/${shop.id}/printers`,{headers:{authorization:ownerAuth}});
  assert.equal(ownerPrinters.status,200);
  assert.equal((await ownerPrinters.json() as unknown[]).length,1);
  assert.equal((await call(`/shops/${shop.id}/printers`,{headers:{authorization:otherOwnerAuth}})).status,404,'printer routes are tenant scoped');
  const crossAgent = await call('/agent/jobs/claim', { method: 'POST' });
  assert.equal(crossAgent.status, 401, 'agent routes reject missing device credentials');
  let capabilities={source:'WINDOWS_DRIVER_QUEUE',supportsColor:false,canDuplex:false,paperSizes:['Letter'],resolutions:['Draft:300x300dpi']};
  const initialHeartbeat=await call('/agent/heartbeat',{...json({observedQueue:{name:printer.queueName,installedQueue:true,available:true,status:'DRIVER_REPORTED_READY',capabilities}},`Bearer ${agentToken}`)});
  assert.equal(initialHeartbeat.status,200);
  const agentStatus=await call(`/shops/${shop.id}/agents`,{headers:{authorization:ownerAuth}});
  assert.equal(agentStatus.status,200);
  const listedAgents=await agentStatus.json() as Array<{id:string;isConnected:boolean;printer:{capabilities:unknown}|null}>;
  assert.equal(listedAgents.find(a=>a.id===agent.id)?.isConnected,true);
  assert.deepEqual(listedAgents.find(a=>a.id===agent.id)?.printer?.capabilities,capabilities);
  const rejectedDuplexSetting=await call(`/shops/${shop.id}/settings`,{method:'PUT',headers:{authorization:ownerAuth,'content-type':'application/json'},body:JSON.stringify({supportsDuplex:true})});
  assert.equal(rejectedDuplexSetting.status,409,'a shop cannot enable duplex unless a registered driver reports it');
  capabilities={...capabilities,canDuplex:true};
  const duplexHeartbeat=await call('/agent/heartbeat',{...json({observedQueue:{name:printer.queueName,installedQueue:true,available:true,status:'DRIVER_REPORTED_READY',capabilities}},`Bearer ${agentToken}`)});
  assert.equal(duplexHeartbeat.status,200);
  const enabledDuplex=await call(`/shops/${shop.id}/settings`,{method:'PUT',headers:{authorization:ownerAuth,'content-type':'application/json'},body:JSON.stringify({supportsDuplex:true})});
  assert.equal(enabledDuplex.status,200);
  const shopPrintOptions=await call(`/shops/${shop.slug}/print-options`);
  assert.equal(shopPrintOptions.status,200);
  assert.equal((await shopPrintOptions.json() as {supportsDuplex:boolean}).supportsDuplex,true);

  const created = await call('/orders', json({ shopId: shop.id, documentId: document.id, copies: 3, paperSize: 'A4', color: true, idempotencyKey: `${tag}-order-one` }));
  assert.equal(created.status, 201);
  const order = await created.json() as { id: string; total: string; status: string };
  orderIds.push(order.id); auditTargetIds.push(order.id);
  assert.equal(Number(order.total), 45, 'server calculates two pages × three copies × (5 + 2.50)');
  assert.equal(order.status, 'OPEN');
  const selectedDuplex=await call(`/orders/${order.id}/print-options`,json({doubleSided:true}));
  assert.equal(selectedDuplex.status,200);
  assert.equal((await selectedDuplex.json() as {doubleSided:boolean}).doubleSided,true);
  const replay = await call('/orders', json({ shopId: shop.id, documentId: document.id, copies: 3, paperSize: 'A4', color: true, idempotencyKey: `${tag}-order-one` }));
  assert.equal(replay.status, 200, 'same-customer idempotency replays the persisted order');
  assert.equal((await replay.json() as { id: string }).id, order.id);

  const pendingPay = await call(`/orders/${order.id}/pay`, { ...json({}) });
  assert.equal(pendingPay.status, 200);
  const pendingPayment = await pendingPay.json() as { id: string; status: string; note: string; developmentOnly: boolean };
  paymentIds.push(pendingPayment.id);
  assert.equal(pendingPayment.status, 'PENDING');
  assert.equal(pendingPayment.note, 'mock-development-only');
  assert.equal(pendingPayment.developmentOnly, true);
  const blockedQueue = await call(`/orders/${order.id}/queue`, json({ printerId: printer.id }, ownerAuth));
  assert.equal(blockedQueue.status, 402, 'pending mock payment cannot enter queue');
  const verified = await call(`/payments/${pendingPayment.id}/verify`, json({}));
  assert.equal(verified.status, 200);
  const verification = await verified.json() as { orderStatus: string; payment: { status: string } };
  assert.equal(verification.payment.status, 'VERIFIED');
  assert.equal(verification.orderStatus, 'OPEN', 'payment verification does not advance order or print state');
  capabilities={...capabilities,canDuplex:false};
  const noDuplexHeartbeat=await call('/agent/heartbeat',{...json({observedQueue:{name:printer.queueName,installedQueue:true,available:true,status:'DRIVER_REPORTED_READY',capabilities}},`Bearer ${agentToken}`)});
  assert.equal(noDuplexHeartbeat.status,200);
  const blockedDuplexQueue=await call(`/orders/${order.id}/queue`,json({printerId:printer.id},ownerAuth));
  assert.equal(blockedDuplexQueue.status,409,'a duplex order cannot use a driver that no longer reports duplex support');
  capabilities={...capabilities,canDuplex:true};
  await call('/agent/heartbeat',{...json({observedQueue:{name:printer.queueName,installedQueue:true,available:true,status:'DRIVER_REPORTED_READY',capabilities}},`Bearer ${agentToken}`)});
  const queuedResponse = await call(`/orders/${order.id}/queue`, json({ printerId: printer.id }, ownerAuth));
  assert.equal(queuedResponse.status, 202);
  const queued = await queuedResponse.json() as { job: { id: string; status: string; mode: string; physicalStatus: string }; physicalPrintConfirmed: boolean };
  jobIds.push(queued.job.id); auditTargetIds.push(queued.job.id);
  assert.equal(queued.job.status, 'QUEUED');
  assert.equal(queued.job.mode, 'SIMULATED');
  assert.equal(queued.job.physicalStatus, 'NOT_SUBMITTED');
  assert.equal(queued.physicalPrintConfirmed, false);

  const claimed = await claimOne();
  assert.equal(claimed.id, queued.job.id);
  const leaseHeader = { authorization: `Bearer ${claimed.agentToken}`, 'x-job-lease': claimed.leaseToken };
  const leasedPrintOptions=await call(`/agent/jobs/${queued.job.id}/print-options`,{headers:leaseHeader});
  assert.equal((await leasedPrintOptions.json() as {doubleSided:boolean}).doubleSided,true);
  const download = await call(`/agent/jobs/${queued.job.id}/document`, { headers: leaseHeader });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/pdf');
  const localJobState=await call(`/agent/jobs/${queued.job.id}/state`,{headers:leaseHeader});
  assert.equal(localJobState.status,200);
  const localState=await localJobState.json() as {status:string;leaseOwned:boolean};
  assert.equal(localState.status,'DOWNLOADED');
  assert.equal(localState.leaseOwned,true);
  const submittingBody = { eventKey: `${tag}-submit-event`, status: 'SUBMITTING', leaseToken: claimed.leaseToken };
  const submitting = await call(`/agent/jobs/${queued.job.id}/status`, json(submittingBody, leaseHeader.authorization));
  assert.equal(submitting.status, 200);
  const duplicateEvent = await call(`/agent/jobs/${queued.job.id}/status`, json(submittingBody, leaseHeader.authorization));
  assert.equal(duplicateEvent.status, 200);
  assert.equal((await duplicateEvent.json() as { idempotentReplay: boolean }).idempotentReplay, true);
  await db.printJob.update({ where: { id: queued.job.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
  const heartbeat = await call('/agent/heartbeat', { method: 'POST', headers: { ...leaseHeader, 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(heartbeat.status, 200);
  const unknown = await db.printJob.findUniqueOrThrow({ where: { id: queued.job.id }, include: { order: { include: { payment: true } } } });
  assert.equal(unknown.status, 'OUTCOME_UNKNOWN', 'expired in-submission lease is not blindly retried');
  assert.equal(unknown.physicalStatus, 'UNKNOWN');
  assert.equal(unknown.order.status, 'OPEN');
  assert.equal(unknown.order.payment?.status, 'VERIFIED');
  const unsafeRetry = await call(`/shops/${shop.id}/jobs/${queued.job.id}/reconcile`, json({ decision: 'retry' }, ownerAuth));
  assert.equal(unsafeRetry.status, 409, 'outcome-unknown job cannot be retried before operator reconciliation');

  const retryOrderResponse = await call('/orders', json({ shopId: shop.id, documentId: document.id, copies: 1, paperSize: 'A4', color: true, idempotencyKey: `${tag}-order-two` }));
  assert.equal(retryOrderResponse.status, 201);
  const retryOrder = await retryOrderResponse.json() as { id: string };
  orderIds.push(retryOrder.id); auditTargetIds.push(retryOrder.id);
  const retryPayResponse = await call(`/orders/${retryOrder.id}/pay`, json({}));
  const retryPay = await retryPayResponse.json() as { id: string };
  paymentIds.push(retryPay.id);
  const retryVerify = await call(`/payments/${retryPay.id}/verify`, json({}));
  assert.equal(retryVerify.status, 200);
  const retryQueueResponse = await call(`/orders/${retryOrder.id}/queue`, json({ printerId: printer.id }, ownerAuth));
  assert.equal(retryQueueResponse.status, 202);
  const retryQueued = await retryQueueResponse.json() as { job: { id: string } };
  jobIds.push(retryQueued.job.id); auditTargetIds.push(retryQueued.job.id);
  const claimedRetry = await claimOne();
  assert.equal(claimedRetry.id, retryQueued.job.id);
  const retryLeaseHeaders = { authorization: `Bearer ${claimedRetry.agentToken}`, 'x-job-lease': claimedRetry.leaseToken };
  assert.equal((await call(`/agent/jobs/${retryQueued.job.id}/document`, { headers: retryLeaseHeaders })).status, 200);
  const safeFailure = await call(`/agent/jobs/${retryQueued.job.id}/status`, json({ eventKey: `${tag}-failed-event`, status: 'FAILED', leaseToken: claimedRetry.leaseToken, error: 'simulated test failure' }, retryLeaseHeaders.authorization));
  assert.equal(safeFailure.status, 200);
  const requeue = await call(`/shops/${shop.id}/jobs/${retryQueued.job.id}/reconcile`, json({ decision: 'retry' }, ownerAuth));
  assert.equal(requeue.status, 202, 'safely failed job may be retried within its attempt limit');
  await db.printJob.update({ where: { id: retryQueued.job.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  const reclaimed = await claimOne();
  assert.equal(reclaimed.id, retryQueued.job.id);
  assert.equal(reclaimed.attempt, 2, 'retry increments the persistent attempt count');
  await db.printJob.update({ where: { id: retryQueued.job.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
  const safeLeaseReclaim = await claimOne();
  assert.equal(safeLeaseReclaim.id, retryQueued.job.id);
  assert.equal(safeLeaseReclaim.attempt, 3, 'an expired pre-submission lease is safely requeued and counted');
  const finalLeaseHeaders = { authorization: `Bearer ${safeLeaseReclaim.agentToken}`, 'x-job-lease': safeLeaseReclaim.leaseToken };
  assert.equal((await call(`/agent/jobs/${retryQueued.job.id}/document`, { headers: finalLeaseHeaders })).status, 200);
  assert.equal((await call(`/agent/jobs/${retryQueued.job.id}/status`, json({ eventKey: `${tag}-final-submit`, status: 'SUBMITTING', leaseToken: safeLeaseReclaim.leaseToken }, finalLeaseHeaders.authorization))).status, 200);
  const simulatedResult = await call(`/agent/jobs/${retryQueued.job.id}/status`, json({ eventKey: `${tag}-simulated-done`, status: 'SIMULATED_COMPLETE', leaseToken: safeLeaseReclaim.leaseToken }, finalLeaseHeaders.authorization));
  assert.equal(simulatedResult.status, 200);
  const simulatedBody = await simulatedResult.json() as { physicalStatus: string; physicalPrintConfirmed: boolean };
  assert.equal(simulatedBody.physicalStatus, 'SIMULATED_ONLY');
  assert.equal(simulatedBody.physicalPrintConfirmed, false, 'simulated completion never claims physical output');

  const customerHistory=await call('/customer/orders',{headers:{authorization:customerAuth}});
  assert.equal(customerHistory.status,200);
  const customerOrders=await customerHistory.json() as Array<{id:string;doubleSided:boolean;payment:{status:string;manualPayment:{accountName:string}|null}|null;printJob:{status:string;physicalStatus:string}|null}>;
  assert.deepEqual(new Set(customerOrders.map(o=>o.id)),new Set(orderIds),'customers see only their own orders');
  assert.equal(customerOrders.find(o=>o.id===order.id)?.payment?.status,'VERIFIED');
  assert.equal(customerOrders.find(o=>o.id===order.id)?.doubleSided,true);
  assert.equal(customerOrders.find(o=>o.id===order.id)?.printJob?.physicalStatus,'UNKNOWN','customer history separates physical outcome');
  const metrics=await call('/admin/metrics',{headers:{authorization:adminAuth}});
  assert.equal(metrics.status,200);
  const metricData=await metrics.json() as {developmentOnly:boolean;commissionBasisPoints:number;estimatedCommission:string};
  assert.equal(metricData.developmentOnly,true);
  assert.equal(metricData.commissionBasisPoints,0);
  assert.equal(metricData.estimatedCommission,'0.00');
  try{
    const initialPaymentSettings=await call(`/shops/${shop.id}/payment-settings`,{headers:{authorization:ownerAuth}});
    assert.equal(initialPaymentSettings.status,200);
    assert.equal((await initialPaymentSettings.json() as {enabled:boolean}).enabled,false,'manual payment is disabled by default for each shop');
    assert.equal((await call(`/shops/${shop.id}/payment-settings`,{headers:{authorization:otherOwnerAuth}})).status,404,'another owner cannot read payment details');
    assert.equal((await call(`/shops/${otherShop.id}/payment-settings`,{...json({enabled:true,provider:'Other bank',accountName:'Other owner',accountNumber:'999',instructions:''},ownerAuth),method:'PUT'})).status,404,'an owner cannot write another shop payment details');
    assert.equal((await call(`/shops/${shop.id}/payment-settings`,{...json({enabled:true,provider:'',accountName:'',accountNumber:'',instructions:''},ownerAuth),method:'PUT'})).status,400,'manual payment cannot be enabled without account details');
    assert.equal((await call('/admin/manual-payment-settings',{headers:{authorization:adminAuth}})).status,404,'platform-wide payment settings are no longer exposed');
    const configureManual=await call(`/shops/${shop.id}/payment-settings`,{...json({enabled:true,provider:'Test bank',accountName:'QR Print Test',accountNumber:'123456789',instructions:'Use the order number as the transfer note.'},ownerAuth),method:'PUT'});
    assert.equal(configureManual.status,200);
    const publicPaymentMethod=await call(`/shops/${shop.slug}/payment-method`);
    assert.equal(publicPaymentMethod.status,200);
    assert.deepEqual(await publicPaymentMethod.json(),{enabled:true,provider:'Test bank',accountName:'QR Print Test',accountNumber:'123456789',instructions:'Use the order number as the transfer note.'});
    for(const token of agentTokens){
      const refreshed=await call('/agent/heartbeat',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({})});
      assert.equal(refreshed.status,200,'an enrolled agent heartbeat refreshes the online window before checkout');
    }
    const oneStepCheckout=await call('/orders',json({shopId:shop.id,documentId:document.id,copies:1,paperSize:'A4',color:true,idempotencyKey:`${tag}-claim-at-checkout`,manualTransferSent:true,transferReference:'TXN-CHECKOUT'}));
    assert.equal(oneStepCheckout.status,201);
    const claimedOrder=await oneStepCheckout.json() as {id:string;printJob:{id:string;status:string;printerId:string}|null};
    orderIds.push(claimedOrder.id);auditTargetIds.push(claimedOrder.id);
    assert.ok(claimedOrder.printJob,'customer checkout immediately creates a printer job without owner confirmation');
    assert.equal(claimedOrder.printJob?.status,'QUEUED');
    assert.equal(claimedOrder.printJob?.printerId,printer.id);
    if(claimedOrder.printJob)jobIds.push(claimedOrder.printJob.id);
    await db.printJob.update({where:{id:claimedOrder.printJob!.id},data:{printerId:stalePrinter.id}});
    const claimedCheckoutJob=await claimOne();
    assert.equal(claimedCheckoutJob.id,claimedOrder.printJob?.id,'agent claims the auto-queued customer-attested order');
    assert.equal((await db.printJob.findUniqueOrThrow({where:{id:claimedOrder.printJob!.id}})).printerId,printer.id,'agent safely reassigns an orphaned same-shop printer ID during claim');
    const claimedPayment=await db.payment.findUniqueOrThrow({where:{orderId:claimedOrder.id}});
    paymentIds.push(claimedPayment.id);
    assert.equal(claimedPayment.status,'CUSTOMER_ATTESTED','checkout records that the customer claims to have sent payment; no owner verification is required');
    assert.equal(claimedPayment.customerReference,'TXN-CHECKOUT');
    const ownerOrderList=await call(`/shops/${shop.id}/orders`,{headers:{authorization:ownerAuth}});
    assert.equal(ownerOrderList.status,200);
    const claimedForOwner=(await ownerOrderList.json() as Array<{id:string;payment:{status:string}|null;printJob:{id:string;status:string}|null}>).find(item=>item.id===claimedOrder.id);
    assert.equal(claimedForOwner?.payment?.status,'CUSTOMER_ATTESTED');
    assert.equal(claimedForOwner?.printJob?.status,'LEASED','owner panel shows the agent has claimed the job without a verification action');
    const manualOrderResponse=await call('/orders',json({shopId:shop.id,documentId:document.id,copies:1,paperSize:'A4',color:true,idempotencyKey:`${tag}-manual-order`}));
    assert.equal(manualOrderResponse.status,201);
    const manualOrder=await manualOrderResponse.json() as {id:string};
    orderIds.push(manualOrder.id);auditTargetIds.push(manualOrder.id);
    const manualPayResponse=await call(`/orders/${manualOrder.id}/pay`,json({}));
    assert.equal(manualPayResponse.status,200);
    const manualPay=await manualPayResponse.json() as {id:string;status:string;provider:string;manualPayment:{provider:string;accountName:string;accountNumber:string}};
    paymentIds.push(manualPay.id);
    assert.equal(manualPay.provider,'manual-transfer');
    assert.equal(manualPay.status,'PENDING');
    assert.equal(manualPay.manualPayment.accountNumber,'123456789');
    const manualHistory=await call('/customer/orders',{headers:{authorization:customerAuth}});
    assert.equal(manualHistory.status,200);
    const manualOrderView=(await manualHistory.json() as Array<{id:string;payment:{manualPayment:{accountName:string}|null}|null}>).find(item=>item.id===manualOrder.id);
    assert.equal(manualOrderView?.payment?.manualPayment?.accountName,'QR Print Test','pending transfer instructions remain available in customer order history');
    assert.equal((await call(`/payments/${manualPay.id}/verify`,json({}))).status,400,'customer verification cannot auto-approve a manual transfer');
    const submitted=await call(`/payments/${manualPay.id}/submit`,json({reference:'TXN-445566'}));
    assert.equal(submitted.status,200);
    const submittedBody=await submitted.json() as {payment:{status:string};job:{id:string;status:string}};
    assert.equal(submittedBody.payment.status,'CUSTOMER_ATTESTED');
    assert.equal(submittedBody.job.status,'QUEUED','marking the transfer as sent queues the printer job without owner verification');
    jobIds.push(submittedBody.job.id);
    assert.equal((await call(`/payments/${manualPay.id}/submit`,json({reference:'TXN-445566'}))).status,200,'repeated customer submission is idempotent');
    assert.equal((await call(`/payments/${manualPay.id}/approve`,json({},ownerAuth))).status,404,'there is no owner transfer-verification endpoint');
  }finally{
    await db.shop.update({where:{id:shop.id},data:{manualPaymentEnabled:false,manualPaymentProvider:null,manualPaymentAccountName:null,manualPaymentAccountNumber:null,manualPaymentInstructions:null}});
  }
  const priorPlatformSetting=await db.platformSetting.findUnique({where:{id:'platform'}});
  try{
    const updateCommission=await call('/admin/platform-settings',{method:'PUT',headers:{authorization:adminAuth,'content-type':'application/json'},body:JSON.stringify({commissionBasisPoints:375})});
    assert.equal(updateCommission.status,200);
    const changedSetting=await call('/admin/platform-settings',{headers:{authorization:adminAuth}});
    assert.equal((await changedSetting.json() as {commissionBasisPoints:number}).commissionBasisPoints,375);
  }finally{
    if(priorPlatformSetting)await db.platformSetting.upsert({where:{id:'platform'},create:priorPlatformSetting,update:{commissionBasisPoints:priorPlatformSetting.commissionBasisPoints}});
    else await db.platformSetting.deleteMany({where:{id:'platform'}});
  }
  const deactivated=await call(`/admin/shops/${shop.id}/active`,{method:'PUT',headers:{authorization:adminAuth,'content-type':'application/json'},body:JSON.stringify({isActive:false})});
  assert.equal(deactivated.status,200);
  assert.equal((await call(`/shops/${shop.slug}`)).status,404,'deactivated shop is no longer publicly listed');
  const reactivated=await call(`/admin/shops/${shop.id}/active`,{method:'PUT',headers:{authorization:adminAuth,'content-type':'application/json'},body:JSON.stringify({isActive:true})});
  assert.equal(reactivated.status,200);

  // Verify the second shop remains isolated from the fixture order set.
  const ownerOrders = await call(`/shops/${shop.id}/orders`, { headers: { authorization: ownerAuth } });
  assert.equal(ownerOrders.status, 200);
  const visible = await ownerOrders.json() as Array<{ id: string }>;
  assert.deepEqual(new Set(visible.map(x => x.id)), new Set(orderIds));
  const otherOrders = await call(`/shops/${otherShop.id}/orders`, { headers: { authorization: otherOwnerAuth } });
  assert.equal(otherOrders.status, 200);
  assert.equal((await otherOrders.json() as unknown[]).length, 0);
  const crossShopRevoke=await call(`/shops/${otherShop.id}/agents/${contender.id}/revoke`,json({},otherOwnerAuth));
  assert.equal(crossShopRevoke.status,404,'an owner cannot revoke another shop agent');
  const revoked=await call(`/shops/${shop.id}/agents/${contender.id}/revoke`,json({},ownerAuth));
  assert.equal(revoked.status,200);
  const revokedHeartbeat=await call('/agent/heartbeat',{...json({},`Bearer ${contenderToken}`)});
  assert.equal(revokedHeartbeat.status,401,'rotating the stored credential revokes the previous one-time secret');
  const pausedOwner=await call(`/admin/accounts/${owner.id}/active`,{method:'PUT',headers:{authorization:adminAuth,'content-type':'application/json'},body:JSON.stringify({isActive:false})});
  assert.equal(pausedOwner.status,200);
  assert.equal((await call(`/shops/${shop.id}/orders`,{headers:{authorization:ownerAuth}})).status,401,'paused accounts cannot reuse previously issued owner tokens');
  const resumedOwner=await call(`/admin/accounts/${owner.id}/active`,{method:'PUT',headers:{authorization:adminAuth,'content-type':'application/json'},body:JSON.stringify({isActive:true})});
  assert.equal(resumedOwner.status,200);

  const enrollment=await call(`/shops/${shop.id}/agents`,json({name:`${tag} re-enrolled agent`,printerId:printer.id,mode:'SIMULATED'},ownerAuth));
  assert.equal(enrollment.status,201,'an owner can enroll an agent after selecting a registered printer');
  const enrolled=await enrollment.json() as {id:string;name:string;shopId:string;printerId:string;mode:string;credential:string;printer:{id:string;name:string;queueName:string|null}};
  assert.equal(enrolled.name,`${tag} re-enrolled agent`);
  assert.equal(enrolled.shopId,shop.id);
  assert.equal(enrolled.printerId,printer.id);
  assert.equal(enrolled.mode,'SIMULATED');
  assert.ok(enrolled.credential.startsWith('qpa_'),'the one-time agent credential is returned');
  assert.deepEqual(enrolled.printer,{id:printer.id,name:printer.name,queueName:printer.queueName,status:printer.status,capabilities:printer.capabilities});
  const enrolledDevice=await db.agentDevice.findUniqueOrThrow({where:{id:enrolled.id},select:{userId:true}});
  agentIds.push(enrolled.id);
  userIds.push(enrolledDevice.userId);
  auditTargetIds.push(enrolled.id);
  const enrolledHeartbeat=await call('/agent/heartbeat',json({ping:true},enrolled.credential));
  assert.equal(enrolledHeartbeat.status,200,'the newly returned credential authenticates for the enrolled shop');
  const reEnrollmentRevokedHeartbeat=await call('/agent/heartbeat',json({ping:true},agentToken));
  assert.equal(reEnrollmentRevokedHeartbeat.status,401,'re-enrollment disables previous shop agent credentials');
  const enrolledAgents=await call(`/shops/${shop.id}/agents`,{headers:{authorization:ownerAuth}});
  assert.equal(enrolledAgents.status,200);
  const enrolledAgentList=await enrolledAgents.json() as Array<{id:string;printer:{id:string;queueName:string|null}|null}>;
  assert.deepEqual(enrolledAgentList.find(agent=>agent.id===enrolled.id)?.printer,{id:printer.id,queueName:printer.queueName});
  const enrollmentQr=await call(`/shops/${shop.slug}/qr.png`);
  assert.equal(enrollmentQr.status,200,'the setup flow can continue to QR generation after successful enrollment');
  assert.match(enrollmentQr.headers.get('content-type')??'',/image\/png/);
});
