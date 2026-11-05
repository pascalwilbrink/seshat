import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { RetrievalService } from './retrieval.service.js';

/** Reusable hybrid retrieval. HTTP delivery (controllers) is added by the search API job. */
@Module({
  imports: [IngestionModule],
  providers: [RetrievalService],
  exports: [RetrievalService],
})
export class SearchModule {}
