import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const workspace = process.cwd();
async function findUnitTests(dir) {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) files.push(...await findUnitTests(full));
    else if (item.isFile() && item.name.endsWith('.test.ts') && !item.name.endsWith('.integration.test.ts')) files.push(full);
  }
  return files;
}
const files = await findUnitTests(path.join(workspace, 'src'));
if (!files.length) {
  console.log('No unit tests are registered.');
  process.exit(0);
}
const root = path.resolve(workspace, '../..');
const cli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const result = spawnSync(process.execPath, [cli, '--test', ...files], { cwd: workspace, env: process.env, stdio: 'inherit' });
process.exit(result.status ?? 1);
