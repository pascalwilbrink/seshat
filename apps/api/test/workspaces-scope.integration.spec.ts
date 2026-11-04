import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { ScopedTestItem } from './helpers/scoped-test-entity.js';
import { scopeColumns, workspaceScope, globalScope } from '../src/scopes/scope-ref.js';
import {
  TEST_DATABASE_URL,
  assertDisposableDatabase,
  createIsolatedSchema,
  describeIntegration,
  type IsolatedSchema,
} from './helpers/integration.js';

describeIntegration('Workspace storage and scoped entities (real PostgreSQL)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let testDs: DataSource;

  const rejects = async (p: Promise<unknown>, code: string, constraint?: string) => {
    const err = (await p.then(
      () => undefined,
      (e: unknown) => e,
    )) as { driverError?: { code?: string; constraint?: string } } | undefined;
    expect(err, 'expected the statement to be rejected').toBeDefined();
    expect(err?.driverError?.code).toBe(code);
    if (constraint) expect(err?.driverError?.constraint).toBe(constraint);
  };

  const insertWorkspace = (name: string, slug: string) =>
    ds.query('INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id', [name, slug]) as Promise<
      { id: string }[]
    >;

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });

    // Test-only DDL derived from the adopting entity's metadata (not synchronize): the migrated
    // `workspaces` table must already match its entity, so only the test table is missing.
    testDs = iso.createDataSource([Workspace, ScopedTestItem]);
    await testDs.initialize();
    const sql = await testDs.driver.createSchemaBuilder().log();
    const statements = sql.upQueries.map((q) => q.query);
    // TypeORM always re-reports a function default on a PK (`gen_random_uuid()`) as a change; it is the only
    // tolerated difference. Any other drift between the migration and the Workspace entity fails here.
    const quirk = /^ALTER TABLE "workspaces" ALTER COLUMN "id" (DROP DEFAULT|SET DEFAULT gen_random_uuid\(\))$/;
    const testTableDdl = statements.filter((s) => !quirk.test(s));
    expect(testTableDdl.length).toBeGreaterThan(0);
    for (const s of testTableDdl) expect(s).toContain('scoped_test_items');
    for (const s of testTableDdl) await testDs.query(s);
  });

  afterAll(async () => {
    if (testDs?.isInitialized) await testDs.destroy();
    await iso?.dispose();
  });

  describe('workspaces table', () => {
    it('stores uuid id, timestamps and a nullable description by default', async () => {
      const [{ id }] = await insertWorkspace('Graphnous', 'graphnous');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const [row] = await iso.query(`SELECT * FROM "${iso.schema}".workspaces WHERE id = '${id}'`);
      expect(row.description).toBeNull();
      expect(row.created_at).toBeInstanceOf(Date);
      expect(row.updated_at).toBeInstanceOf(Date);
    });

    it('enforces unique slugs', async () => {
      await insertWorkspace('One', 'dup');
      await rejects(insertWorkspace('Two', 'dup'), '23505', 'UQ_workspaces_slug');
    });

    it('refuses the reserved slug and invalid formats', async () => {
      for (const slug of ['global', 'Upper', 'has space', '-lead', 'trail-', 'dou--ble', 'under_score', '']) {
        await rejects(insertWorkspace('X', slug), '23514', 'CK_workspaces_slug_format');
      }
      // "global" only as a whole slug is reserved
      await expect(insertWorkspace('G', 'global-2')).resolves.toHaveLength(1);
    });

    it('bounds the name to 1-100 characters', async () => {
      await rejects(insertWorkspace('', 'empty-name'), '23514', 'CK_workspaces_name_length');
      await rejects(insertWorkspace('x'.repeat(101), 'long-name'), '22001');
      await expect(insertWorkspace('x'.repeat(100), 'max-name')).resolves.toHaveLength(1);
    });

    it('has no Global row', async () => {
      const rows = await iso.query(`SELECT 1 FROM "${iso.schema}".workspaces WHERE slug = 'global' OR name ILIKE 'global'`);
      expect(rows).toEqual([]);
    });
  });

  describe('scoped adopter (ScopedTestItem)', () => {
    const repo = () => testDs.getRepository(ScopedTestItem);
    const insert = (scope: string, workspaceId: string | null) =>
      testDs.query('INSERT INTO scoped_test_items (scope, workspace_id, label) VALUES ($1, $2, $3)', [
        scope,
        workspaceId,
        'x',
      ]);

    it('accepts global with null and workspace with an existing id', async () => {
      const [{ id }] = await insertWorkspace('Scoped', 'scoped-ok');
      await repo().insert({ label: 'g', ...scopeColumns(globalScope()) });
      await repo().insert({ label: 'w', ...scopeColumns(workspaceScope(id)) });
      expect(await repo().count()).toBeGreaterThanOrEqual(2);
    });

    it('rejects global with a workspace id', async () => {
      const [{ id }] = await insertWorkspace('Bad1', 'bad-1');
      await rejects(insert('global', id), '23514');
    });

    it('rejects workspace with a null workspace id', async () => {
      await rejects(insert('workspace', null), '23514');
    });

    it('rejects an invalid scope value', async () => {
      const [{ id }] = await insertWorkspace('Bad2', 'bad-2');
      await rejects(insert('team', null), '23514');
      await rejects(insert('team', id), '23514');
    });

    it('rejects a nonexistent Workspace (FK)', async () => {
      await rejects(insert('workspace', '3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'), '23503');
    });

    it('restricts deleting a Workspace that still has scoped rows', async () => {
      const [{ id }] = await insertWorkspace('Held', 'held');
      await insert('workspace', id);
      await rejects(ds.query('DELETE FROM workspaces WHERE id = $1', [id]), '23503');
    });

    it('has the exact FK, check and index in the database', async () => {
      const fks = await iso.query(`
        SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype = 'f' AND t.relname = 'scoped_test_items' AND n.nspname = '${iso.schema}'`);
      expect(fks).toHaveLength(1);
      expect(String(fks[0].def)).toMatch(/FOREIGN KEY \(workspace_id\) REFERENCES .*workspaces\(id\) ON UPDATE RESTRICT ON DELETE RESTRICT/);

      const checks = await iso.query(`
        SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype = 'c' AND t.relname = 'scoped_test_items' AND n.nspname = '${iso.schema}'`);
      expect(checks).toHaveLength(1);
      const def = String(checks[0].def).replace(/[\s()]+/g, '').replace(/::[a-z]+/g, '');
      expect(def).toBe(
        "CHECKscope='global'ANDworkspace_idISNULLORscope='workspace'ANDworkspace_idISNOTNULL",
      );

      const idx = await iso.query(`
        SELECT a.attname AS col, k.ord FROM pg_index i
        JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        WHERE t.relname = 'scoped_test_items' AND n.nspname = '${iso.schema}' AND NOT i.indisprimary
        ORDER BY i.indexrelid, k.ord`);
      expect(idx.map((r) => r.col)).toEqual(['scope', 'workspace_id']);
    });
  });
});
