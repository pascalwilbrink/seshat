/** Typed, validated API configuration. */
export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export interface AppConfig {
  /** Runtime environment. Default: development. */
  nodeEnv: NodeEnv;
  /** HTTP port. Default: 4200. */
  port: number;
  /** PostgreSQL connection URL. Required; never logged. */
  databaseUrl: string;
  /** Run pending migrations at startup. Default: true in development, false otherwise. */
  dbMigrateOnStart: boolean;
  /** Single admin username. Required. */
  adminUsername: string;
  /** Argon2id hash of the admin password (`pnpm --filter @seshat/api admin:hash-password`). Required; never logged. */
  adminPasswordHash: string;
  /** HMAC key signing session cookies, at least 32 characters. Required; never logged. */
  sessionSecret: string;
  /** Secret key (pepper) of the API-key HMAC, at least 32 characters. Required; never logged. Changing it invalidates every key. */
  apiKeyPepper: string;
  /**
   * How many reverse-proxy hops to trust for the client IP (X-Forwarded-For). `false` (default)
   * trusts no forwarding header, so the socket address is used.
   */
  trustProxy: false | number;
  /**
   * Directory holding original uploaded files. Optional here so that tools which only need the database (migration CLI)
   * can load the config; the API itself refuses to start without it (see storage/). Never logged.
   */
  fileStorageDir: string | undefined;
  /** Largest accepted upload in bytes (positive integer). Default: 50 MB. */
  maxUploadBytes: number;
  /** Parallel `ingest-file` jobs per process (positive integer). Default: 2. */
  ingestionConcurrency: number;
  /** Maximum characters per chunk (positive integer). Default: 2000. */
  chunkSizeChars: number;
  /** Characters shared by consecutive chunks (integer >= 0 and smaller than the chunk size). Default: 200. */
  chunkOverlapChars: number;
  /**
   * OpenAI API key for embeddings; never logged. Optional here so that tools which only need the database (migration
   * CLI) can load the config; the embedding service refuses to be built without it (`requireOpenAiApiKey`).
   */
  openaiApiKey: string | undefined;
  /** Embedding model name (non-empty). Default: text-embedding-3-small. */
  embeddingModel: string;
  /** Embedding vector dimension (positive integer). Default: 1536. Must match the physical `chunks` column. */
  embeddingDimension: number;
}

export const DEFAULT_INGESTION_CONCURRENCY = 2;
export const DEFAULT_CHUNK_SIZE_CHARS = 2000;
export const DEFAULT_CHUNK_OVERLAP_CHARS = 200;
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
export const DEFAULT_EMBEDDING_DIMENSION = 1536;

export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export const MIN_SESSION_SECRET_LENGTH = 32;
export const MIN_API_KEY_PEPPER_LENGTH = 32;
export const MAX_ADMIN_USERNAME_LENGTH = 128;

const ARGON2ID_HASH_RE = /^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

/** True for an encoded argon2id hash (shape only; the hash is never parsed further here). */
export function isArgon2idHash(value: string): boolean {
  return ARGON2ID_HASH_RE.test(value);
}

/** Injection token for AppConfig (explicit, since Vitest emits no decorator metadata). */
export const APP_CONFIG = Symbol('APP_CONFIG');

export type EnvSource = Record<string, string | undefined>;

/**
 * Thrown for invalid configuration. The message only names variables and a fixed
 * reason; it never contains supplied values or raw validation errors.
 */
export class ConfigError extends Error {
  constructor(readonly problems: ReadonlyArray<{ variable: string; reason: string }>) {
    super(
      `Invalid configuration: ${problems.map((p) => `${p.variable} (${p.reason})`).join(', ')}`,
    );
    this.name = 'ConfigError';
  }
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.hostname !== '';
  } catch {
    return false;
  }
}

/** Returns the OpenAI API key or throws a ConfigError naming only the variable. */
export function requireOpenAiApiKey(config: Pick<AppConfig, 'openaiApiKey'>): string {
  if (!config.openaiApiKey) throw new ConfigError([{ variable: 'OPENAI_API_KEY', reason: 'is required' }]);
  return config.openaiApiKey;
}

