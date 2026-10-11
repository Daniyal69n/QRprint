import type { Role } from '@qr-print/shared';
export function canAccessShop(role:Role,userId:string,ownerId:string) { return role==='SUPER_ADMIN' || (role==='SHOP_OWNER' && userId===ownerId); }
export function resolveOrderIdempotency<T extends {id:string;customerId:string}>(existing:T|undefined,requestUserId:string):{kind:'NEW'}|{kind:'REPLAY';order:T}|{kind:'HIDDEN'} {
  if(!existing)return {kind:'NEW'};
  return existing.customerId===requestUserId?{kind:'REPLAY',order:existing}:{kind:'HIDDEN'};
}
export function agentCanReportJob(agentShopId:string,jobShopId:string,jobMode:string,reportedMode:string) { return agentShopId===jobShopId && jobMode===reportedMode; }
