import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TagsModule } from '../tags/tags.module.js';
import { MemoriesController } from './memories.controller.js';
import { MemoriesService } from './memories.service.js';

/** Scoped typed Memories (lifecycle). Reads, embeddings and search are separate jobs. */
@Module({
  imports: [AuthModule, TagsModule],
  controllers: [MemoriesController],
  providers: [MemoriesService],
  exports: [MemoriesService],
})
export class MemoriesModule {}
