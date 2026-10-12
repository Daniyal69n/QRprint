import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(workspace, 'dist/vercel-bundle.mjs');

await mkdir(path.dirname(outfile), { recursive: true });

await build({
  entryPoints: [path.join(workspace, 'src/vercel.ts')],
  outfile,
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
