import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getDataSourceToken } from '@nestjs/typeorm';
import { PERMISSIONS, type Permission } from '@seshat/domain';
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
import { FakeEmbeddingService } from '../src/ingestion/fake-embedding.service.js';
import { EMBEDDING_SERVICE } from '../src/ingestion/embedding.service.js';
import { RetrievalService } from '../src/search/retrieval.service.js';
import { SearchController } from '../src/search/search.controller.js';
import { SearchService } from '../src/search/search.service.js';
import type { SearchResponse } from '../src/search/search-result.dto.js';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';
import { MemoryKeyStore } from './helpers/security-app.js';

const WS = randomUUID();
const OTHER_WS = randomUUID();
const KNOWN = new Set([WS, OTHER_WS]);

/** Records every retrieval call; `response` is what a successful retrieval returns. */
const retrieval = {
  calls: [] as { plan: { scopes: unknown[]; types: string[] }; request: Record<string, unknown> }[],
  response: { results: [] } as SearchResponse,
  retrieve: vi.fn(async (plan: never, request: never) => {
    retrieval.calls.push({ plan, request } as never);
    return retrieval.response;
  }),
};

const dataSource = { query: vi.fn(async (_sql: string, params: unknown[]) => (KNOWN.has(String(params[0])) ? [{ '?column?': 1 }] : [])) };

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
      { provide: RetrievalService, useValue: retrieval },
      SearchService,
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
  retrieval.calls.length = 0;
  retrieval.retrieve.mockClear();
  retrieval.response = { results: [] };
});

const post = async (path: string, body: unknown, auth: { admin?: true; bearer?: string } = { admin: true }) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth.admin ? { cookie: adminCookie } : {}), ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, any>) : null, headers: res.headers };
};
const keyFor = async (workspaceId: string, permissions: readonly Permission[]) => (await keys.create({ workspaceId, name: 'k', permissions })).secret;
const wsPath = (id = WS) => `/api/workspaces/${id}/search`;
const GLOBAL = '/api/global/search';

describe('POST search: contract, defaults and filters', () => {
  for (const [label, path] of [['global', GLOBAL], ['workspace', wsPath()]] as const) {
    it(`${label}: applies defaults (both types, limit 10, includeGlobal false, any, no superseded)`, async () => {
      const res = await post(path, { query: '  needle  ' });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ results: [] });
      expect(res.headers.get('cache-control')).toBe('no-store');
      const [call] = retrieval.calls;
      expect(call!.request).toMatchObject({ query: 'needle', types: ['files', 'memories'], limit: 10, includeGlobal: false, tagMatch: 'any', includeSuperseded: false });
      expect(call!.request.minScore).toBeUndefined();
      expect(call!.plan.types).toEqual(['files', 'memories']);
      expect(call!.plan.scopes).toEqual([label === 'global' ? { kind: 'global' } : { kind: 'workspace', workspaceId: WS }]);
    });

    it(`${label}: passes every filter, limit and minScore to retrieval`, async () => {
      const [c1, c2, f1] = [randomUUID(), randomUUID(), randomUUID()];
      const res = await post(path, {
        query: 'q', types: ['memories'], collectionIds: [c1, c2.toUpperCase()], fileIds: [f1], tags: [' Alpha ', 'beta'], tagMatch: 'all',
        memoryTypes: ['fact', 'decision'], includeSuperseded: true, limit: 50, minScore: 0.02,
      });
      expect(res.status).toBe(200);
      expect(retrieval.calls[0]!.request).toMatchObject({
        types: ['memories'], collectionIds: [c1, c2], fileIds: [f1], tags: ['alpha', 'beta'], tagMatch: 'all',
        memoryTypes: ['fact', 'decision'], includeSuperseded: true, limit: 50, minScore: 0.02,
      });
    });

    it(`${label}: rejects invalid payloads with a 400 that never echoes values and never retrieves`, async () => {
      const S = 'SENTINEL-hostile-41d2';
      const bad: unknown[] = [
        {}, { query: '' }, { query: '   ' }, { query: 5 }, { query: 'x'.repeat(2001) },
        { query: 'x', types: [] }, { query: 'x', types: ['nope'] }, { query: 'x', limit: 0 }, { query: 'x', limit: 51 }, { query: 'x', limit: 1.5 },
        { query: 'x', minScore: 'high' }, { query: 'x', collectionIds: [S] }, { query: 'x', fileIds: [] }, { query: 'x', tagMatch: 'some' },
        { query: 'x', memoryTypes: ['rumour'] }, { query: 'x', includeSuperseded: 'yes' }, { query: 'x', [S]: 1 },
        `{"query":"${S}"`, '[]', 'null',
      ];
      if (label === 'global') bad.push({ query: 'x', includeGlobal: true });
      else bad.push({ query: 'x', includeGlobal: 'yes' });
      for (const body of bad) {
        const res = await post(path, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.text).not.toContain(S);
      }
      expect(retrieval.retrieve).not.toHaveBeenCalled();
    });
  }

  it('workspace: includeGlobal adds Global to the plan only when requested', async () => {
    await post(wsPath(), { query: 'q', includeGlobal: true });
    expect(retrieval.calls[0]!.plan.scopes).toEqual([{ kind: 'workspace', workspaceId: WS }, { kind: 'global' }]);
  });

  it('a malformed Workspace id is a 400 and an unknown Workspace is the generic 404 for the admin', async () => {
    expect((await post('/api/workspaces/not-a-uuid/search', { query: 'q' })).status).toBe(400);
    const missing = await post(wsPath(randomUUID()), { query: 'q' });
    expect(missing.status).toBe(404);
    expect(retrieval.retrieve).not.toHaveBeenCalled();
  });

  it('returns the DTO untouched: results and degraded only, no totals, counts or vectors', async () => {
    const result = { kind: 'chunk', id: randomUUID(), score: 0.03, vectorRank: 1, keywordRank: null, scope: { kind: 'global' }, content: 'c', file: { id: randomUUID(), name: 'a.md' }, collectionId: null, ordinal: 0, location: {} };
    retrieval.response = { results: [result as never], degraded: 'keyword_only' };
    const res = await post(GLOBAL, { query: 'q' });
    expect(res.json).toEqual({ results: [result], degraded: 'keyword_only' });
    expect(Object.keys(res.json!).sort()).toEqual(['degraded', 'results']);
    expect(res.text).not.toMatch(/total|count|excluded|embedding/i);
  });
});

