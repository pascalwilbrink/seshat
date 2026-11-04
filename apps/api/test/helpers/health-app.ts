import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { type LoggerService, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import { createApp } from '../../src/app.setup.js';
import { SanitizedExceptionFilter } from '../../src/common/sanitized-exception.filter.js';
import { HealthController } from '../../src/health.controller.js';
import { HealthService } from '../../src/health.service.js';

export class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  private push = (...a: unknown[]) =>
    void this.lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  log = this.push;
  error = this.push;
  warn = this.push;
  debug = this.push;
  verbose = this.push;
  fatal = this.push;
}

/** Boots the real health controller/service/filter/app setup around the supplied data source (no auth, no other modules). */
export async function bootHealthApp(dataSource: { query(sql: string): Promise<unknown> }) {
  @Module({
    controllers: [HealthController],
    providers: [HealthService, { provide: getDataSourceToken(), useValue: dataSource }, { provide: APP_FILTER, useClass: SanitizedExceptionFilter }],
  })
  class TestRoot {}
  const logs = new CapturingLogger();
  const app = await createApp(TestRoot, { trustProxy: false }, logs);
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  return {
    logs,
    async get() {
      const res = await fetch(`${base}/api/health`);
      const text = await res.text();
      return { status: res.status, text, json: JSON.parse(text) as unknown };
    },
    close: () => app.close(),
  };
}
