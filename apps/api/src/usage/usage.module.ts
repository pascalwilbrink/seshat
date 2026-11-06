import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { UsageController } from './usage.controller.js';
import { UsageService } from './usage.service.js';
import { UsagePersistenceService } from './usage-persistence.service.js';
import { UsagePruneWorker } from './usage-prune.worker.js';
import { UsageCollector } from './usage-request-context.js';
import { UsageRecorderService } from './usage-recorder.service.js';
import { UsageRetentionService } from './usage-retention.service.js';

/** Usage insights storage (counters, MCP call history) and retention. Recording and API come in later modules. */
@Module({
  imports: [AuthModule],
  controllers: [UsageController],
  providers: [UsageService, UsagePersistenceService, UsageRecorderService, UsageCollector, UsageRetentionService, UsagePruneWorker],
  exports: [UsageService, UsagePersistenceService, UsageRecorderService, UsageCollector, UsageRetentionService],
})
export class UsageModule {}
