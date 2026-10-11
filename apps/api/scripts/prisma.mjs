import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';

const workspace = process.cwd();
const root = path.resolve(workspace, '../..');
config({ path: path.join(root, '.env') });
config({ path: path.join(workspace, '.env') });
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Refusing Prisma command: DATABASE_URL is not configured.');
let target;
try {
  const parsed = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error();
  target = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
} catch {
  throw new Error('Refusing Prisma command: DATABASE_URL target could not be safely verified.');
}
if (target !== 'qr_print') throw new Error(`Refusing Prisma command: expected database qr_print, configured target is ${target}.`);
const forwarded = process.argv.slice(2);
if (forwarded.some((arg) => ['reset', '--force-reset', '--accept-data-loss'].includes(arg)) || (forwarded[0] === 'db' && forwarded[1] === 'push')) {
  throw new Error('Destructive Prisma commands are disabled by the QR Print wrapper.');
}
if (forwarded[0] === 'migrate' && !['deploy', 'status'].includes(forwarded[1])) {
  throw new Error('Only Prisma migrate deploy/status commands are enabled by the QR Print wrapper.');
}
if (forwarded[0] === 'migrate' && forwarded[1] === 'deploy') {
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const rows = await db.$queryRaw`SELECT current_database() AS name`;
    if (rows[0]?.name !== 'qr_print') throw new Error('Refusing migration: PostgreSQL did not confirm qr_print.');
    console.log('PostgreSQL confirmed qr_print immediately before migration.');
  } finally { await db.$disconnect(); }
}
const cli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
const result = spawnSync(process.execPath, [cli, ...forwarded], { cwd: workspace, env: process.env, stdio: 'inherit' });
process.exit(result.status ?? 1);
