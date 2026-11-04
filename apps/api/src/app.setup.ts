import { type INestApplication, type LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AppConfig } from './config/app-config.js';

const MAX_BODY_BYTES = 16 * 1024;

interface Req {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  on(event: string, cb: (...args: any[]) => void): unknown;
  destroy(): unknown;
}
interface Res {
  status(code: number): Res;
  json(body: unknown): unknown;
}

/**
 * Small JSON body parser with fixed error responses. Parser errors from stock middleware can echo a snippet
 * of the submitted body (for example a password), so errors here never include request content.
 */
export function sanitizedJsonParser(req: Req, res: Res, next: () => void): void {
  const type = String(req.headers['content-type'] ?? '');
  if (!/^application\/json\s*(;|$)/i.test(type) || ['GET', 'HEAD'].includes(req.method)) return next();
  const chunks: Buffer[] = [];
  let size = 0;
  let failed = false;
  const fail = (status: number, message: string) => {
    if (failed) return;
    failed = true;
    res.status(status).json({ statusCode: status, message });
  };
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      fail(413, 'Payload too large');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (failed) return;
    try {
      req.body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return fail(400, 'Invalid request');
    }
    next();
  });
  req.on('error', () => fail(400, 'Invalid request'));
}

/** HTTP configuration shared by production (main.ts) and tests, so they cannot drift. */
export function configureApp(app: INestApplication, config: Pick<AppConfig, 'trustProxy'>): void {
  app.setGlobalPrefix('api');
  const express = app.getHttpAdapter().getInstance() as {
    set(name: string, value: unknown): unknown;
    disable(name: string): unknown;
  };
  express.disable('x-powered-by');
  // Never trust forwarding headers unless a proxy hop count is configured explicitly.
  express.set('trust proxy', config.trustProxy);
  app.use(sanitizedJsonParser);
}

export async function createApp(
  module: Parameters<typeof NestFactory.create>[0],
  config: Pick<AppConfig, 'trustProxy'>,
  logger?: LoggerService | false,
): Promise<INestApplication> {
  const app = await NestFactory.create(module, { bodyParser: false, ...(logger === undefined ? {} : { logger }) });
  configureApp(app, config);
  return app;
}
