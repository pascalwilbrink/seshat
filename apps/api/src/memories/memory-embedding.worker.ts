import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { QueueService } from '../queue/index.js';
import { MemoryEmbeddingCoordinator } from './memory-embedding.coordinator.js';

export const MEMORY_EMBEDDING_COORDINATOR = Symbol('MEMORY_EMBEDDING_COORDINATOR');
export const MEMORY_RECONCILE_INTERVAL_MS = 30_000;

/** Registers the `embed-memory` worker before the queue starts and runs the reconciler of pending Memories. */
@Injectable()
export class MemoryEmbeddingWorker implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('MemoryEmbedding');
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(MEMORY_EMBEDDING_COORDINATOR) private readonly coordinator: MemoryEmbeddingCoordinator,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.registerMemoryWorker((job) => this.coordinator.process(job));
  }

  onApplicationBootstrap(): void {
    // Recovers pending Memories after a restart or a lost enqueue; failures (queue not ready yet) just wait for the next tick.
    const tick = () => void this.coordinator.reconcile().catch(() => this.logger.warn('Memory embedding reconcile failed'));
    setTimeout(tick, 1000).unref();
    this.timer = setInterval(tick, MEMORY_RECONCILE_INTERVAL_MS);
    this.timer.unref();
  }

  beforeApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
