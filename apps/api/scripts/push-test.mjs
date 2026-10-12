import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { assertMongoDatabaseTarget } from './mongodb-target.mjs';

const workspace = process.cwd();
const root = path.resolve(workspace, '../..');
config({ path: path.join(root, '.env') });
config({ path: path.join(workspace, '.env') });
const uri = process.env.TEST_MONGODB_URI;
assertMongoDatabaseTarget(uri, 'qr_print_test');
const db = new PrismaClient({ datasources: { db: { url: uri } } });
try {
  const result = await db.$runCommandRaw({ ping: 1 });
  if (Number(result.ok) !== 1) throw new Error('MongoDB did not confirm a successful ping.');
  console.log('MongoDB confirmed qr_print_test immediately before test schema synchronization.');
} finally {
  await db.$disconnect();
}

const cli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
const result = spawnSync(process.execPath, [cli, 'db', 'push'], {
  cwd: workspace,
  env: { ...process.env, MONGODB_URI: uri },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
