import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { QueueService } from '../queue/index.js';
import { UsageRetentionService } from './usage-retention.service.js';

/** Registers the daily `prune-usage` worker before the queue starts (the schedule is owned by QueueService). */
@Injectable()
export class UsagePruneWorker implements OnModuleInit {
  constructor(
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(UsageRetentionService) private readonly retention: UsageRetentionService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.registerPruneUsageWorker(async () => {
      await this.retention.prune();
    });
  }
}
