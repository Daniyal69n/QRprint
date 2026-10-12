import path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { assertMongoDatabaseTarget } from './mongodb-target.mjs';

const workspace = process.cwd();
const root = path.resolve(workspace, '../..');
config({ path: path.join(root, '.env') });
config({ path: path.join(workspace, '.env') });

for (const [variable, expected] of [['MONGODB_URI', 'qr_print'], ['TEST_MONGODB_URI', 'qr_print_test']]) {
  const uri = process.env[variable];
  assertMongoDatabaseTarget(uri, expected);
  const db = new PrismaClient({ datasources: { db: { url: uri } } });
  try {
    const result = await db.$runCommandRaw({ ping: 1 });
    if (Number(result.ok) !== 1) throw new Error(`${variable}: MongoDB did not confirm a successful ping.`);
    console.log(`${variable}: MongoDB confirmed ${expected}`);
  } finally {
    await db.$disconnect();
  }
}
