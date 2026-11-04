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

  if (problems.length > 0) throw new ConfigError(problems);
  return { nodeEnv, port, databaseUrl, dbMigrateOnStart };
}
