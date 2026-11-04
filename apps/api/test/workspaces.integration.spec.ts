import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataSource } from 'typeorm';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { type WorkspaceApp, bootWorkspaceApp } from './helpers/workspace-app.js';
import { defineWorkspaceHttpSuite } from './helpers/workspace-http-suite.js';
import { ScopedTestItem } from './helpers/scoped-test-entity.js';
import {
  TEST_DATABASE_URL,
  assertDisposableDatabase,
  createIsolatedSchema,
  describeIntegration,
  type IsolatedSchema,
} from './helpers/integration.js';

describeIntegration('Workspace API (real PostgreSQL)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  const apps: WorkspaceApp[] = [];
  let failNext: unknown;

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ScopedTestItem]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    const ddl = (await ds.driver.createSchemaBuilder().log()).upQueries.map((q) => q.query);
    const quirk = /^ALTER TABLE "workspaces" ALTER COLUMN "id" (DROP DEFAULT|SET DEFAULT gen_random_uuid\(\))$/;
    for (const s of ddl.filter((q) => !quirk.test(q))) await ds.query(s);
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM scoped_test_items');
    await ds.query('DELETE FROM workspaces');
    failNext = undefined;
  });

  afterAll(async () => {
    for (const a of apps) await a.close();
    vi.unstubAllEnvs();
    await iso?.dispose();
  });

  /** Real transaction, optionally failing after the DELETE ran so the database really rolls back. */
  const dataSource = {
    transaction: (fn: (m: unknown) => Promise<unknown>) =>
      ds.transaction(async (m) => {
        const result = await fn(m);
        if (failNext !== undefined) throw failNext;
        return result;
      }),
  };

  defineWorkspaceHttpSuite({
    async boot(opts) {
      const app = await bootWorkspaceApp({ repo: ds.getRepository(Workspace), dataSource, authorization: opts?.authorization });
      apps.push(app);
      return {
        app,
        failDelete: (e) => void (failNext = e),
        countRows: async () => Number(((await ds.query('SELECT count(*) AS n FROM workspaces')) as { n: string }[])[0]!.n),
      };
    },
  });

  it('keeps the row and emits nothing when the delete is rolled back, and refuses deleting a Workspace with data (409)', async () => {
    const app = await bootWorkspaceApp({ repo: ds.getRepository(Workspace), dataSource });
    apps.push(app);
    const events: unknown[] = [];
    app.events.on('workspace.deleted', (e) => events.push(e));
    const ws = (await app.request('POST', '/api/global/workspaces', { name: 'Has Data' })).json;
    await ds.query(`INSERT INTO scoped_test_items (scope, workspace_id, label) VALUES ('workspace', $1, 'x')`, [ws.id]);
    const r = await app.request('DELETE', `/api/workspaces/${ws.id}`, { slug: 'has-data' });
    expect(r.status).toBe(409);
    expect(r.text).not.toMatch(/scoped_test_items|violates|constraint/i);
    expect(events).toEqual([]);
    expect(await ds.query('SELECT 1 FROM workspaces WHERE id = $1', [ws.id])).toHaveLength(1);
  });
});
