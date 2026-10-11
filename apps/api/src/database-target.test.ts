import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertDatabaseTarget,databaseNameFromUrl} from './database-target.js';

test('database URL parsing extracts only the PostgreSQL database path',()=>{
  assert.equal(databaseNameFromUrl('postgresql://localhost:5433/qr_print?schema=public'),'qr_print');
  assert.equal(assertDatabaseTarget('postgres://localhost/qr_print','qr_print'),'qr_print');
});
test('database safety guard rejects the POS database target without connecting',()=>{
  assert.throws(()=>assertDatabaseTarget('postgresql://localhost/elite_pos','qr_print'),/expected database qr_print, configured target is elite_pos/);
});
test('database safety guard rejects absent or malformed targets',()=>{
  assert.throws(()=>assertDatabaseTarget(undefined,'qr_print'),/DATABASE_URL is required/);
  assert.throws(()=>assertDatabaseTarget('not-a-url','qr_print'),/malformed/);
});
