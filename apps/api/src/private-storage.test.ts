import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {privateDocumentKey,privateStoragePath,privateStorageRoot} from './private-storage.js';

test('private PDF paths accept safe nested keys and stay under configured storage root',()=>{
  const root=path.resolve('private-storage-test-root');
  assert.equal(privateStoragePath('sample_123.pdf',root),path.join(root,'sample_123.pdf'));
  assert.equal(privateStoragePath('documents/user_1/id_1.pdf',root),path.join(root,'documents','user_1','id_1.pdf'));
  for(const key of ['../outside.pdf','..\\outside.pdf','C:\\outside.pdf','folder/../file.pdf','folder name/file.pdf'])assert.throws(()=>privateStoragePath(key,root));
});

test('private storage can be mounted at an explicit absolute directory',()=>{
  const configured=path.resolve('qr-print-private-volume');
  assert.equal(privateStorageRoot(configured),configured);
});

test('private upload object keys are bound to validated user and document identifiers',()=>{
  assert.equal(privateDocumentKey('user_1','123e4567-e89b-12d3-a456-426614174000'),'documents/user_1/123e4567-e89b-12d3-a456-426614174000.pdf');
  assert.throws(()=>privateDocumentKey('../other','doc'),/Invalid private document identity/);
});