describe('POST search: authorization happens before retrieval', () => {
  const FULL: Permission[] = ['search', 'files:read', 'memories:read'];

  it('API key: needs search plus every requested read grant, naming what is missing', async () => {
    const cases: [Permission[], Record<string, unknown>, string][] = [
      [['files:read', 'memories:read'], { query: 'q' }, 'Missing permission: search'],
      [['search', 'memories:read'], { query: 'q' }, 'Missing permission: files:read'],
      [['search', 'files:read'], { query: 'q' }, 'Missing permission: memories:read'],
      [['search'], { query: 'q' }, 'Missing permission: files:read, memories:read'],
      [['collections:read'], { query: 'q', types: ['memories'] }, 'Missing permission: search, memories:read'],
      [FULL, { query: 'q', includeGlobal: true }, 'Missing permission: global:read'],
    ];
    for (const [held, body, message] of cases) {
      const res = await post(wsPath(), body, { bearer: await keyFor(WS, held) });
      expect(res.status, message).toBe(403);
      expect(res.json!.message).toBe(message);
    }
    expect(retrieval.retrieve).not.toHaveBeenCalled();
  });

  it('API key: a single readable type is allowed when only that type is requested', async () => {
    const res = await post(wsPath(), { query: 'q', types: ['files'] }, { bearer: await keyFor(WS, ['search', 'files:read']) });
    expect(res.status).toBe(200);
    expect(retrieval.calls[0]!.plan.types).toEqual(['files']);
  });

  it('API key: Global search needs global:read; with every grant it is allowed, and Global is never implicit on a Workspace', async () => {
    const noGrant = await post(GLOBAL, { query: 'q' }, { bearer: await keyFor(WS, FULL) });
    expect(noGrant.status).toBe(403);
    expect(noGrant.json!.message).toBe('Missing permission: global:read');
    expect(retrieval.retrieve).not.toHaveBeenCalled();

    const key = await keyFor(WS, [...FULL, 'global:read']);
    expect((await post(GLOBAL, { query: 'q' }, { bearer: key })).status).toBe(200);
    await post(wsPath(), { query: 'q' }, { bearer: key });
    expect(retrieval.calls[1]!.plan.scopes).toEqual([{ kind: 'workspace', workspaceId: WS }]);
    await post(wsPath(), { query: 'q', includeGlobal: true }, { bearer: key });
    expect(retrieval.calls[2]!.plan.scopes).toEqual([{ kind: 'workspace', workspaceId: WS }, { kind: 'global' }]);
  });

  it('API key: another Workspace gives the same 404 as an unknown one, even without any permission, and never retrieves', async () => {
    const key = await keyFor(WS, PERMISSIONS);
    const weak = await keyFor(WS, ['collections:read']);
    const foreign = await post(wsPath(OTHER_WS), { query: 'q' }, { bearer: key });
    const unknown = await post(wsPath(randomUUID()), { query: 'q' }, { bearer: key });
    const weakForeign = await post(wsPath(OTHER_WS), { query: 'q' }, { bearer: weak });
    for (const r of [foreign, unknown, weakForeign]) {
      expect(r.status).toBe(404);
      expect(r.text).toBe(foreign.text);
    }
    expect(retrieval.retrieve).not.toHaveBeenCalled();
  });

  it('API key: authorization runs before body validation does any lookup, and denial bodies hold no query text', async () => {
    const S = 'SENTINEL-query-7be1';
    const res = await post(wsPath(), { query: S }, { bearer: await keyFor(WS, ['collections:read']) });
    expect(res.status).toBe(403);
    expect(res.text).not.toContain(S);
    expect(dataSource.query).not.toHaveBeenCalledWith(expect.anything(), [OTHER_WS]);
  });

  it('inaccessible Collection/file filter ids give exactly the response random ids give', async () => {
    const key = await keyFor(WS, FULL);
    const inaccessible = { collectionIds: [randomUUID()], fileIds: [randomUUID()] }; // e.g. ids of another Workspace
    const random = { collectionIds: [randomUUID()], fileIds: [randomUUID()] };
    const a = await post(wsPath(), { query: 'q', ...inaccessible }, { bearer: key });
    const b = await post(wsPath(), { query: 'q', ...random }, { bearer: key });
    expect(a.status).toBe(b.status);
    expect(a.text).toBe(b.text);
    // Filter ids are never looked up: only the Workspace existence check touches the database in this layer.
    expect(dataSource.query.mock.calls.every(([sql]) => /FROM "workspaces"/.test(String(sql)))).toBe(true);
  });

  it('unauthenticated calls are 401 and never retrieve', async () => {
    expect((await post(GLOBAL, { query: 'q' }, {})).status).toBe(401);
    expect((await post(wsPath(), { query: 'q' }, {})).status).toBe(401);
    expect(retrieval.retrieve).not.toHaveBeenCalled();
  });
});

