import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shopOwnerRegistrationSchema} from './shop-owner-registration.js';

const validRegistration={
  ownerName:' Shop Owner ',
  email:'  OWNER@EXAMPLE.COM ',
  password:'a-strong-test-password',
  shopName:' Print Shop ',
  slug:'print-shop',
};

test('shop-owner registration normalizes public identity fields',()=>{
  const parsed=shopOwnerRegistrationSchema.parse(validRegistration);
  assert.equal(parsed.ownerName,'Shop Owner');
  assert.equal(parsed.email,'owner@example.com');
  assert.equal(parsed.shopName,'Print Shop');
  assert.equal(parsed.slug,'print-shop');
});

test('shop-owner registration rejects every client-supplied role',()=>{
  assert.throws(()=>shopOwnerRegistrationSchema.parse({...validRegistration,role:'SUPER_ADMIN'}));
});

test('shop-owner registration enforces password and URL slug constraints',()=>{
  assert.throws(()=>shopOwnerRegistrationSchema.parse({...validRegistration,password:'short'}));
  assert.throws(()=>shopOwnerRegistrationSchema.parse({...validRegistration,password:'é'.repeat(40)}));
  assert.throws(()=>shopOwnerRegistrationSchema.parse({...validRegistration,slug:'Invalid Slug'}));
});
