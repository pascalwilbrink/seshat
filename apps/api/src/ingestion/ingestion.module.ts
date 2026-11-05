import { Module } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage.js';
import { AiSdkEmbeddingService } from './ai-sdk-embedding.service.js';
import { EMBEDDING_SERVICE, type EmbeddingService } from './embedding.service.js';
import { FileIngestorProvider, provideFileIngestors } from './file-ingestor.provider.js';
import { IngestionProcessor } from './ingestion.processor.js';
import { INGESTION_PROCESSOR, IngestionWorker } from './ingestion.worker.js';
import { PlainTextIngestor } from './plain-text.ingestor.js';

/**
 * Ingestion: ingestors (add new ones to `provideFileIngestors`), the embedding service (needs OPENAI_API_KEY; startup
 * fails with a sanitized ConfigError without it), the processor and the queue worker plus `file.uploaded` listener.
 */
@Module({
  providers: [
    ...provideFileIngestors(PlainTextIngestor),
    { provide: EMBEDDING_SERVICE, inject: [APP_CONFIG], useFactory: (config: AppConfig): EmbeddingService => new AiSdkEmbeddingService(config) },
    {
      provide: INGESTION_PROCESSOR,
      inject: [getDataSourceToken(), FILE_STORAGE, FileIngestorProvider, EMBEDDING_SERVICE, APP_CONFIG],
      useFactory: (ds: DataSource, storage: FileStorage, ingestors: FileIngestorProvider, embeddings: EmbeddingService, config: AppConfig) =>
        new IngestionProcessor(ds, storage, ingestors, embeddings, { chunkSizeChars: config.chunkSizeChars, chunkOverlapChars: config.chunkOverlapChars }),
    },
    IngestionWorker,
  ],
})
export class IngestionModule {}