describe('POST search: embedding provider failure (real RetrievalService)', () => {
  it('denied calls never embed; a failing provider degrades to keyword_only without leaking its message', async () => {
    const SECRET = 'SENTINEL-provider-error-5c0a';
    const embed = vi.fn(async () => {
      throw new Error(SECRET);
    });
    const fake = Object.assign(new FakeEmbeddingService(1536), { embed });
    const manager = { query: vi.fn(async (sql: string) => (/pg_extension/.test(sql) ? [{ extversion: '0.8.0' }] : [])) };
    const ds = { query: dataSource.query, transaction: async (fn: (m: unknown) => unknown) => fn(manager) };

    @Module({
      imports: [ConfigModule, EventEmitterModule.forRoot()],
      controllers: [SearchController],
      providers: [
        { provide: CLOCK, useValue: systemClock }, AuthService, LoginRateLimiter, SessionGuard,
        { provide: APP_GUARD, useExisting: SessionGuard }, { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
        { provide: ApiKeyStore, useValue: keys }, AuthorizationService, { provide: getDataSourceToken(), useValue: ds },
        { provide: EMBEDDING_SERVICE, useValue: fake }, RetrievalService, SearchService,
      ],
    })
    class Real {}
    const real = await createApp(Real, { trustProxy: false }, false);
    await real.listen(0, '127.0.0.1');
    const url = `http://127.0.0.1:${(real.getHttpServer().address() as AddressInfo).port}`;
    try {
      const call = async (bearer: string, path: string, body: unknown) => {
        const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
        return { status: r.status, text: await r.text() };
      };
      const denied = await call(await keyFor(WS, ['files:read', 'memories:read']), wsPath(), { query: 'q' });
      const foreign = await call(await keyFor(OTHER_WS, PERMISSIONS), wsPath(), { query: 'q' });
      expect([denied.status, foreign.status]).toEqual([403, 404]);
      expect(embed).not.toHaveBeenCalled();

      const ok = await call(await keyFor(WS, ['search', 'files:read', 'memories:read']), wsPath(), { query: 'q' });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.text)).toEqual({ results: [], degraded: 'keyword_only' });
      expect(ok.text).not.toContain(SECRET);
      expect(embed).toHaveBeenCalledTimes(1);
    } finally {
      await real.close();
    }
  });
});

