import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CollectionsService } from './collection.service.js';
import { CollectionsController } from './collections.controller.js';

/** Scoped, optional Collections. `CollectionsService.resolveMembership` is exported for file upload/update. */
@Module({
  imports: [AuthModule],
  controllers: [CollectionsController],
  providers: [CollectionsService],
  exports: [CollectionsService],
})
export class CollectionsModule {}
