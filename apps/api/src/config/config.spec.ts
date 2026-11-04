import { describe, expect, it } from 'vitest';
import { TEST_ADMIN_ENV, TEST_API_KEY_PEPPER, TEST_ADMIN_PASSWORD_HASH, TEST_ADMIN_USERNAME, TEST_SESSION_SECRET } from '../../test/fixtures/admin.js';
import { ConfigError, loadConfig } from './app-config.js';

const SENTINEL = 'sentinel-secret-9f3a';
const VALID = { DATABASE_URL: 'postgres://user:pw@localhost:5432/db', ...TEST_ADMIN_ENV };

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
      adminUsername: TEST_ADMIN_USERNAME,
      adminPasswordHash: TEST_ADMIN_PASSWORD_HASH,
      sessionSecret: TEST_SESSION_SECRET,
      apiKeyPepper: TEST_API_KEY_PEPPER,
      trustProxy: false,
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
    expect(problemsOf({ ...TEST_ADMIN_ENV })).toBe('Invalid configuration: DATABASE_URL (is required)');
  });

  it('names every missing admin variable without values', () => {
    const message = problemsOf({ DATABASE_URL: VALID.DATABASE_URL });
    expect(message).toBe(
      'Invalid configuration: ADMIN_USERNAME (is required), ADMIN_PASSWORD_HASH (is required), SESSION_SECRET (is required), API_KEY_PEPPER (is required)',
    );
  });

  it.each([
    ['plain text', `hunter2-${SENTINEL}`],
    ['argon2i', '$argon2i$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaGhhc2g'],
    ['bcrypt', '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'],
    ['truncated', '$argon2id$v=19$m=65536,t=3,p=4$'],
  ])('rejects an ADMIN_PASSWORD_HASH that is %s without echoing it', (_name, bad) => {
    const message = problemsOf({ ...VALID, ADMIN_PASSWORD_HASH: bad });
    expect(message).toBe('Invalid configuration: ADMIN_PASSWORD_HASH (must be an argon2id hash)');
  });

  it('rejects a short SESSION_SECRET without echoing it', () => {
    const short = 'x'.repeat(31);
    const message = problemsOf({ ...VALID, SESSION_SECRET: short });
    expect(message).toBe('Invalid configuration: SESSION_SECRET (must be at least 32 characters)');
    expect(message).not.toContain(short);
    expect(loadConfig({ ...VALID, SESSION_SECRET: 'x'.repeat(32) }).sessionSecret).toHaveLength(32);
  });

  it('rejects a missing or short API_KEY_PEPPER without echoing it', () => {
    const { API_KEY_PEPPER: _omit, ...withoutPepper } = VALID;
    expect(problemsOf(withoutPepper)).toBe('Invalid configuration: API_KEY_PEPPER (is required)');
    const short = `${SENTINEL}`.padEnd(31, 'x');
    const message = problemsOf({ ...VALID, API_KEY_PEPPER: short });
    expect(message).toBe('Invalid configuration: API_KEY_PEPPER (must be at least 32 characters)');
    expect(message).not.toContain(short);
    expect(loadConfig({ ...VALID, API_KEY_PEPPER: 'p'.repeat(32) }).apiKeyPepper).toHaveLength(32);
  });

  it('rejects an overlong ADMIN_USERNAME', () => {
    expect(problemsOf({ ...VALID, ADMIN_USERNAME: 'u'.repeat(129) })).toContain('ADMIN_USERNAME');
  });

  it('parses TRUST_PROXY as false or a hop count', () => {
    expect(loadConfig({ ...VALID, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...VALID, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    for (const bad of ['true', '0', '-1', '1.5', '10.0.0.1', 'loopback']) {
      expect(problemsOf({ ...VALID, TRUST_PROXY: bad })).toContain('TRUST_PROXY');
    }
  });

  it.each([
    `not a url ${SENTINEL}`,
    `mysql://u:${SENTINEL}@localhost/db`,
    `postgres://u:${SENTINEL}@/db`,
    `http://u:${SENTINEL}@localhost/db`,
  ])('rejects malformed DATABASE_URL without echoing it', (bad) => {
    const message = problemsOf({ ...TEST_ADMIN_ENV, DATABASE_URL: bad });
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
    for (const name of ['DATABASE_URL', 'PORT', 'NODE_ENV', 'DB_MIGRATE_ON_START', 'ADMIN_USERNAME']) {
      expect(message).toContain(name);
    }
  });
});
