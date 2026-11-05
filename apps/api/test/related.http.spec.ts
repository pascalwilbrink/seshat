import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Permission } from '@seshat/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.setup.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthorizationService } from '../src/auth/authorization.service.js';
import { CLOCK, LoginRateLimiter, systemClock } from '../src/auth/login-rate-limiter.js';
import { SESSION_COOKIE_NAME } from '../src/auth/session-token.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { ApiKeyStore } from '../src/api-keys/api-key.store.js';
import { SanitizedExceptionFilter } from '../src/common/sanitized-exception.filter.js';
import { ConfigModule } from '../src/config/config.module.js';
import { RelatedMemoriesService } from '../src/search/related.service.js';
import { RetrievalService } from '../src/search/retrieval.service.js';
import { SearchController } from '../src/search/search.controller.js';
import { SearchService } from '../src/search/search.service.js';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';
import { MemoryKeyStore } from './helpers/security-app.js';

const WS = randomUUID();
const OTHER_WS = randomUUID();
const KNOWN = new Set([WS, OTHER_WS]);
const SEED = randomUUID();

/** Statements the service ran, in order; the seed lookup answers per scope key so a foreign seed is "missing". */
const sql: { text: string; params: unknown[] }[] = [];
const embed = vi.fn();
const manager = {
  query: vi.fn(async (text: string, params: unknown[] = []) => {
    sql.push({ text, params });
    if (/set_config/.test(text)) return [];
    if (/extversion/.test(text)) return [{ extversion: '0.8.0' }];
    if (/"embedding"::text AS vector/.test(text)) return params[0] === SEED && (params[1] as string[]).includes(WS) ? [{ id: SEED, vector: '[1,0]' }] : [];
    return [];
  }),
};
const dataSource = {
  query: vi.fn(async (_t: string, params: unknown[]) => (KNOWN.has(String(params[0])) ? [{ '?column?': 1 }] : [])),
  transaction: vi.fn(async (fn: (m: unknown) => unknown) => fn(manager)),
};

let app: INestApplication;
let base: string;
let adminCookie: string;
const keys = new MemoryKeyStore();

beforeAll(async () => {
  for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) vi.stubEnv(k, v);
  @Module({
    imports: [ConfigModule, EventEmitterModule.forRoot()],
    controllers: [SearchController],
    providers: [
      { provide: CLOCK, useValue: systemClock },
      AuthService,
      LoginRateLimiter,
      SessionGuard,
      { provide: APP_GUARD, useExisting: SessionGuard },
      { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
      { provide: ApiKeyStore, useValue: keys },
      AuthorizationService,
      { provide: getDataSourceToken(), useValue: dataSource },
      { provide: RetrievalService, useValue: { retrieve: embed, vectorVersion: async () => '0.8.0' } },
      { provide: SearchService, useValue: {} },
      RelatedMemoriesService,
    ],
  })
  class Root {}
  app = await createApp(Root, { trustProxy: false }, false);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  adminCookie = `${SESSION_COOKIE_NAME}=${app.get(AuthService).issueSessionToken()}`;
});
afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  sql.length = 0;
  manager.query.mockClear();
  dataSource.transaction.mockClear();
  embed.mockClear();
});

const get = async (path: string, auth: { admin?: true; bearer?: string } = { admin: true }) => {
  const res = await fetch(`${base}${path}`, {
    headers: { ...(auth.admin ? { cookie: adminCookie } : {}), ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}) },
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, any>) : null, headers: res.headers };
};
const keyFor = async (workspaceId: string, permissions: readonly Permission[]) => (await keys.create({ workspaceId, name: 'k', permissions })).secret;
const ws = (id = WS, seed = SEED, qs = '') => `/api/workspaces/${id}/memories/${seed}/related${qs}`;
const glob = (seed = SEED, qs = '') => `/api/global/memories/${seed}/related${qs}`;
const nearest = () => sql.find((s) => /ORDER BY/.test(s.text));

