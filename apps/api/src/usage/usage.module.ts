import { Module } from '@nestjs/common';
import { UsagePersistenceService } from './usage-persistence.service.js';
import { UsagePruneWorker } from './usage-prune.worker.js';
import { UsageRetentionService } from './usage-retention.service.js';

/** Usage insights storage (counters, MCP call history) and retention. Recording and API come in later modules. */
@Module({
  providers: [UsagePersistenceService, UsageRetentionService, UsagePruneWorker],
  exports: [UsagePersistenceService, UsageRetentionService],
})
export class UsageModule {}
