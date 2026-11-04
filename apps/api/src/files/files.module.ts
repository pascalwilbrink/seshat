import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CollectionsModule } from '../collections/collections.module.js';
import { TagsModule } from '../tags/tags.module.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';

/** Scoped original files. Storage and events are global providers. */
@Module({
  imports: [AuthModule, CollectionsModule, TagsModule],
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
