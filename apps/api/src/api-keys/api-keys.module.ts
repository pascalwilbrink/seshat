import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey } from './api-key.entity.js';
import { ApiKeyStore } from './api-key.store.js';

/** Storage for Workspace API keys. Management endpoints and bearer authentication build on ApiKeyStore. */
@Module({
  imports: [TypeOrmModule.forFeature([ApiKey])],
  providers: [ApiKeyStore],
  exports: [ApiKeyStore],
})
export class ApiKeysModule {}
