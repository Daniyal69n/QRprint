import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {privateStoragePath,privateStorageRoot} from './private-storage.js';

test('private PDF paths accept only generated basename keys and stay under configured storage root',()=>{
  const root=path.resolve('private-storage-test-root');
  assert.equal(privateStoragePath('sample_123.pdf',root),path.join(root,'sample_123.pdf'));
  for(const key of ['../outside.pdf','..\\outside.pdf','C:\\outside.pdf','folder/file.pdf'])assert.throws(()=>privateStoragePath(key,root));
});

test('private storage can be mounted at an explicit absolute directory',()=>{
  const configured=path.resolve('qr-print-private-volume');
  assert.equal(privateStorageRoot(configured),configured);
});
