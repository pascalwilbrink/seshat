import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { TEST_ADMIN_ENV } from './test/fixtures/admin.ts';

// Spec files are excluded from tsconfig.json, so enable legacy (TypeScript-style) decorators here.
// No decorator metadata is emitted: always use explicit @Inject(token).
const shared = {
  // Tests run against the shared domain source, so they do not depend on a prior package build.
  resolve: { alias: { '@seshat/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)) } },
  oxc: { decorator: { legacy: true } },
  test: {
    // Safe test-only admin credentials so config loading works without a .env file.
    env: { ...TEST_ADMIN_ENV },
  },
};

export default defineConfig({
  test: {
    // CI sets INTEGRATION_RESULTS_FILE so scripts/verify-integration-results.mjs can prove the suites ran.
    ...(process.env.INTEGRATION_RESULTS_FILE
      ? { reporters: ['default', 'json'], outputFile: { json: process.env.INTEGRATION_RESULTS_FILE } }
      : {}),
    globalSetup: ['./test/global-setup.ts'],
    projects: [
      {
        ...shared,
        test: {
          ...shared.test,
          name: 'unit',
          include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
          exclude: ['**/node_modules/**', 'test/**/*.integration.spec.ts', 'src/**/*.integration.spec.ts'],
        },
      },
      {
        ...shared,
        test: {
          ...shared.test,
          name: 'integration',
          include: ['src/**/*.integration.spec.ts', 'test/**/*.integration.spec.ts'],
          // Integration suites share one dedicated database, and some drop/recreate the
          // database-scoped `vector` extension, so their files must not run in parallel.
          fileParallelism: false,
        },
      },
    ],
  },
});
