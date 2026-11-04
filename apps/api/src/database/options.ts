import type { DataSourceOptions } from 'typeorm';
import type { AppConfig } from '../config/app-config.js';

/** Source (.ts, run with tsx / Vitest) or compiled (.js) layout: discover only the files next to this one. */
const EXT = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const MIGRATIONS_GLOB = new URL(`../migrations/*.${EXT}`, import.meta.url).pathname;
const ENTITIES_GLOB = new URL(`../**/*.entity.${EXT}`, import.meta.url).pathname;

/**
 * Pure (no env access, no connection): the single place that decides how TypeORM connects. `synchronize` is false in every
 * mode: the schema only changes through migrations. Migrations run on startup only via
 * initializeDatabase (DB_MIGRATE_ON_START), never through the driver (`migrationsRun`).
 */
export function createDataSourceOptions(config: Pick<AppConfig, 'databaseUrl'>): DataSourceOptions {
  return {
    type: 'postgres',
    url: config.databaseUrl,
    synchronize: false,
    migrationsRun: false,
    // The driver installs no extensions on its own; `vector` is enabled by a migration.
    installExtensions: false,
    logging: false,
    entities: [ENTITIES_GLOB],
    migrations: [MIGRATIONS_GLOB],
  };
}
