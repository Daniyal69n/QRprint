import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(workspace, 'src/vercel.ts')],
  outfile: path.join(workspace, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'bundle',
  external: ['@prisma/client', 'dotenv'],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
