import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { UsageAccessInterceptor } from './usage-access.interceptor.js';
import { UsagePersistenceService } from './usage-persistence.service.js';
import { UsagePruneWorker } from './usage-prune.worker.js';
import { UsageCollector } from './usage-request-context.js';
import { UsageRecorderService } from './usage-recorder.service.js';
import { UsageRetentionService } from './usage-retention.service.js';

/** Usage insights storage (counters, MCP call history) and retention. Recording and API come in later modules. */
@Global()
@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: UsageAccessInterceptor }, UsagePersistenceService, UsageRecorderService, UsageCollector, UsageRetentionService, UsagePruneWorker],
  exports: [UsagePersistenceService, UsageRecorderService, UsageCollector, UsageRetentionService],
})
export class UsageModule {}