describe('GET memories/:id/related', () => {
  it('applies defaults, sends no-store, never embeds a query and returns an empty page for a seed without neighbours', async () => {
    const res = await get(ws());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ results: [] });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(embed).not.toHaveBeenCalled();
    const q = nearest()!;
    expect(q.text).toMatch(/"status" = 'active'/);
    expect(q.text).toMatch(/"embedding" IS NOT NULL/);
    expect(q.text).toMatch(/"id" <> /);
    expect(q.params).toEqual(expect.arrayContaining([[String(WS)], SEED, 10]));
  });

  it('passes limit, repeated type filters and includeGlobal into the candidate query only', async () => {
    const res = await get(ws(WS, SEED, '?limit=50&type=fact&type=decision&includeGlobal=true'));
    expect(res.status).toBe(200);
    const q = nearest()!;
    expect(q.params).toEqual(expect.arrayContaining([[WS, 'global'], ['fact', 'decision'], 50]));
    // The seed lookup stays in the route scope even when Global is expanded.
    const seed = sql.find((s) => /AS vector/.test(s.text))!;
    expect(seed.params).toEqual([SEED, [WS]]);
  });

  it('rejects invalid queries with a 400 that does not echo values', async () => {
    const S = 'SENTINEL-hostile-77';
    for (const qs of ['?limit=0', '?limit=51', '?limit=abc', `?limit=${S}`, '?type=rumour', `?${S}=1`, '?includeGlobal=yes']) {
      const res = await get(ws(WS, SEED, qs));
      expect(res.status, qs).toBe(400);
      expect(res.text).not.toContain(S);
    }
    expect((await get(glob(SEED, '?includeGlobal=true'))).status).toBe(400);
    expect(sql).toEqual([]);
  });

  it('a missing, malformed, foreign-scope or Global seed id gives the identical 404 body', async () => {
    const missing = await get(ws(WS, randomUUID()));
    const malformed = await get(ws(WS, 'not-a-uuid'));
    const wrongRoute = await get(ws(OTHER_WS, SEED)); // exists, but in another Workspace
    const globalRoute = await get(glob(SEED)); // seed lives in WS, not Global
    for (const r of [missing, malformed, wrongRoute, globalRoute]) {
      expect(r.status).toBe(404);
      expect(r.text).toBe(missing.text);
    }
    expect((await get(ws(randomUUID(), SEED))).status).toBe(404);
  });

  it('API key: needs search AND memories:read (plus global:read for expansion) and authorizes before any lookup', async () => {
    const cases: [Permission[], string, string][] = [
      [['memories:read'], ws(), 'Missing permission: search'],
      [['search'], ws(), 'Missing permission: memories:read'],
      [['search', 'memories:read'], ws(WS, SEED, '?includeGlobal=true'), 'Missing permission: global:read'],
    ];
    for (const [perms, path, message] of cases) {
      const res = await get(path, { bearer: await keyFor(WS, perms) });
      expect(res.status).toBe(403);
      expect(res.json?.message).toBe(message);
    }
    expect(sql).toEqual([]);
    expect(dataSource.query).not.toHaveBeenCalledWith(expect.stringContaining('workspaces'), [SEED]);
    const ok = await get(ws(), { bearer: await keyFor(WS, ['search', 'memories:read']) });
    expect(ok.status).toBe(200);
    const expanded = await get(ws(WS, SEED, '?includeGlobal=true'), { bearer: await keyFor(WS, ['search', 'memories:read', 'global:read']) });
    expect(expanded.status).toBe(200);
  });

  it('API key: another Workspace and the Global route without a grant never reveal the seed', async () => {
    const key = await keyFor(WS, ['search', 'memories:read']);
    const foreign = await get(ws(OTHER_WS), { bearer: key });
    expect(foreign.status).toBe(404);
    const noGlobal = await get(glob(), { bearer: key });
    expect([403, 404]).toContain(noGlobal.status);
    expect(noGlobal.text).not.toContain(SEED);
    expect(sql).toEqual([]);
  });

  it('requires a session or key', async () => {
    expect((await get(ws(), {})).status).toBe(401);
    expect((await get(glob(), {})).status).toBe(401);
  });
});
