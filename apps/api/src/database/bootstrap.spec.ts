import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseBootstrapError, initializeDatabase } from './bootstrap.js';

const SECRET = 'postgres://admin:s3cr3t-sentinel@db.internal:5432/prod';

function fakeDs(over: Partial<Record<'initialize' | 'runMigrations', () => Promise<unknown>>> = {}) {
  const ds = {
    isInitialized: false,
    initialize: vi.fn(over.initialize ?? (async () => { ds.isInitialized = true; })),
    runMigrations: vi.fn(over.runMigrations ?? (async () => [])),
  };
  return ds;
}

describe('initializeDatabase', () => {
  it('runs migrations when migrateOnStart is true', async () => {
    const ds = fakeDs();
    await initializeDatabase(ds as unknown as DataSource, { migrateOnStart: true });
    expect(ds.initialize).toHaveBeenCalledOnce();
    expect(ds.runMigrations).toHaveBeenCalledOnce();
  });

  it('does not execute migrations when migrateOnStart is false', async () => {
    const ds = fakeDs();
    await initializeDatabase(ds as unknown as DataSource, { migrateOnStart: false });
    expect(ds.initialize).toHaveBeenCalledOnce();
    expect(ds.runMigrations).not.toHaveBeenCalled();
  });

  it('does not initialize twice', async () => {
    const ds = fakeDs();
    ds.isInitialized = true;
    await initializeDatabase(ds as unknown as DataSource, { migrateOnStart: false });
    expect(ds.initialize).not.toHaveBeenCalled();
  });

  it('sanitizes connection failures', async () => {
    const ds = fakeDs({
      initialize: async () => {
        throw Object.assign(new Error(`connect failed for ${SECRET}`), { code: 'ECONNREFUSED' });
      },
    });
    const err = await initializeDatabase(ds as unknown as DataSource, { migrateOnStart: true }).catch((e) => e);
    expect(err).toBeInstanceOf(DatabaseBootstrapError);
    expect(err.message).toContain('ECONNREFUSED');
    expect(`${err.message}${err.stack}`).not.toMatch(/s3cr3t|admin|db\.internal|postgres:\/\//);
    expect(ds.runMigrations).not.toHaveBeenCalled();
  });

  it('sanitizes migration failures and ignores unsafe codes', async () => {
    const ds = fakeDs({
      runMigrations: async () => {
        throw Object.assign(new Error(SECRET), { code: SECRET });
      },
    });
    const err = await initializeDatabase(ds as unknown as DataSource, { migrateOnStart: true }).catch((e) => e);
    expect(err.message).toMatch(/migration failed/);
    expect(`${err.message}${err.stack}`).not.toMatch(/s3cr3t|postgres:\/\//);
  });
});
