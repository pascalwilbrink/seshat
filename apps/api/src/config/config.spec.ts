import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './app-config.js';

const SENTINEL = 'sentinel-secret-9f3a';
const VALID = { DATABASE_URL: 'postgres://user:pw@localhost:5432/db' };

function problemsOf(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    expect(loadConfig(VALID)).toEqual({
      nodeEnv: 'development',
      port: 4200,
      databaseUrl: VALID.DATABASE_URL,
      dbMigrateOnStart: true,
    });
  });

  it('defaults DB_MIGRATE_ON_START to false outside development', () => {
    expect(loadConfig({ ...VALID, NODE_ENV: 'production' }).dbMigrateOnStart).toBe(false);
    expect(loadConfig({ ...VALID, NODE_ENV: 'test' }).dbMigrateOnStart).toBe(false);
  });

  it('honours explicit values', () => {
    expect(
      loadConfig({ ...VALID, NODE_ENV: 'production', PORT: '8080', DB_MIGRATE_ON_START: 'true' }),
    ).toMatchObject({ nodeEnv: 'production', port: 8080, dbMigrateOnStart: true });
    expect(loadConfig({ ...VALID, DB_MIGRATE_ON_START: 'false' }).dbMigrateOnStart).toBe(false);
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ ...VALID, PORT: '', NODE_ENV: '', DB_MIGRATE_ON_START: '' }).port).toBe(4200);
  });

  it('names a missing DATABASE_URL', () => {
    expect(problemsOf({})).toBe('Invalid configuration: DATABASE_URL (is required)');
  });

  it.each([
    `not a url ${SENTINEL}`,
    `mysql://u:${SENTINEL}@localhost/db`,
    `postgres://u:${SENTINEL}@/db`,
    `http://u:${SENTINEL}@localhost/db`,
  ])('rejects malformed DATABASE_URL without echoing it', (bad) => {
    const message = problemsOf({ DATABASE_URL: bad });
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain(SENTINEL);
    expect(message).not.toContain('localhost');
  });

  it.each(['abc', '0', '65536', '-1', '4200.5', '1e3', ' 80'])('rejects PORT %j', (port) => {
    const message = problemsOf({ ...VALID, PORT: port });
    expect(message).toContain('PORT');
    expect(message).not.toContain(`"${port}"`);
  });

  it.each(['staging', 'PRODUCTION', 'prod'])('rejects NODE_ENV %j', (value) => {
    expect(problemsOf({ ...VALID, NODE_ENV: value })).toContain('NODE_ENV');
  });

  it.each(['TRUE', '1', 'yes', 'on', 'False'])('rejects DB_MIGRATE_ON_START %j', (value) => {
    expect(problemsOf({ ...VALID, DB_MIGRATE_ON_START: value })).toContain('DB_MIGRATE_ON_START');
  });

  it('reports every offending variable at once', () => {
    const message = problemsOf({ PORT: 'x', NODE_ENV: 'x', DB_MIGRATE_ON_START: 'x' });
    for (const name of ['DATABASE_URL', 'PORT', 'NODE_ENV', 'DB_MIGRATE_ON_START']) {
      expect(message).toContain(name);
    }
  });
});
