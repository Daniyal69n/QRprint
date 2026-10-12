import path from 'node:path';
import { config } from 'dotenv';
import { assertMongoDatabaseTarget } from './mongodb-target.mjs';

const workspace = process.cwd();
config({ path: path.resolve(workspace, '../../.env') });
config({ path: path.resolve(workspace, '.env') });

for (const [variable, expected] of [['MONGODB_URI', 'qr_print'], ['TEST_MONGODB_URI', 'qr_print_test']]) {
  const value = process.env[variable];
  const database = assertMongoDatabaseTarget(value, expected);
  const url = new URL(value);
  console.log(`${variable}: verified database=${database}; host=${url.hostname}`);
}
