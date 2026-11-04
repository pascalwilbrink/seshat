import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { ApiKey } from './api-key.entity.js';
import { ApiKeyStore } from './api-key.store.js';
import { ApiKeysController } from './api-keys.controller.js';
import { ApiKeysService } from './api-keys.service.js';

/** Storage and admin management of Workspace API keys. Bearer authentication builds on ApiKeyStore. */
@Module({
  imports: [TypeOrmModule.forFeature([ApiKey]), AuthModule, WorkspacesModule],
  controllers: [ApiKeysController],
  providers: [ApiKeyStore, ApiKeysService],
  exports: [ApiKeyStore],
})
export class ApiKeysModule {}
