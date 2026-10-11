import assert from 'node:assert/strict';
import test from 'node:test';
import {createCorsPolicy} from './cors-policy.js';

test('development CORS stays open when no origins are configured', async()=>{
  const policy=createCorsPolicy({NODE_ENV:'development'});
  const allowed=await new Promise<boolean>((resolve,reject)=>policy.origin('http://localhost:3000',(error,result)=>error?reject(error):resolve(!!result)));
  assert.equal(allowed,true);
  assert.equal(policy.credentials,false);
});

test('production CORS requires and enforces the exact HTTPS frontend origin', async()=>{
  assert.throws(()=>createCorsPolicy({NODE_ENV:'production'}),/CORS_ORIGINS/);
  const policy=createCorsPolicy({NODE_ENV:'production',CORS_ORIGINS:'https://qr-print.vercel.app'});
  const check=(origin:string)=>new Promise<boolean>((resolve,reject)=>policy.origin(origin,(error,result)=>error?reject(error):resolve(!!result)));
  assert.equal(await check('https://qr-print.vercel.app'),true);
  assert.equal(await check('https://qr-print-git-main.vercel.app'),false);
  assert.throws(()=>createCorsPolicy({NODE_ENV:'production',CORS_ORIGINS:'http://qr-print.vercel.app'}),/HTTPS/);
});
