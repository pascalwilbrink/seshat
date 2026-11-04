import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('shared data source', () => {
  it('is built from the validated config, never synchronizes and opens no connection on import', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@localhost:5999/db');
    const { dataSource } = await import('./data-source.js');
    expect(dataSource.isInitialized).toBe(false);
    expect(dataSource.options).toMatchObject({
      type: 'postgres',
      url: 'postgres://u:p@localhost:5999/db',
      synchronize: false,
      migrationsRun: false,
      installExtensions: false,
    });
  });

  it('synchronize is false in every mode', async () => {
    for (const mode of ['development', 'test', 'production']) {
      vi.resetModules();
      vi.stubEnv('DATABASE_URL', 'postgres://u:p@localhost:5999/db');
      vi.stubEnv('NODE_ENV', mode);
      const mod = await import('./data-source.js');
      expect(mod.createDataSourceOptions({ databaseUrl: 'postgres://u:p@h/d' }).synchronize).toBe(false);
    }
  });

  it('discovers migrations in the layout it runs from (source here)', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@localhost:5999/db');
    const { dataSource } = await import('./data-source.js');
    expect(dataSource.options.migrations).toEqual([expect.stringMatching(/\/src\/migrations\/\*\.ts$/)]);
  });

  it('is the instance Nest and the CLI both import', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@localhost:5999/db');
    const mod = await import('./data-source.js');
    const again = await import('./data-source.js');
    expect(again.dataSource).toBe(mod.dataSource);
  });
});
