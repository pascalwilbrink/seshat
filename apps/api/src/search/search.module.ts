import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { RetrievalService } from './retrieval.service.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

/** Reusable hybrid retrieval plus its HTTP delivery (`POST .../search`). */
@Module({
  imports: [AuthModule, IngestionModule],
  controllers: [SearchController],
  providers: [RetrievalService, SearchService],
  exports: [RetrievalService, SearchService],
})
export class SearchModule {}
