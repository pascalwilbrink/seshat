import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Vitest global setup: makes skipped integration tests visible in the run output. */
export default function setup(): () => void {
  // AppModule needs a writable FILE_STORAGE_DIR; workers inherit this variable.
  const storageDir = mkdtempSync(join(tmpdir(), 'seshat-test-files-'));
  process.env.FILE_STORAGE_DIR = storageDir;

  if (!process.env.TEST_DATABASE_URL) {
    if (process.env.REQUIRE_INTEGRATION_TESTS === 'true') {
      const message =
        '[integration] REQUIRE_INTEGRATION_TESTS=true but TEST_DATABASE_URL is not set: ' +
        'integration tests must run, not be skipped.';
      // Vitest 5 cannot print errors thrown from globalSetup, so state the reason first.
      console.error(`\n${message}\n`);
      throw new Error(message);
    }
    console.warn(
      '\n[integration] TEST_DATABASE_URL is not set: database integration tests are SKIPPED.\n' +
        '[integration] Set it to a disposable, dedicated test database (see apps/api/.env.example) to run them.\n',
    );
  } else {
    console.warn('\n[integration] TEST_DATABASE_URL is set: running database integration tests.\n');
  }
  return () => rmSync(storageDir, { recursive: true, force: true });
}
