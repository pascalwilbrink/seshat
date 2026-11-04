import type { DataSource } from 'typeorm';

/** Thrown when the database cannot be initialized. The message never contains connection details. */
export class DatabaseBootstrapError extends Error {
  constructor(stage: 'connect' | 'migrate', code?: string) {
    super(
      `Database ${stage === 'connect' ? 'connection' : 'migration'} failed` +
        (code ? ` (${code})` : '') +
        '; check DATABASE_URL and that the database is reachable',
    );
    this.name = 'DatabaseBootstrapError';
  }
}

/** Only short, driver-level codes (ECONNREFUSED, 28P01, ...) are safe to show; never the raw message. */
function safeCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,24}$/.test(code) ? code : undefined;
}

/**
 * Connects the shared data source and, only when `migrateOnStart` is true, runs pending
 * migrations. Failures are replaced by a sanitized error: raw driver errors can carry
 * hosts, users or connection strings.
 */
export async function initializeDatabase(
  ds: DataSource,
  options: { migrateOnStart: boolean },
): Promise<DataSource> {
  if (!ds.isInitialized) {
    try {
      await ds.initialize();
    } catch (err) {
      throw new DatabaseBootstrapError('connect', safeCode(err));
    }
  }
  if (options.migrateOnStart) {
    try {
      await ds.runMigrations({ transaction: 'each' });
    } catch (err) {
      throw new DatabaseBootstrapError('migrate', safeCode(err));
    }
  }
  return ds;
}
