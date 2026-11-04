import 'reflect-metadata';
import { Inject, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EventEmitter2, EventEmitterModule, OnEvent } from '@nestjs/event-emitter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('ConfigModule', () => {
  it('injects typed, validated config', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@localhost:5432/db');
    vi.stubEnv('PORT', '5001');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DB_MIGRATE_ON_START', '');
    const { ConfigModule } = await import('./config/config.module.js');

    @Injectable()
    class Consumer {
      constructor(@Inject(APP_CONFIG) readonly config: AppConfig) {}
    }
    @Module({ imports: [ConfigModule], providers: [Consumer] })
    class FeatureModule {}

    const ctx = await NestFactory.createApplicationContext(FeatureModule, { logger: false });
    expect(ctx.get(Consumer).config).toMatchObject({
      nodeEnv: 'test',
      port: 5001,
      databaseUrl: 'postgres://u:p@localhost:5432/db',
      dbMigrateOnStart: false,
    });
    await ctx.close();
  });
});

describe('global events', () => {
  it('delivers an emitted event to a listener in another module without feature registration', async () => {
    const received: unknown[] = [];

    @Injectable()
    class Listener {
      @OnEvent('test.happened')
      handle(payload: unknown) {
        received.push(payload);
      }
    }
    @Module({ providers: [Listener] })
    class ListenerModule {}

    @Injectable()
    class Emitter {
      constructor(@Inject(EventEmitter2) readonly events: EventEmitter2) {}
    }
    @Module({ providers: [Emitter], exports: [Emitter] })
    class EmitterModule {}

    // Feature modules import neither EventEmitterModule nor each other.
    @Module({ imports: [EventEmitterModule.forRoot(), ListenerModule, EmitterModule] })
    class RootModule {}

    const ctx = await NestFactory.createApplicationContext(RootModule, { logger: false });
    await ctx.get(Emitter, { strict: false }).events.emitAsync('test.happened', { id: 1 });
    expect(received).toEqual([{ id: 1 }]);
    await ctx.close();
  });

  it('AppModule registers the emitter globally', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@localhost:5432/db');
    const { AppModule } = await import('./app.module.js');
    const ctx = await NestFactory.createApplicationContext(AppModule, { logger: false });
    expect(ctx.get(EventEmitter2)).toBeInstanceOf(EventEmitter2);
    await ctx.close();
  });
});
