import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  TEST_DATABASE_URL,
  assertDisposableDatabase,
  createIsolatedSchema,
  describeIntegration,
  type IsolatedSchema,
} from './helpers/integration.js';

describeIntegration('migrations (real PostgreSQL)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;

  const vectorInstalled = async () =>
    (await iso.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'")).length === 1;

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    // The extension is database-scoped: start from a database without it (dedicated test DB only).
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource();
    await ds.initialize();
  });

  afterAll(async () => {
    await iso?.dispose();
  });

  it('discovers the migrations exactly once', () => {
    const names = ds.migrations.map((m) => m.constructor.name);
    expect(names).toEqual([
      'EnableVectorExtension1762300000000',
      'CreateWorkspaces1762400000000',
      'CreateApiKeys1762500000000',
      'CreateFilesCollectionsTags1762600000000',
      'CreateStorageCleanupIntents1762700000000',
      'CreateChunks1762800000000',
    ]);
  });

  it('up: enables vector and creates workspaces and api_keys; a second run applies nothing', async () => {
    expect(await vectorInstalled()).toBe(false);
    const first = await ds.runMigrations({ transaction: 'each' });
    expect(first.map((m) => m.name)).toEqual([
      'EnableVectorExtension1762300000000',
      'CreateWorkspaces1762400000000',
      'CreateApiKeys1762500000000',
      'CreateFilesCollectionsTags1762600000000',
      'CreateStorageCleanupIntents1762700000000',
      'CreateChunks1762800000000',
    ]);
    expect(await vectorInstalled()).toBe(true);

    const second = await ds.runMigrations({ transaction: 'each' });
    expect(second).toEqual([]);
    expect(await vectorInstalled()).toBe(true);
  });

  it('keeps the migrations table in the isolated schema and creates only workspaces and api_keys', async () => {
    const tables = await iso.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = '${iso.schema}' ORDER BY table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual(['api_keys', 'chunks', 'collections', 'file_tags', 'files', 'memories', 'memory_tags', 'migrations', 'storage_cleanup_intents', 'tags', 'workspaces']);
  });

  it('down drops memories, files tables, api_keys, then workspaces, then the extension; re-up succeeds', async () => {
    await ds.undoLastMigration({ transaction: 'each' });
    await ds.undoLastMigration({ transaction: 'each' });
    await ds.undoLastMigration({ transaction: 'each' });
    await ds.undoLastMigration({ transaction: 'each' });
    await ds.undoLastMigration({ transaction: 'each' });
    await ds.undoLastMigration({ transaction: 'each' });
    const tables = await iso.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = '${iso.schema}'`,
    );
    expect(tables.map((t) => t.table_name)).toEqual(['migrations']);
    expect(await vectorInstalled()).toBe(true);

    await ds.undoLastMigration({ transaction: 'each' });
    expect(await vectorInstalled()).toBe(false);

    const again = await ds.runMigrations({ transaction: 'each' });
    expect(again).toHaveLength(7);
    expect(await vectorInstalled()).toBe(true);
  });

  it('the shared options never synchronize', () => {
    expect(ds.options.synchronize).toBe(false);
  });
});

describe('assertDisposableDatabase', () => {
  it('accepts a dedicated test database', () => {
    expect(() => assertDisposableDatabase('postgres://u:p@h:5432/seshat_test', undefined)).not.toThrow();
  });
  it('rejects databases not named for tests and the app database', () => {
    expect(() => assertDisposableDatabase('postgres://u:p@h:5432/seshat', undefined)).toThrow(/disposable/);
    expect(() => assertDisposableDatabase('postgres://u:p@h/x_test', 'postgres://u:p@h/x_test')).toThrow(/DATABASE_URL/);
  });
});
