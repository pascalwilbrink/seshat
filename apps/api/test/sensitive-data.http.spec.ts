import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { type LoggerService, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getDataSourceToken } from '@nestjs/typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_ADMIN_ENV, TEST_ADMIN_PASSWORD, TEST_ADMIN_PASSWORD_HASH, TEST_SESSION_SECRET } from './fixtures/admin.js';
import { DenyingAuthorization, InMemoryWorkspaces, type WorkspaceApp, bootWorkspaceApp } from './helpers/workspace-app.js';
import { createApp } from '../src/app.setup.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthorizationService } from '../src/auth/authorization.service.js';
import { CLOCK, LoginRateLimiter, systemClock } from '../src/auth/login-rate-limiter.js';
import { SESSION_COOKIE_NAME } from '../src/auth/session-token.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { ApiKeyStore } from '../src/api-keys/api-key.store.js';
import { SanitizedExceptionFilter } from '../src/common/sanitized-exception.filter.js';
import { ConfigModule } from '../src/config/config.module.js';
import { EMBEDDING_SERVICE } from '../src/ingestion/embedding.service.js';
import { FakeEmbeddingService } from '../src/ingestion/fake-embedding.service.js';
import { McpController } from '../src/mcp/mcp.controller.js';
import { McpService } from '../src/mcp/mcp.service.js';
import { MCP_TOOL_REGISTRY, McpToolRegistry } from '../src/mcp/mcp-registry.js';
import { RetrievalService } from '../src/search/retrieval.service.js';
import { SearchController } from '../src/search/search.controller.js';
import { SearchService } from '../src/search/search.service.js';
import { RelatedMemoriesService } from '../src/search/related.service.js';
import { loadConfigOrExit } from '../src/config/startup.js';
import { loadConfig } from '../src/config/app-config.js';

const SENTINEL_COOKIE = 'SENTINEL-cookie-value-3c1d';
const SENTINEL_DRIVER = 'SENTINEL-driver-host-10.9.8.7';
const SENTINEL_BODY = 'SENTINEL-body-secret-77e0';
const SENTINEL_SECRET = 'SENTINEL-session-secret-must-not-print-0001';
const SENTINEL_HASH = '$argon2id$SENTINEL-bad-hash-9a8b';

