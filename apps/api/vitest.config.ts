import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Spec files are excluded from tsconfig.json, so enable legacy (TypeScript-style) decorators here.
  // No decorator metadata is emitted: always use explicit @Inject(token).
  oxc: { decorator: { legacy: true } },
});
