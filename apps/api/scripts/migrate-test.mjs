import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';

const workspace = process.cwd();
const root = path.resolve(workspace, '../..');
config({ path: path.join(root, '.env') });
config({ path: path.join(workspace, '.env') });
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('Refusing test migration: TEST_DATABASE_URL is not configured.');
let target;
try {
  const parsed = new URL(testUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error();
  target = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
} catch {
  throw new Error('Refusing test migration: TEST_DATABASE_URL cannot be safely verified.');
}
if (target !== 'qr_print_test') throw new Error(`Refusing test migration: expected qr_print_test, configured target is ${target}.`);

// This wrapper intentionally exposes only the additive deploy operation.
process.env.DATABASE_URL = testUrl;
const db = new PrismaClient();
let actual;
try {
  const rows = await db.$queryRaw`SELECT current_database() AS name`;
  actual = rows[0]?.name;
} finally {
  await db.$disconnect();
}
if (actual !== 'qr_print_test') {
  throw new Error(`Refusing test migration: PostgreSQL reported ${actual || 'an unknown database'}.`);
}

const cli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], {
  cwd: workspace,
  env: { ...process.env, DATABASE_URL: testUrl },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
