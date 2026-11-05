import { Global, Module } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { QUEUE_SCHEMA } from './queue.constants.js';
import { QUEUE_OPTIONS, QueueService, type QueueOptions } from './queue.service.js';

/**
 * Durable background work on pg-boss, in the same database as the application but in its own schema.
 * The DataSource is injected only to order startup: it resolves after the database bootstrap succeeded.
 */
@Global()
@Module({
  providers: [
    {
      provide: QUEUE_OPTIONS,
      inject: [APP_CONFIG, getDataSourceToken()],
      useFactory: (config: AppConfig): QueueOptions => ({
        connectionString: config.databaseUrl,
        schema: QUEUE_SCHEMA,
        ingestionConcurrency: config.ingestionConcurrency,
      }),
    },
    QueueService,
  ],
  exports: [QueueService],
})
export class QueueModule {}
