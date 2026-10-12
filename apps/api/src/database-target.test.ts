import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertDatabaseTarget,databaseNameFromUrl} from './database-target.js';

test('database URL parsing extracts the MongoDB database path or dbName',()=>{
  assert.equal(databaseNameFromUrl('mongodb://localhost:27017/qr_print'),'qr_print');
  assert.equal(databaseNameFromUrl('mongodb+srv://localhost/?appName=QRprint&dbName=qr_print'),'qr_print');
  assert.equal(assertDatabaseTarget('mongodb://localhost/qr_print','qr_print'),'qr_print');
});
test('database safety guard rejects the POS database target without connecting',()=>{
  assert.throws(()=>assertDatabaseTarget('mongodb://localhost/elite_pos','qr_print'),/expected database qr_print, configured target is elite_pos/);
});
test('database safety guard rejects absent or malformed targets',()=>{
  assert.throws(()=>assertDatabaseTarget(undefined,'qr_print'),/MONGODB_URI is required/);
  assert.throws(()=>assertDatabaseTarget('not-a-url','qr_print'),/malformed/);
  assert.throws(()=>assertDatabaseTarget('mongodb+srv://localhost/','qr_print'),/Database name is missing/);
});
