import path from 'node:path';
import { config } from 'dotenv';
import { assertMongoDatabaseTarget } from './mongodb-target.mjs';

const workspace = process.cwd();
config({ path: path.resolve(workspace, '../../.env') });
config({ path: path.resolve(workspace, '.env') });

const value = process.env.MONGODB_URI;
const database = assertMongoDatabaseTarget(value, 'qr_print');
const url = new URL(value);
console.log(`MONGODB_URI: verified database=${database}; host=${url.hostname}`);
