import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { assertMongoDatabaseTarget } from './mongodb-target.mjs';

const workspace = process.cwd();
const root = path.resolve(workspace, '../..');
config({ path: path.join(root, '.env') });
config({ path: path.join(workspace, '.env') });
const uri = process.env.MONGODB_URI;
assertMongoDatabaseTarget(uri, 'qr_print');
const args = process.argv.slice(2);
const generate = args[0] === 'generate';
const push = args[0] === 'db' && args[1] === 'push';
if ((!generate && !push) || args.some((arg) => ['--force-reset', '--accept-data-loss'].includes(arg))) {
  throw new Error('Only Prisma generate and db push are enabled for MongoDB; destructive options are disabled.');
}

if (push) {
  const db = new PrismaClient({ datasources: { db: { url: uri } } });
  try {
    const result = await db.$runCommandRaw({ ping: 1 });
    if (Number(result.ok) !== 1) throw new Error('MongoDB did not confirm a successful ping.');
    console.log('MongoDB confirmed qr_print immediately before schema synchronization.');
  } finally {
    await db.$disconnect();
  }
}

const cli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
const result = spawnSync(process.execPath, [cli, ...args], { cwd: workspace, env: process.env, stdio: 'inherit' });
process.exit(result.status ?? 1);
