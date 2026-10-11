import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/coverage/**'] },
  ...tseslint.configs.recommended,
  { plugins: { '@next/next': nextPlugin } },
  {
    files: ['apps/web/**/*.{js,jsx,ts,tsx}'],
    rules: nextPlugin.configs.recommended.rules,
  },
);