/** Validates an environment map. Empty strings count as unset. Pure: never reads process.env. */
export function loadConfig(env: EnvSource): AppConfig {
  const problems: Array<{ variable: string; reason: string }> = [];
  const get = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value === '' ? undefined : value;
  };

  let nodeEnv: NodeEnv = 'development';
  const rawNodeEnv = get('NODE_ENV');
  if (rawNodeEnv !== undefined) {
    if ((NODE_ENVS as readonly string[]).includes(rawNodeEnv)) {
      nodeEnv = rawNodeEnv as NodeEnv;
    } else {
      problems.push({ variable: 'NODE_ENV', reason: `must be one of ${NODE_ENVS.join(', ')}` });
    }
  }

  let port = 4200;
  const rawPort = get('PORT');
  if (rawPort !== undefined) {
    const parsed = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      port = parsed;
    } else {
      problems.push({ variable: 'PORT', reason: 'must be an integer between 1 and 65535' });
    }
  }

  let databaseUrl = '';
  const rawDatabaseUrl = get('DATABASE_URL');
  if (rawDatabaseUrl === undefined) {
    problems.push({ variable: 'DATABASE_URL', reason: 'is required' });
  } else if (!isPostgresUrl(rawDatabaseUrl)) {
    problems.push({
      variable: 'DATABASE_URL',
      reason: 'must be a postgres:// or postgresql:// URL',
    });
  } else {
    databaseUrl = rawDatabaseUrl;
  }

  let dbMigrateOnStart = nodeEnv === 'development';
  const rawMigrate = get('DB_MIGRATE_ON_START');
  if (rawMigrate !== undefined) {
    if (rawMigrate === 'true' || rawMigrate === 'false') {
      dbMigrateOnStart = rawMigrate === 'true';
    } else {
      problems.push({ variable: 'DB_MIGRATE_ON_START', reason: 'must be exactly true or false' });
    }
  }

  let adminUsername = '';
  const rawUsername = get('ADMIN_USERNAME');
  if (rawUsername === undefined) {
    problems.push({ variable: 'ADMIN_USERNAME', reason: 'is required' });
  } else if (rawUsername.length > MAX_ADMIN_USERNAME_LENGTH) {
    problems.push({ variable: 'ADMIN_USERNAME', reason: `must be at most ${MAX_ADMIN_USERNAME_LENGTH} characters` });
  } else {
    adminUsername = rawUsername;
  }

  let adminPasswordHash = '';
  const rawHash = get('ADMIN_PASSWORD_HASH');
  if (rawHash === undefined) {
    problems.push({ variable: 'ADMIN_PASSWORD_HASH', reason: 'is required' });
  } else if (!isArgon2idHash(rawHash)) {
    problems.push({ variable: 'ADMIN_PASSWORD_HASH', reason: 'must be an argon2id hash' });
  } else {
    adminPasswordHash = rawHash;
  }

  let sessionSecret = '';
  const rawSecret = get('SESSION_SECRET');
  if (rawSecret === undefined) {
    problems.push({ variable: 'SESSION_SECRET', reason: 'is required' });
  } else if (rawSecret.length < MIN_SESSION_SECRET_LENGTH) {
    problems.push({
      variable: 'SESSION_SECRET',
      reason: `must be at least ${MIN_SESSION_SECRET_LENGTH} characters`,
    });
  } else {
    sessionSecret = rawSecret;
  }

  let apiKeyPepper = '';
  const rawPepper = get('API_KEY_PEPPER');
  if (rawPepper === undefined) {
    problems.push({ variable: 'API_KEY_PEPPER', reason: 'is required' });
  } else if (rawPepper.length < MIN_API_KEY_PEPPER_LENGTH) {
    problems.push({
      variable: 'API_KEY_PEPPER',
      reason: `must be at least ${MIN_API_KEY_PEPPER_LENGTH} characters`,
    });
  } else {
    apiKeyPepper = rawPepper;
  }

  let trustProxy: false | number = false;
  const rawTrust = get('TRUST_PROXY');
  if (rawTrust !== undefined && rawTrust !== 'false') {
    const hops = /^\d{1,2}$/.test(rawTrust) ? Number(rawTrust) : NaN;
    if (Number.isInteger(hops) && hops >= 1) {
      trustProxy = hops;
    } else {
      problems.push({ variable: 'TRUST_PROXY', reason: 'must be false or a number of proxy hops (1-99)' });
    }
  }

  let fileStorageDir: string | undefined;
  const rawStorageDir = get('FILE_STORAGE_DIR');
  if (rawStorageDir !== undefined) {
    if (rawStorageDir.includes('\0')) {
      problems.push({ variable: 'FILE_STORAGE_DIR', reason: 'must be a valid directory path' });
    } else {
      fileStorageDir = rawStorageDir;
    }
  }

  let maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES;
  const rawMaxUpload = get('MAX_UPLOAD_BYTES');
  if (rawMaxUpload !== undefined) {
    const bytes = /^[1-9]\d{0,15}$/.test(rawMaxUpload) ? Number(rawMaxUpload) : NaN;
    if (Number.isSafeInteger(bytes)) {
      maxUploadBytes = bytes;
    } else {
      problems.push({ variable: 'MAX_UPLOAD_BYTES', reason: 'must be a positive integer number of bytes' });
    }
  }

  const positiveInt = (name: string, fallback: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const n = /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : NaN;
    if (Number.isSafeInteger(n)) return n;
    problems.push({ variable: name, reason: 'must be a positive integer' });
    return fallback;
  };

  const ingestionConcurrency = positiveInt('INGESTION_CONCURRENCY', DEFAULT_INGESTION_CONCURRENCY);
  const chunkSizeChars = positiveInt('CHUNK_SIZE_CHARS', DEFAULT_CHUNK_SIZE_CHARS);

  let chunkOverlapChars = DEFAULT_CHUNK_OVERLAP_CHARS;
  const rawOverlap = get('CHUNK_OVERLAP_CHARS');
  if (rawOverlap !== undefined) {
    const n = /^(0|[1-9]\d{0,8})$/.test(rawOverlap) ? Number(rawOverlap) : NaN;
    if (Number.isSafeInteger(n)) {
      chunkOverlapChars = n;
    } else {
      problems.push({ variable: 'CHUNK_OVERLAP_CHARS', reason: 'must be an integer of at least 0' });
    }
  }
  if (!problems.some((p) => p.variable === 'CHUNK_SIZE_CHARS' || p.variable === 'CHUNK_OVERLAP_CHARS')) {
    if (chunkOverlapChars >= chunkSizeChars) {
      problems.push({ variable: 'CHUNK_OVERLAP_CHARS', reason: 'must be smaller than CHUNK_SIZE_CHARS' });
    }
  }

  const openaiApiKey = get('OPENAI_API_KEY');

  let embeddingModel = DEFAULT_EMBEDDING_MODEL;
  const rawModel = env.EMBEDDING_MODEL;
  if (rawModel !== undefined && rawModel !== '') {
    if (rawModel.trim() === '' || rawModel.length > 200 || /[\s\0]/.test(rawModel)) {
      problems.push({ variable: 'EMBEDDING_MODEL', reason: 'must be a model name of 1-200 characters without whitespace' });
    } else {
      embeddingModel = rawModel;
    }
  }

  const embeddingDimension = positiveInt('EMBEDDING_DIMENSION', DEFAULT_EMBEDDING_DIMENSION);

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    nodeEnv,
    port,
    databaseUrl,
    dbMigrateOnStart,
    adminUsername,
    adminPasswordHash,
    sessionSecret,
    apiKeyPepper,
    trustProxy,
    fileStorageDir,
    maxUploadBytes,
    ingestionConcurrency,
    chunkSizeChars,
    chunkOverlapChars,
    openaiApiKey,
    embeddingModel,
    embeddingDimension,
  };
}
