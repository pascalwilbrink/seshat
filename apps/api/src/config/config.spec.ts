import { describe, expect, it } from 'vitest';
import { TEST_ADMIN_ENV, TEST_API_KEY_PEPPER, TEST_ADMIN_PASSWORD_HASH, TEST_ADMIN_USERNAME, TEST_SESSION_SECRET } from '../../test/fixtures/admin.js';
import { ConfigError, loadConfig, requireOpenAiApiKey } from './app-config.js';

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
      fileStorageDir: undefined,
      maxUploadBytes: 52428800,
      ingestionConcurrency: 2,
      chunkSizeChars: 2000,
      chunkOverlapChars: 200,
      openaiApiKey: undefined,
      embeddingModel: 'text-embedding-3-small',
      embeddingDimension: 1536,
      memorySimilarityHint: 0.9,
      mcpMaxUploadBytes: 10485760,
      mcpMaxResultChars: 20000,
      usageRetentionDays: 365,
      mcpCallRetentionDays: 90,
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

  it('reads FILE_STORAGE_DIR without requiring it (migration CLI)', () => {
    expect(loadConfig(VALID).fileStorageDir).toBeUndefined();
    expect(loadConfig({ ...VALID, FILE_STORAGE_DIR: '/var/seshat/files' }).fileStorageDir).toBe('/var/seshat/files');
  });

  it('validates MAX_UPLOAD_BYTES as a positive integer without echoing it', () => {
    expect(loadConfig({ ...VALID, MAX_UPLOAD_BYTES: '1024' }).maxUploadBytes).toBe(1024);
    for (const bad of ['0', '-1', '1.5', '10MB', '0x10', `1${SENTINEL}`, '9'.repeat(30)]) {
      const message = problemsOf({ ...VALID, MAX_UPLOAD_BYTES: bad });
      expect(message).toBe('Invalid configuration: MAX_UPLOAD_BYTES (must be a positive integer number of bytes)');
    }
  });

  describe('ingestion and embeddings', () => {
    it('honours explicit values', () => {
      expect(
        loadConfig({
          ...VALID,
          INGESTION_CONCURRENCY: '4',
          CHUNK_SIZE_CHARS: '500',
          CHUNK_OVERLAP_CHARS: '0',
          OPENAI_API_KEY: SENTINEL,
          EMBEDDING_MODEL: 'text-embedding-3-large',
          EMBEDDING_DIMENSION: '3072',
        }),
      ).toMatchObject({
        ingestionConcurrency: 4,
        chunkSizeChars: 500,
        chunkOverlapChars: 0,
        openaiApiKey: SENTINEL,
        embeddingModel: 'text-embedding-3-large',
        embeddingDimension: 3072,
      });
    });

    it.each(['INGESTION_CONCURRENCY', 'CHUNK_SIZE_CHARS', 'EMBEDDING_DIMENSION'])(
      'rejects malformed %s without echoing it',
      (name) => {
        for (const bad of ['0', '-1', '1.5', 'abc', ` 3${SENTINEL}`, '9'.repeat(30)]) {
          const message = problemsOf({ ...VALID, [name]: bad });
          expect(message).toBe(`Invalid configuration: ${name} (must be a positive integer)`);
        }
      },
    );

    it('validates MEMORY_SIMILARITY_HINT: default 0.9, finite number in [0, 1], never echoed', () => {
      expect(loadConfig({ ...VALID }).memorySimilarityHint).toBe(0.9);
      for (const [raw, n] of [['0', 0], ['1', 1], ['0.75', 0.75], ['.5', 0.5]] as const) expect(loadConfig({ ...VALID, MEMORY_SIMILARITY_HINT: raw }).memorySimilarityHint).toBe(n);
      for (const bad of ['abc', '-0.1', '1.01', 'NaN', 'Infinity', '0x1', '1e0', `0.5${SENTINEL}`]) {
        const message = problemsOf({ ...VALID, MEMORY_SIMILARITY_HINT: bad });
        expect(message).toBe('Invalid configuration: MEMORY_SIMILARITY_HINT (must be a number between 0 and 1)');
      }
    });

    it('validates the MCP caps: defaults, positive integers only, never echoed', () => {
      const ok = loadConfig({ ...VALID, MCP_MAX_UPLOAD_BYTES: '2048', MCP_MAX_RESULT_CHARS: '500' });
      expect([ok.mcpMaxUploadBytes, ok.mcpMaxResultChars]).toEqual([2048, 500]);
      for (const bad of ['0', '-1', '1.5', 'abc', `3${SENTINEL}`]) {
        expect(problemsOf({ ...VALID, MCP_MAX_UPLOAD_BYTES: bad })).toBe('Invalid configuration: MCP_MAX_UPLOAD_BYTES (must be a positive integer number of bytes)');
        expect(problemsOf({ ...VALID, MCP_MAX_RESULT_CHARS: bad })).toBe('Invalid configuration: MCP_MAX_RESULT_CHARS (must be a positive integer)');
      }
    });

    it('validates the usage retention: defaults 365 and 90, positive integers only, never echoed', () => {
      const ok = loadConfig({ ...VALID });
      expect([ok.usageRetentionDays, ok.mcpCallRetentionDays]).toEqual([365, 90]);
      const set = loadConfig({ ...VALID, USAGE_RETENTION_DAYS: '30', MCP_CALL_RETENTION_DAYS: '7' });
      expect([set.usageRetentionDays, set.mcpCallRetentionDays]).toEqual([30, 7]);
      for (const bad of ['0', '-1', '1.5', 'abc', `3${SENTINEL}`]) {
        expect(problemsOf({ ...VALID, USAGE_RETENTION_DAYS: bad })).toBe('Invalid configuration: USAGE_RETENTION_DAYS (must be a positive integer)');
        expect(problemsOf({ ...VALID, MCP_CALL_RETENTION_DAYS: bad })).toBe('Invalid configuration: MCP_CALL_RETENTION_DAYS (must be a positive integer)');
      }
    });

    it('validates CHUNK_OVERLAP_CHARS: zero allowed, negative or malformed rejected, below the size', () => {
      expect(loadConfig({ ...VALID, CHUNK_OVERLAP_CHARS: '0' }).chunkOverlapChars).toBe(0);
      for (const bad of ['-1', '1.5', 'x', `2${SENTINEL}`]) {
        const message = problemsOf({ ...VALID, CHUNK_OVERLAP_CHARS: bad });
        expect(message).toBe('Invalid configuration: CHUNK_OVERLAP_CHARS (must be an integer of at least 0)');
        expect(message).not.toContain(SENTINEL);
      }
    });

    it('rejects an overlap that is not smaller than the chunk size', () => {
      const expected = 'Invalid configuration: CHUNK_OVERLAP_CHARS (must be smaller than CHUNK_SIZE_CHARS)';
      expect(problemsOf({ ...VALID, CHUNK_SIZE_CHARS: '100', CHUNK_OVERLAP_CHARS: '100' })).toBe(expected);
      expect(problemsOf({ ...VALID, CHUNK_SIZE_CHARS: '100', CHUNK_OVERLAP_CHARS: '150' })).toBe(expected);
      expect(problemsOf({ ...VALID, CHUNK_SIZE_CHARS: '200' })).toBe(expected);
      expect(loadConfig({ ...VALID, CHUNK_SIZE_CHARS: '201' }).chunkOverlapChars).toBe(200);
    });

    it('rejects a blank or malformed EMBEDDING_MODEL', () => {
      for (const bad of ['   ', 'a b', 'x'.repeat(201)]) {
        expect(problemsOf({ ...VALID, EMBEDDING_MODEL: bad })).toContain('EMBEDDING_MODEL');
      }
      expect(loadConfig({ ...VALID, EMBEDDING_MODEL: '' }).embeddingModel).toBe('text-embedding-3-small');
    });

    it('requires OPENAI_API_KEY only where the embedding service is built, and never echoes it', () => {
      expect(() => requireOpenAiApiKey(loadConfig(VALID))).toThrow(
        'Invalid configuration: OPENAI_API_KEY (is required)',
      );
      expect(requireOpenAiApiKey(loadConfig({ ...VALID, OPENAI_API_KEY: SENTINEL }))).toBe(SENTINEL);
      const message = problemsOf({
        ...VALID,
        OPENAI_API_KEY: SENTINEL,
        EMBEDDING_DIMENSION: '0',
        CHUNK_SIZE_CHARS: 'x',
      });
      expect(message).not.toContain(SENTINEL);
    });
  });
});