let app: WorkspaceApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Everything observable from outside: bodies, headers (Set-Cookie checked separately), logs. */
async function observe(a: WorkspaceApp, method: string, path: string, body?: unknown, cookie?: string | null) {
  const c = cookie === undefined ? a.cookie : cookie;
  const res = await fetch(`${a.base}${path}`, {
    method,
    headers: { ...(c ? { cookie: c } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const headers = [...res.headers.entries()].filter(([k]) => k !== 'set-cookie').map(([k, v]) => `${k}: ${v}`).join('\n');
  return { status: res.status, text, headers, setCookie: res.headers.getSetCookie() };
}

describe('sensitive data stays out of logs, errors and responses (assembled HTTP boundary)', () => {
  it('survives expired, malformed, tampered and oversized cookies, validation and driver failures', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-01T00:00:00Z') });
    const mem = new InMemoryWorkspaces();
    app = await bootWorkspaceApp({ repo: mem.repo, dataSource: mem.dataSource });
    const validCookie = app.cookie;
    const token = validCookie.split('=')[1]!;
    const seen: string[] = [];
    const record = (r: Awaited<ReturnType<typeof observe>>) => {
      seen.push(r.text, r.headers);
      // Set-Cookie is the one intended session transport and only a successful login may set one.
      expect(r.setCookie).toEqual([]);
      return r;
    };

    const created = record(await observe(app, 'POST', '/api/global/workspaces', { name: 'Alpha' }));
    expect(created.status).toBe(201);
    const id = JSON.parse(created.text).id as string;

    // Failure paths with a valid session: validation, collision, unknown/malformed ids, driver errors.
    record(await observe(app, 'POST', '/api/global/workspaces', { name: 'Alpha', extra: SENTINEL_BODY }));
    record(await observe(app, 'POST', '/api/global/workspaces', { name: 'Alpha' })); // slug collision (driver message contains sentinel)
    record(await observe(app, 'POST', '/api/global/workspaces', `{"name":"${SENTINEL_BODY}"`));
    record(await observe(app, 'PUT', `/api/workspaces/${id}`, { name: 12, slug: SENTINEL_BODY }));
    record(await observe(app, 'DELETE', `/api/workspaces/${id}`, { slug: SENTINEL_BODY }));
    record(await observe(app, 'GET', `/api/workspaces/${SENTINEL_BODY}`));
    mem.failNextDelete = Object.assign(new Error(`connect ECONNREFUSED ${SENTINEL_DRIVER}`), { driverError: { code: '08006' } });
    const failed = record(await observe(app, 'DELETE', `/api/workspaces/${id}`, { slug: 'alpha' }));
    expect(failed.status).toBe(500);
    mem.repo.find = async () => {
      throw new Error(`relation workspaces ${SENTINEL_DRIVER}`);
    };
    expect(record(await observe(app, 'GET', '/api/global/workspaces')).status).toBe(500);

    // Cookie failures: malformed, tampered, truncated, huge, wrong name, repeated.
    const [v, payload, sig] = token.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', iat: 1, exp: 9_999_999_999 })).toString('base64url');
    const badCookies = [
      `seshat_session=${SENTINEL_COOKIE}`,
      `seshat_session=${v}.${forged}.${sig}`,
      `seshat_session=${v}.${payload}.${sig.slice(0, -3)}${'A'.repeat(3)}`,
      `seshat_session=${'x'.repeat(8000)}`,
      `seshat_session=%E0%A4%A; seshat_session=${SENTINEL_COOKIE}`,
      `${SENTINEL_COOKIE}`,
    ];
    for (const c of badCookies) {
      const r = record(await observe(app, 'GET', '/api/global/workspaces', undefined, c));
      expect(r.status, c.slice(0, 30)).toBe(401);
    }

    // Expired session (valid signature, past the 7-day lifetime).
    vi.setSystemTime(new Date('2026-03-08T00:00:01Z'));
    for (const [m, p] of [['GET', '/api/global/workspaces'], ['GET', `/api/workspaces/${id}`], ['GET', '/api/global/overview']] as const) {
      expect(record(await observe(app, m, p)).status, p).toBe(401);
    }

    const haystack = [...seen, ...app.logs.lines].join('\n');
    for (const secret of [
      SENTINEL_COOKIE,
      SENTINEL_DRIVER,
      SENTINEL_BODY,
      token,
      payload,
      sig,
      TEST_ADMIN_PASSWORD,
      TEST_ADMIN_PASSWORD_HASH,
      TEST_SESSION_SECRET,
      'argon2id',
      'UQ_workspaces',
      'duplicate key',
    ]) {
      expect(haystack, `leaked ${secret.slice(0, 14)}`).not.toContain(secret);
    }
    expect(haystack).not.toMatch(/\bat \S+ \(.*:\d+:\d+\)/); // no stack frames
  });

  it('keeps missing and denied Workspace responses indistinguishable, including headers', async () => {
    const mem = new InMemoryWorkspaces();
    app = await bootWorkspaceApp({ repo: mem.repo, dataSource: mem.dataSource });
    const ws = JSON.parse((await observe(app, 'POST', '/api/global/workspaces', { name: 'Hidden' })).text).id as string;
    const missing = '00000000-0000-4000-8000-000000000000';
    const probe = async (a: WorkspaceApp, id: string) =>
      Promise.all(
        [
          ['GET', `/api/workspaces/${id}`, undefined],
          ['PUT', `/api/workspaces/${id}`, { name: 'n', description: null }],
          ['DELETE', `/api/workspaces/${id}`, { slug: 'hidden' }],
          ['GET', `/api/workspaces/${id}/overview`, undefined],
        ].map(async ([m, p, b]) => {
          const r = await observe(a, m as string, p as string, b);
          return { status: r.status, text: r.text, headers: r.headers.replace(/^(date|etag|content-length):.*$/gim, '') };
        }),
      );
    const baseline = await probe(app, missing);
    const denying = await bootWorkspaceApp({ repo: mem.repo, dataSource: mem.dataSource, authorization: new DenyingAuthorization('all') });
    try {
      const denied = await probe(denying, ws);
      expect(denied).toEqual(baseline);
      expect(baseline.every((r) => r.status === 404)).toBe(true);
      expect(denied.map((r) => r.text).join()).not.toContain(ws);
      expect(mem.rows).toHaveLength(1);
    } finally {
      await denying.close();
    }
  });
});

describe('invalid configuration never prints secret values', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['short session secret', { ...TEST_ADMIN_ENV, SESSION_SECRET: SENTINEL_SECRET.slice(0, 20) }],
    ['bad hash', { ...TEST_ADMIN_ENV, ADMIN_PASSWORD_HASH: SENTINEL_HASH }],
    ['plaintext password as hash', { ...TEST_ADMIN_ENV, ADMIN_PASSWORD_HASH: SENTINEL_SECRET }],
    ['bad database url', { ...TEST_ADMIN_ENV, DATABASE_URL: `mysql://u:${SENTINEL_SECRET}@h/db` }],
  ];
  it.each(cases)('%s', (_n, env) => {
    const output: string[] = [];
    expect(() =>
      loadConfigOrExit(() => loadConfig({ DATABASE_URL: 'postgres://u:p@localhost/db', ...env }), {
        error: (m) => void output.push(m),
        exit: (): never => {
          throw new Error('exit');
        },
      }),
    ).toThrow('exit');
    const text = output.join('\n');
    expect(text).not.toBe('');
    for (const s of [SENTINEL_SECRET, SENTINEL_HASH, SENTINEL_SECRET.slice(0, 20), TEST_ADMIN_PASSWORD_HASH, TEST_SESSION_SECRET]) {
      expect(text).not.toContain(s);
    }
  });
});

describe('search and context: queries, content and provider errors stay out of logs and errors', () => {
  const SENTINEL_QUERY = 'SENTINEL-query-text-6d12';
  const SENTINEL_PROVIDER = 'SENTINEL-provider-error-0b77';
  const SENTINEL_CONTENT = 'SENTINEL-chunk-content-a41e';

  it('context and search responses, errors and logs never hold them, and the budget holds', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@localhost:5432/db');
    for (const [k, v] of Object.entries({ ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) vi.stubEnv(k, v);
    const lines: string[] = [];
    const push = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const logger: LoggerService = { log: push, error: push, warn: push, debug: push, verbose: push, fatal: push };
    const embed = vi.fn(async () => {
      throw new Error(SENTINEL_PROVIDER);
    });
    const row = {
      id: 'c1', content: `${SENTINEL_CONTENT}. More text.`, ordinal: 0, location: {}, file_id: 'f1', file_name: 'a.md', collection_id: null,
      scope: 'global', workspace_id: null, workspace_slug: null,
    };
    const manager = { query: vi.fn(async (sql: string) => (/pg_extension/.test(sql) ? [{ extversion: '0.8.0' }] : /FROM "chunks"/.test(sql) ? [row] : [])) };
    const ds = { query: async () => [{ x: 1 }], transaction: async (fn: (m: unknown) => unknown) => fn(manager) };
    @Module({
      imports: [ConfigModule, EventEmitterModule.forRoot()],
      controllers: [SearchController],
      providers: [
        { provide: CLOCK, useValue: systemClock }, AuthService, LoginRateLimiter, SessionGuard,
        { provide: APP_GUARD, useExisting: SessionGuard }, { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
        { provide: ApiKeyStore, useValue: { findByKey: async () => null, touchLastUsed: async () => false } },
        AuthorizationService, { provide: getDataSourceToken(), useValue: ds },
        { provide: EMBEDDING_SERVICE, useValue: Object.assign(new FakeEmbeddingService(1536), { embed }) },
        RetrievalService, SearchService, RelatedMemoriesService,
      ],
    })
    class Root {}
    const a = await createApp(Root, { trustProxy: false }, logger);
    await a.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(a.getHttpServer().address() as AddressInfo).port}`;
    const cookie = `${SESSION_COOKIE_NAME}=${a.get(AuthService).issueSessionToken()}`;
    try {
      const seen: string[] = [];
      for (const [path, body] of [
        ['/api/global/context', { query: SENTINEL_QUERY, maxChars: 900 }],
        ['/api/global/context', { query: SENTINEL_QUERY, maxChars: 3 }],
        ['/api/global/context', { query: SENTINEL_QUERY, [SENTINEL_QUERY]: 1 }],
        ['/api/global/search', { query: SENTINEL_QUERY }],
      ] as const) {
        const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
        const text = await res.text();
        seen.push(text, [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n'));
        if (path.endsWith('context') && res.status === 200) expect(JSON.parse(text).context.length).toBeLessThanOrEqual(900);
      }
      const haystack = [...seen, ...lines].join('\n');
      for (const s of [SENTINEL_QUERY, SENTINEL_PROVIDER]) expect(haystack).not.toContain(s);
      // The retrieved content is the one thing a successful response is meant to carry.
      expect(seen[0]).toContain(SENTINEL_CONTENT);
      expect(lines.join('\n')).not.toContain(SENTINEL_CONTENT);
      expect(embed).toHaveBeenCalled();
    } finally {
      await a.close();
    }
  });
});

describe('/mcp: credentials, bodies and failures stay out of responses and logs', () => {
  it('never echoes a presented key, cookie, body or exception text, and logs nothing sensitive', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@localhost:5432/db');
    for (const [k, v] of Object.entries({ ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) vi.stubEnv(k, v);
    const lines: string[] = [];
    const push = (...a: unknown[]) => void lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const logger: LoggerService = { log: push, error: push, warn: push, debug: push, verbose: push, fatal: push };
    const SENTINEL_KEY = 'sk_seshat_SENTINEL0_keysecret-5e2a0123456789abcdefghijkl';
    const SENTINEL_MCP_BODY = 'SENTINEL-mcp-body-91c3';
    @Module({
      imports: [ConfigModule],
      controllers: [McpController],
      providers: [
        { provide: CLOCK, useValue: systemClock }, AuthService, LoginRateLimiter, SessionGuard,
        { provide: APP_GUARD, useExisting: SessionGuard }, { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
        { provide: ApiKeyStore, useValue: { findByKey: async () => { throw new Error(SENTINEL_DRIVER); }, touchLastUsed: async () => false } },
        AuthorizationService, McpService, { provide: MCP_TOOL_REGISTRY, useFactory: () => new McpToolRegistry() },
      ],
    })
    class Root {}
    const nest = await createApp(Root, { trustProxy: false }, logger);
    await nest.listen(0, '127.0.0.1');
    try {
      const base = `http://127.0.0.1:${(nest.getHttpServer().address() as AddressInfo).port}`;
      const cookie = `${SESSION_COOKIE_NAME}=${nest.get(AuthService).issueSessionToken()}`;
      const seen: string[] = [];
      for (const headers of [
        { authorization: `Bearer ${SENTINEL_KEY}` },
        { authorization: `Bearer ${SENTINEL_KEY}`, cookie },
        { cookie },
        {},
      ] as Record<string, string>[]) {
        for (const body of [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { note: SENTINEL_MCP_BODY } }), `{"x": "${SENTINEL_MCP_BODY}`]) {
          const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
          seen.push(await res.text(), [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n'));
          expect([401, 400]).toContain(res.status);
        }
      }
      const everything = `${seen.join('\n')}\n${lines.join('\n')}`;
      for (const sentinel of [SENTINEL_KEY, 'SENTINEL0', SENTINEL_MCP_BODY, SENTINEL_DRIVER, TEST_SESSION_SECRET, cookie.split('=')[1]!]) {
        expect(everything).not.toContain(sentinel);
      }
    } finally {
      await nest.close();
    }
  });
});
