import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { '@seshat/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)), '@': fileURLToPath(new URL('.', import.meta.url)), 'server-only': fileURLToPath(new URL('./test/empty.ts', import.meta.url)) } },
  test: { setupFiles: ['./test/setup.ts'] },
});
