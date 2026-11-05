import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getAppConfig } from '../config/index.js';
import { initializeDatabase } from './bootstrap.js';
import { dataSource } from './data-source.js';

/**
 * Registers the shared data source (the same instance the CLI uses) with @nestjs/typeorm.
 * Nest never builds its own DataSource, so there is one connection pool and one set of options.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        ...dataSource.options,
        // Failures are sanitized by initializeDatabase, so the retry log lines are safe.
        retryAttempts: 3,
        retryDelay: 1000,
      }),
      dataSourceFactory: () =>
        initializeDatabase(dataSource, {
          migrateOnStart: getAppConfig().dbMigrateOnStart,
          embeddingDimension: getAppConfig().embeddingDimension,
        }),
    }),
  ],
})
export class DatabaseModule {}