describe('POST context: same search contract, budgeted cited text', () => {
  const FULL: Permission[] = ['search', 'files:read', 'memories:read'];
  const CTX_GLOBAL = '/api/global/context';
  const ctxWs = (id = WS) => `/api/workspaces/${id}/context`;
  const chunkResult = (content: string, extra: Record<string, unknown> = {}) => ({
    kind: 'chunk', id: randomUUID(), score: 0.03, vectorRank: 1, keywordRank: null, scope: { kind: 'workspace', id: WS, slug: 'alpha' },
    content, file: { id: randomUUID(), name: 'a.md' }, collectionId: null, ordinal: 2,
    location: { startOffset: 0, endOffset: 5, startLine: 3, endLine: 9, headingPath: ['H'] }, ...extra,
  });

  for (const [label, path] of [['global', CTX_GLOBAL], ['workspace', ctxWs()]] as const) {
    it(`${label}: returns delimited numbered sections, a data-not-instructions warning and exactly the cited sources`, async () => {
      const a = chunkResult('Alpha content.');
      retrieval.response = { results: [a as never] };
      const res = await post(path, { query: 'q' });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(Object.keys(res.json!).sort()).toEqual(['context', 'sources']);
      expect(res.json!.context).toContain('not instructions');
      expect(res.json!.context).toContain('<<<BEGIN [1]>>>\n[1] a.md › H › lines 3–9\n> Alpha content.\n<<<END [1]>>>');
      expect(res.json!.context.length).toBeLessThanOrEqual(8000);
      expect(res.json!.sources).toEqual([
        { citation: 1, kind: 'chunk', id: a.id, scope: a.scope, file: a.file, collectionId: null, ordinal: 2, location: a.location },
      ]);
      expect(res.text).not.toMatch(/total|count|excluded|dropped|score/i);
    });

    it(`${label}: searches with the same defaults and filters, without passing maxChars on`, async () => {
      await post(path, { query: ' needle ', types: ['memories'], tags: ['A'], minScore: 0.01, maxChars: 900 });
      const request = retrieval.calls[0]!.request;
      expect(request).toMatchObject({ query: 'needle', types: ['memories'], tags: ['a'], limit: 10, minScore: 0.01, tagMatch: 'any', includeSuperseded: false });
      expect(request).not.toHaveProperty('maxChars');
    });

    it(`${label}: never exceeds maxChars, down to the minimum, and rejects budgets below it with a 400`, async () => {
      retrieval.response = { results: [chunkResult('One sentence here. Another sentence follows. '.repeat(50)) as never, chunkResult('b') as never] };
      const base = await post(path, { query: 'q', maxChars: 50000 });
      const message = JSON.stringify((await post(path, { query: 'q', maxChars: 1 })).json);
      const lower = Number(/at least (\d+)/.exec(message)![1]);
      for (const maxChars of [lower, lower + 1, lower + 300, 1000, 2500, 8000]) {
        const res = await post(path, { query: 'q', maxChars });
        expect(res.status, String(maxChars)).toBe(200);
        expect(res.json!.context.length).toBeLessThanOrEqual(maxChars);
        expect(res.json!.sources.length).toBe((res.json!.context.match(/<<<BEGIN \[/g) ?? []).length);
      }
      expect(base.json!.sources).toHaveLength(2);
      for (const maxChars of [lower - 1, 0, -1, 50001, 1.5, '8000']) expect((await post(path, { query: 'q', maxChars })).status).toBe(400);
      expect((await post(path, { query: 'q', maxChars: 50000 })).status).toBe(200);
    });

    it(`${label}: no results is a warning-only block with no sources`, async () => {
      const res = await post(path, { query: 'q', maxChars: 50000 });
      expect(res.json!.sources).toEqual([]);
      expect(res.json!.context).toContain('not instructions');
    });

    it(`${label}: keeps the search validation (strict body, no values echoed, no retrieval)`, async () => {
      const S = 'SENTINEL-ctx-9f31';
      for (const body of [{ query: '' }, { query: 'x', limit: 51 }, { query: 'x', [S]: 1 }, { query: 'x', types: [] }, label === 'global' ? { query: 'x', includeGlobal: true } : { query: 'x', includeGlobal: 'y' }]) {
        const res = await post(path, body);
        expect(res.status).toBe(400);
        expect(res.text).not.toContain(S);
      }
      expect(retrieval.retrieve).not.toHaveBeenCalled();
    });
  }

  it('carries the degraded marker over and shows no provider detail', async () => {
    retrieval.response = { results: [chunkResult('c') as never], degraded: 'keyword_only' };
    const res = await post(ctxWs(), { query: 'q' });
    expect(res.json!.degraded).toBe('keyword_only');
    expect(Object.keys(res.json!).sort()).toEqual(['context', 'degraded', 'sources']);
  });

  it('truncating drops later sources from the list too, and nothing about them is serialized', async () => {
    const dropped = chunkResult('DROPPED-SENTINEL', { file: { id: randomUUID(), name: 'hidden-name.md' } });
    retrieval.response = { results: [chunkResult('First. '.repeat(400)) as never, dropped as never] };
    const res = await post(ctxWs(), { query: 'q', maxChars: 1200 });
    expect(res.json!.sources).toHaveLength(1);
    expect(res.text).not.toContain('DROPPED-SENTINEL');
    expect(res.text).not.toContain('hidden-name.md');
    expect(res.text).not.toContain(dropped.id);
  });

  it('API key: the same permission matrix as search, naming what is missing, before any retrieval', async () => {
    const cases: [Permission[], Record<string, unknown>, string][] = [
      [['files:read', 'memories:read'], { query: 'q' }, 'Missing permission: search'],
      [['search', 'memories:read'], { query: 'q' }, 'Missing permission: files:read'],
      [['search', 'files:read'], { query: 'q' }, 'Missing permission: memories:read'],
      [['search'], { query: 'q' }, 'Missing permission: files:read, memories:read'],
      [FULL, { query: 'q', includeGlobal: true }, 'Missing permission: global:read'],
    ];
    for (const [held, body, message] of cases) {
      const res = await post(ctxWs(), body, { bearer: await keyFor(WS, held) });
      expect(res.status, message).toBe(403);
      expect(res.json!.message).toBe(message);
    }
    const noGrant = await post(CTX_GLOBAL, { query: 'q' }, { bearer: await keyFor(WS, FULL) });
    expect([noGrant.status, noGrant.json!.message]).toEqual([403, 'Missing permission: global:read']);
    expect(retrieval.retrieve).not.toHaveBeenCalled();
  });

  it('API key: a single readable type, Global with the grant, and Global never implicit', async () => {
    expect((await post(ctxWs(), { query: 'q', types: ['files'] }, { bearer: await keyFor(WS, ['search', 'files:read']) })).status).toBe(200);
    expect(retrieval.calls[0]!.plan.types).toEqual(['files']);
    const key = await keyFor(WS, [...FULL, 'global:read']);
    expect((await post(CTX_GLOBAL, { query: 'q' }, { bearer: key })).status).toBe(200);
    await post(ctxWs(), { query: 'q' }, { bearer: key });
    await post(ctxWs(), { query: 'q', includeGlobal: true }, { bearer: key });
    expect(retrieval.calls[2]!.plan.scopes).toEqual([{ kind: 'workspace', workspaceId: WS }]);
    expect(retrieval.calls[3]!.plan.scopes).toEqual([{ kind: 'workspace', workspaceId: WS }, { kind: 'global' }]);
  });

  it('API key: another Workspace equals an unknown one, byte for byte, and inaccessible filter ids equal random ids', async () => {
    const key = await keyFor(WS, PERMISSIONS);
    const foreign = await post(ctxWs(OTHER_WS), { query: 'q' }, { bearer: key });
    const unknown = await post(ctxWs(randomUUID()), { query: 'q' }, { bearer: key });
    expect([foreign.status, unknown.status]).toEqual([404, 404]);
    expect(unknown.text).toBe(foreign.text);
    const a = await post(ctxWs(), { query: 'q', collectionIds: [randomUUID()], fileIds: [randomUUID()] }, { bearer: key });
    const b = await post(ctxWs(), { query: 'q', collectionIds: [randomUUID()], fileIds: [randomUUID()] }, { bearer: key });
    expect(a.text).toBe(b.text);
    expect(retrieval.calls).toHaveLength(2);
  });

  it('unauthenticated calls are 401', async () => {
    expect((await post(CTX_GLOBAL, { query: 'q' }, {})).status).toBe(401);
    expect((await post(ctxWs(), { query: 'q' }, {})).status).toBe(401);
  });
});
