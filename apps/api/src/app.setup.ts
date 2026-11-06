import { type INestApplication, type LoggerService, RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AppConfig } from './config/app-config.js';
import { DEFAULT_MCP_MAX_UPLOAD_BYTES } from './config/app-config.js';
import { MCP_PATH, isMcpPath, mcpBodyLimitBytes } from './mcp/mcp-limits.js';

export const MAX_BODY_BYTES = 16 * 1024;

interface Req {
  method: string;
  path?: string;
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
  return parseJson(MAX_BODY_BYTES, req, res, next);
}

/** The same parser with another size limit (used for `/mcp`, whose limit derives from MCP_MAX_UPLOAD_BYTES). */
export function jsonParserWithLimit(limitBytes: number) {
  return (req: Req, res: Res, next: () => void): void => parseJson(limitBytes, req, res, next);
}

function parseJson(limit: number, req: Req, res: Res, next: () => void): void {
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
    if (size > limit) {
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
export function configureApp(
  app: INestApplication,
  config: Pick<AppConfig, 'trustProxy'> & Partial<Pick<AppConfig, 'mcpMaxUploadBytes'>>,
): void {
  // `/mcp` is served at the root path, outside the `api` prefix.
  app.setGlobalPrefix('api', {
    exclude: [RequestMethod.POST, RequestMethod.GET, RequestMethod.DELETE].map((method) => ({ path: MCP_PATH.slice(1), method })),
  });
  const express = app.getHttpAdapter().getInstance() as {
    set(name: string, value: unknown): unknown;
    disable(name: string): unknown;
  };
  express.disable('x-powered-by');
  // Never trust forwarding headers unless a proxy hop count is configured explicitly.
  express.set('trust proxy', config.trustProxy);
  // Only a request that presents a Bearer credential may use the large `/mcp` limit; everything else keeps 16 KB.
  const mcpParser = jsonParserWithLimit(mcpBodyLimitBytes(config.mcpMaxUploadBytes ?? DEFAULT_MCP_MAX_UPLOAD_BYTES));
  app.use((req: Req, res: Res, next: () => void) => (isMcpPath(req.path ?? '') && /^Bearer[ \t]/i.test(String(req.headers.authorization ?? '')) ? mcpParser(req, res, next) : sanitizedJsonParser(req, res, next)));
}

export async function createApp(
  module: Parameters<typeof NestFactory.create>[0],
  config: Pick<AppConfig, 'trustProxy'> & Partial<Pick<AppConfig, 'mcpMaxUploadBytes'>>,
  logger?: LoggerService | false,
): Promise<INestApplication> {
  const app = await NestFactory.create(module, { bodyParser: false, ...(logger === undefined ? {} : { logger }) });
  configureApp(app, config);
  return app;
}
