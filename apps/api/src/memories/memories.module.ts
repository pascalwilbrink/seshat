import { Module } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { EMBEDDING_SERVICE, type EmbeddingService } from '../ingestion/embedding.service.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { QueueService } from '../queue/index.js';
import { TagsModule } from '../tags/tags.module.js';
import { MemoriesController } from './memories.controller.js';
import { MemoriesService } from './memories.service.js';
import { MemoryEmbeddingCoordinator } from './memory-embedding.coordinator.js';
import { MEMORY_EMBEDDING_COORDINATOR, MemoryEmbeddingWorker } from './memory-embedding.worker.js';

/**
 * Scoped typed Memories. Embeddings reuse the ingestion EmbeddingService and the shared pg-boss lifecycle
 * (`embed-memory` queue); a coordinator embeds inline and a worker retries and reconciles pending records.
 */
@Module({
  imports: [AuthModule, TagsModule, IngestionModule],
  controllers: [MemoriesController],
  providers: [
    {
      provide: MEMORY_EMBEDDING_COORDINATOR,
      inject: [getDataSourceToken(), EMBEDDING_SERVICE, QueueService, APP_CONFIG],
      useFactory: (ds: DataSource, embeddings: EmbeddingService, queue: QueueService, config: AppConfig) =>
        new MemoryEmbeddingCoordinator(ds, embeddings, queue, { similarityHint: config.memorySimilarityHint }),
    },
    MemoryEmbeddingWorker,
    MemoriesService,
  ],
  exports: [MemoriesService],
})
export class MemoriesModule {}
