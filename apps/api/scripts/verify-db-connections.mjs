import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(workspace, '../..');
config({ path: path.join(root, '.env') });
config({ path: path.join(workspace, '.env') });

for (const [variable, expected] of [['DATABASE_URL', 'qr_print'], ['TEST_DATABASE_URL', 'qr_print_test']]) {
  const value = process.env[variable];
  if (!value) throw new Error(`${variable} is missing; refusing connection verification.`);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${variable} cannot be parsed safely.`); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || decodeURIComponent(parsed.pathname.replace(/^\//, '')) !== expected) {
    throw new Error(`${variable} must target ${expected}; refusing to connect.`);
  }
  const db = new PrismaClient({ datasources: { db: { url: value } } });
  try {
    const rows = await db.$queryRaw`SELECT current_database() AS name`;
    if (rows[0]?.name !== expected) throw new Error(`${variable}: PostgreSQL reported an unexpected database; refusing to continue.`);
    console.log(`${variable}: PostgreSQL confirmed ${expected}`);
  } finally {
    await db.$disconnect();
  }
}
