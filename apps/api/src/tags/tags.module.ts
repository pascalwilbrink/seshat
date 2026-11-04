import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TagsController } from './tags.controller.js';
import { TagsService } from './tags.service.js';

/** Scoped Tag management plus the transaction-aware assignment helper used by the Files module. */
@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [TagsController],
  providers: [TagsService],
  exports: [TagsService],
})
export class TagsModule {}
