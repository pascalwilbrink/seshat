import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health.controller.js';

@Module({
  // EventEmitterModule.forRoot() is global: feature modules just inject EventEmitter2 / use @OnEvent.
  imports: [ConfigModule, DatabaseModule, EventEmitterModule.forRoot()],
  controllers: [HealthController],
})
export class AppModule {}
