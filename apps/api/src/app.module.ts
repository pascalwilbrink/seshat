import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { SanitizedExceptionFilter } from './common/sanitized-exception.filter.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { ScopesModule } from './scopes/scopes.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';

@Module({
  // EventEmitterModule.forRoot() is global: feature modules just inject EventEmitter2 / use @OnEvent.
  imports: [ConfigModule, DatabaseModule, EventEmitterModule.forRoot(), AuthModule, WorkspacesModule, ScopesModule],
  controllers: [HealthController],
  providers: [HealthService, { provide: APP_FILTER, useClass: SanitizedExceptionFilter }],
})
export class AppModule {}
