import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { bootHealthApp } from './helpers/health-app.js';
import {
  TEST_DATABASE_URL,
  assertDisposableDatabase,
  createIsolatedSchema,
  describeIntegration,
  type IsolatedSchema,
} from './helpers/integration.js';

describeIntegration('GET /api/health (real PostgreSQL)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let app: Awaited<ReturnType<typeof bootHealthApp>>;

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    // A data source owned by this suite only: losing its connection cannot affect other suites.
    ds = iso.createDataSource();
    await ds.initialize();
    app = await bootHealthApp(ds);
  });

  afterAll(async () => {
    await app?.close();
    await iso?.dispose();
  });

  it('reports ok against the live database, then unreachable after the connection is lost', async () => {
    const healthy = await app.get();
    expect(healthy.status).toBe(200);
    expect(healthy.json).toEqual({ status: 'ok', db: 'ok' });

    // Simulate loss of the connection after initialization: close this suite's pool.
    await ds.destroy();

    const lost = await app.get();
    expect(lost.status).toBe(503);
    expect(lost.json).toEqual({ status: 'error', db: 'unreachable' });
    const secret = new URL(TEST_DATABASE_URL!);
    expect(lost.text).not.toContain(secret.host);
    expect(lost.text).not.toContain(secret.password || 'no-password');
    expect(app.logs.lines.join('\n')).not.toContain(secret.password || 'no-password');
  });
});
