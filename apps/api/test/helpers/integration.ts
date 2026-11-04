import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { describe } from 'vitest';
import { createDataSourceOptions } from '../../src/database/options.js';

/**
 * Integration-test harness. Gated only by TEST_DATABASE_URL, never by DATABASE_URL.
 * Without it the suites are skipped with a visible reason (see test/global-setup.ts).
 */
export const TEST_DATABASE_URL: string | undefined = process.env.TEST_DATABASE_URL || undefined;

export const SKIP_REASON = 'TEST_DATABASE_URL is not set';

/** CI-only: when "true", a missing TEST_DATABASE_URL fails the run instead of skipping integration suites. */
export const INTEGRATION_REQUIRED_MESSAGE =
  'REQUIRE_INTEGRATION_TESTS=true but TEST_DATABASE_URL is not set: integration tests must run, not be skipped';

export function integrationTestsRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REQUIRE_INTEGRATION_TESTS === 'true';
}

/** `describe` that runs only when TEST_DATABASE_URL is set; the skip reason is part of the suite name. */
export function describeIntegration(name: string, fn: () => void): void {
  // Applies to every suite that uses this helper, so a suite can never be skipped silently in CI.
  if (!TEST_DATABASE_URL && integrationTestsRequired()) throw new Error(INTEGRATION_REQUIRED_MESSAGE);
  if (TEST_DATABASE_URL) describe(name, fn);
  else describe.skip(`${name} [skipped: ${SKIP_REASON}]`, fn);
}

/**
 * Database-scoped tests (CREATE/DROP EXTENSION) must never run against shared data, so the
 * test database has to be dedicated: its name must contain "test" and differ from DATABASE_URL.
 */
export function assertDisposableDatabase(url: string, otherUrl = process.env.DATABASE_URL): void {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!/test/i.test(name)) {
    throw new Error(
      'TEST_DATABASE_URL must point to a disposable, dedicated database whose name contains "test"',
    );
  }
  if (otherUrl && otherUrl === url) {
    throw new Error('TEST_DATABASE_URL must not be the same as DATABASE_URL');
  }
}

export interface IsolatedSchema {
  /** Unique schema name, created for this test only. */
  schema: string;
  /** A DataSource with the app's real options (same migrations), scoped to the schema; entities are passed explicitly. Not yet initialized. */
  createDataSource(entities?: Function[]): DataSource;
  /** Runs SQL on a separate plain connection. */
  query(sql: string): Promise<Record<string, unknown>[]>;
  /** Destroys every DataSource created here, drops the schema and closes connections. Safe to call twice. */
  dispose(): Promise<void>;
}

/**
 * Creates a uniquely named schema in the test database. Always call `dispose()` in
 * `afterAll`/`afterEach` (it also works after failures). Extensions created while the
 * schema is on the search_path live in it and vanish with it.
 */
export async function createIsolatedSchema(url = TEST_DATABASE_URL): Promise<IsolatedSchema> {
  if (!url) throw new Error(SKIP_REASON);
  const schema = `it_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const client = new Client({ connectionString: url });
  await client.connect();
  const sources: DataSource[] = [];
  let disposed = false;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
  return {
    schema,
    createDataSource(entities = []) {
      const ds = new DataSource({
        ...createDataSourceOptions({ databaseUrl: url }),
        // Decorated entity files cannot be imported by the file glob under Vitest (no TS transform in a native
        // import()), so tests pass entity classes explicitly (default: none; migrations need no entities).
        entities,
        schema,
        extra: { options: `-c search_path="${schema}"` },
      } as ConstructorParameters<typeof DataSource>[0]);
      sources.push(ds);
      return ds;
    },
    async query(sql) {
      return (await client.query(sql)).rows;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const ds of sources) {
        if (ds.isInitialized) await ds.destroy().catch(() => undefined);
      }
      try {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}
