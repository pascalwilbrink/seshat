import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Controller, Delete, Get, type INestApplication, Module, Patch, Post, Put } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';
import { catalogMismatches, expectedRouteStrings } from './helpers/scoped-endpoints.js';

/** A controller added by a hypothetical future feature, with no public marker of any kind. */
@Controller('future-feature')
class FutureController {
  @Get() list() { return []; }
  @Get(':id') one() { return {}; }
  @Post() create() { return {}; }
  @Put(':id') replace() { return {}; }
  @Patch(':id') update() { return {}; }
  @Delete(':id') remove() { return {}; }
}

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** Public method/path pairs. Hard-coded on purpose: this is the allowlist the spec fixes (AC-5). */
const EXPECTED_PUBLIC = ['GET /api/health', 'POST /api/auth/login'];

/** Every production route. Adding a route requires adding it here (and an authorization test for it). */
const EXPECTED_ROUTES: string[] = [
  'DELETE /api/global/collections/:collectionId',
  'DELETE /api/global/files/:fileId',
  'DELETE /api/global/memories/:memoryId',
  'DELETE /api/global/tags/:tagId',
  'DELETE /api/workspaces/:workspaceId',
  'DELETE /api/workspaces/:workspaceId/collections/:collectionId',
  'DELETE /api/workspaces/:workspaceId/files/:fileId',
  'DELETE /api/workspaces/:workspaceId/memories/:memoryId',
  'DELETE /api/workspaces/:workspaceId/tags/:tagId',
  // MCP: served at the root path (outside the /api prefix), API keys only, stateless: POST serves, GET and DELETE answer 405.
  'DELETE /mcp',
  'GET /api/auth/me',
  'GET /api/global/collections',
  'GET /api/global/collections/:collectionId',
  'GET /api/global/files',
  'GET /api/global/files/:fileId',
  'GET /api/global/files/:fileId/chunks',
  'GET /api/global/files/:fileId/download',
  'GET /api/global/memories',
  'GET /api/global/memories/:memoryId',
  'GET /api/global/memories/:memoryId/related',
  'GET /api/global/overview',
  'GET /api/global/tags',
  'GET /api/global/workspaces',
  'GET /api/health',
  'GET /api/workspaces/:workspaceId',
  'GET /api/workspaces/:workspaceId/api-keys',
  'GET /api/workspaces/:workspaceId/collections',
  'GET /api/workspaces/:workspaceId/collections/:collectionId',
  'GET /api/workspaces/:workspaceId/files',
  'GET /api/workspaces/:workspaceId/files/:fileId',
  'GET /api/workspaces/:workspaceId/files/:fileId/chunks',
  'GET /api/workspaces/:workspaceId/files/:fileId/download',
  'GET /api/workspaces/:workspaceId/memories',
  'GET /api/workspaces/:workspaceId/memories/:memoryId',
  'GET /api/workspaces/:workspaceId/memories/:memoryId/related',
  'GET /api/workspaces/:workspaceId/overview',
  'GET /api/workspaces/:workspaceId/tags',
  'GET /mcp',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/global/collections',
  'POST /api/global/context',
  'POST /api/global/files',
  'POST /api/global/files/:fileId/reindex',
  'POST /api/global/files/reindex',
  'POST /api/global/memories',
  'POST /api/global/memories/:memoryId/retry-embedding',
  'POST /api/global/memories/:memoryId/supersede',
  'POST /api/global/search',
  'POST /api/global/workspaces',
  'POST /api/workspaces/:workspaceId/api-keys',
  'POST /api/workspaces/:workspaceId/api-keys/:keyId/revoke',
  'POST /api/workspaces/:workspaceId/collections',
  'POST /api/workspaces/:workspaceId/context',
  'POST /api/workspaces/:workspaceId/files',
  'POST /api/workspaces/:workspaceId/files/:fileId/reindex',
  'POST /api/workspaces/:workspaceId/files/reindex',
  'POST /api/workspaces/:workspaceId/memories',
  'POST /api/workspaces/:workspaceId/memories/:memoryId/retry-embedding',
  'POST /api/workspaces/:workspaceId/memories/:memoryId/supersede',
  'POST /api/workspaces/:workspaceId/search',
  'POST /mcp',
  'PUT /api/global/collections/:collectionId',
  'PUT /api/global/files/:fileId',
  'PUT /api/global/memories/:memoryId',
  'PUT /api/global/tags/:tagId',
  'PUT /api/workspaces/:workspaceId',
  'PUT /api/workspaces/:workspaceId/api-keys/:keyId',
  'PUT /api/workspaces/:workspaceId/collections/:collectionId',
  'PUT /api/workspaces/:workspaceId/files/:fileId',
  'PUT /api/workspaces/:workspaceId/memories/:memoryId',
  'PUT /api/workspaces/:workspaceId/tags/:tagId',
];

let app: INestApplication;
let base: string;
let routes: { method: string; path: string }[];

async function fakeInitialize(ds: unknown) {
  const d = ds as { isInitialized: boolean; destroy: () => Promise<void> };
  d.isInitialized = true;
  (d as { query?: unknown }).query = async () => [{ '?column?': 1 }];
  d.destroy = async () => {
    d.isInitialized = false;
  };
  return ds;
}

beforeAll(async () => {
  vi.resetModules();
  for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) {
    vi.stubEnv(k, v);
  }
  vi.doMock('pg-boss', async () => (await import('./helpers/fake-pg-boss.js')).fakePgBossModule());
  vi.doMock('../src/database/bootstrap.js', () => ({ initializeDatabase: vi.fn(fakeInitialize) }));
  const { AppModule } = await import('../src/app.module.js');
  const { createApp } = await import('../src/app.setup.js');

  @Module({ imports: [AppModule], controllers: [FutureController] })
  class TestRoot {}

  // The same bootstrap configuration as main.ts (global prefix, body parser, proxy settings).
  app = await createApp(TestRoot, { trustProxy: false }, false);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  // Enumerate from the Express router that Nest registered every route on: no hand-maintained list.
  const express = app.getHttpAdapter().getInstance() as { router: { stack: Layer[] } };
  const found = new Set<string>();
  for (const layer of express.router.stack) {
    if (!layer.route) continue;
    // Nest registers a not-found handler for every path excluded from the global prefix (`/mcp`) on all HTTP methods.
    // It answers 404 for the methods no controller serves; it is no endpoint, so it is not listed.
    if (Object.values(layer.route.methods).filter(Boolean).length > 5) continue;
    for (const [method, on] of Object.entries(layer.route.methods)) {
      if (on) found.add(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  routes = [...found].sort().map((s) => {
    const [method, path] = s.split(' ') as [string, string];
    return { method, path };
  });
});

afterAll(async () => {
  await app?.close();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const materialize = (path: string) => path.replace(/:[A-Za-z0-9_]+/g, () => randomUUID());

async function call(method: string, path: string, extra: Record<string, string> = {}) {
  const hasBody = !['GET', 'HEAD'].includes(method);
  return fetch(`${base}${path}`, {
    method,
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...extra },
    // Valid-looking fixtures for every collection/resource route; authorization must fire before any validation.
    body: hasBody ? JSON.stringify({ name: 'Fixture', slug: 'fixture', description: 'x', username: 'a', password: 'b' }) : undefined,
  });
}

describe('default-deny route coverage', () => {
  it('discovers the application routes, including the test-only controller', () => {
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    expect(keys).toEqual(expect.arrayContaining(EXPECTED_PUBLIC));
    expect(keys).toContain('GET /api/auth/me');
    expect(keys).toContain('POST /api/auth/logout');
    expect(keys).toContain('GET /api/global/workspaces');
    expect(keys).toContain('GET /api/workspaces/:workspaceId');
    // Prefixes are applied and the test-only controller (no public metadata) is part of the enumeration.
    expect(routes.every((r) => r.path.startsWith('/api/') || r.path === '/mcp')).toBe(true);
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(keys.some((k) => k.startsWith(`${m} /api/future-feature`))).toBe(true);
    }
  });

  it('registers exactly the known production routes: no new route, public or not, appeared unnoticed', () => {
    const production = routes.filter((r) => !r.path.startsWith('/api/future-feature')).map((r) => `${r.method} ${r.path}`);
    expect(production).toEqual(EXPECTED_ROUTES);
    // Key transport is create-only: every other key route is listed without a secret-bearing counterpart.
    expect(production.filter((r) => r.includes('/api-keys'))).toEqual([
      'GET /api/workspaces/:workspaceId/api-keys',
      'POST /api/workspaces/:workspaceId/api-keys',
      'POST /api/workspaces/:workspaceId/api-keys/:keyId/revoke',
      'PUT /api/workspaces/:workspaceId/api-keys/:keyId',
    ]);
    // No Global key-management route and no unauthenticated key route.
    expect(production.some((r) => r.includes('/global/') && r.includes('api-keys'))).toBe(false);
    expect(EXPECTED_PUBLIC.every((r) => !r.includes('api-keys'))).toBe(true);
  });

  it('the HTTP isolation matrix enumerates exactly the Files, Collections and Tags routes that are registered', () => {
    const scoped = (r: string) => /\/api\/(global|workspaces\/:workspaceId)\/(files|collections|tags)(\/|$)/.test(r);
    const production = routes.filter((r) => !r.path.startsWith('/api/future-feature')).map((r) => `${r.method} ${r.path}`).filter(scoped).sort();
    expect(production).toEqual(expectedRouteStrings());
    expect(catalogMismatches()).toEqual([]);
  });

  it('refuses every Files/Collections/Tags route without credentials, never echoing hostile ids, bodies or names', async () => {
    const SENTINEL = 'SENTINEL-hostile-9f3a';
    for (const route of expectedRouteStrings()) {
      const [method, tpl] = route.split(' ') as [string, string];
      const p = tpl.replace(':workspaceId', SENTINEL).replace(/:[A-Za-z]+/g, SENTINEL);
      const res = await fetch(`${base}${p}?name=${SENTINEL}&tag=${SENTINEL}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({ name: SENTINEL, tags: [SENTINEL] }),
      });
      const text = await res.text();
      expect(res.status, route).toBe(401);
      expect(text, route).not.toContain(SENTINEL);
      expect(res.headers.getSetCookie(), route).toEqual([]);
    }
  });

  it('answers 401 without a session for every registered route except the two public ones', async () => {
    const publicSeen: string[] = [];
    for (const { method, path } of routes) {
      const key = `${method} ${path}`;
      const res = await call(method, materialize(path));
      await res.text();
      if (EXPECTED_PUBLIC.includes(key)) {
        publicSeen.push(key);
        expect(res.status, key).not.toBe(401);
      } else {
        expect(res.status, key).toBe(401);
        expect(res.headers.getSetCookie(), key).toEqual([]);
      }
    }
    expect(publicSeen.sort()).toEqual([...EXPECTED_PUBLIC].sort());
  });

  it('answers 401 for every protected route with an invalid bearer key, and 400 when a cookie is sent as well', async () => {
    const bearer = { authorization: 'Bearer not-an-api-key' } // malformed: rejected before any storage lookup (this harness has no database);
    for (const { method, path } of routes) {
      if (EXPECTED_PUBLIC.includes(`${method} ${path}`)) continue;
      const res = await call(method, materialize(path), bearer);
      await res.text();
      expect(res.status, `${method} ${path}`).toBe(401);
      const both = await call(method, materialize(path), { ...bearer, cookie: 'seshat_session=x' });
      await both.text();
      // `/mcp` accepts keys only: a cookie next to a key is a plain 401 there, not an ambiguity error.
      expect(both.status, `${method} ${path}`).toBe(path === '/mcp' ? 401 : 400);
    }
  });

  it('/mcp is default-deny: 401 with a Bearer challenge for missing, malformed and cookie credentials, never public', async () => {
    expect(EXPECTED_PUBLIC.some((r) => r.includes('/mcp'))).toBe(false);
    for (const extra of [{}, { authorization: 'Bearer not-an-api-key' }, { cookie: 'seshat_session=x' }, { authorization: 'Bearer x', cookie: 'seshat_session=x' }]) {
      for (const method of ['POST', 'GET', 'DELETE']) {
        const res = await call(method, '/mcp', extra);
        await res.text();
        expect(res.status, `${method} ${JSON.stringify(extra)}`).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
      }
    }
  });

  it('health is reachable unauthenticated and login is only a POST', async () => {
    expect((await call('GET', '/api/health')).status).toBe(200);
    expect((await call('GET', '/api/auth/login')).status).toBe(404);
  });

  it('protects nonexistent Workspace paths, logout and me', async () => {
    const id = randomUUID();
    for (const [m, p] of [
      ['GET', `/api/workspaces/${id}`],
      ['PUT', `/api/workspaces/${id}`],
      ['DELETE', `/api/workspaces/${id}`],
      ['GET', `/api/workspaces/${id}/overview`],
      ['GET', '/api/workspaces/not-a-uuid'],
      ['POST', '/api/auth/logout'],
      ['GET', '/api/auth/me'],
    ] as const) {
      const res = await call(m, p);
      expect(res.status, `${m} ${p}`).toBe(401);
    }
  });

  it('protects method variants and path spelling variants of registered routes', async () => {
    const id = randomUUID();
    for (const p of [`/api/workspaces/${id}`, `/api/workspaces/${id}/`, '/api/auth/me/', '/api/future-feature/', '/api/future-feature/x/']) {
      for (const m of ['GET', 'HEAD']) {
        const res = await call(m, p);
        expect(res.status, `${m} ${p}`).toBe(401);
      }
    }
    // Case, dot-segment and encoded variants never reach a public handler or a protected one without a session.
    for (const p of ['/API/health', '/api//health', '/api/health/x', '/api/auth/me%2F']) {
      const res = await call('GET', p);
      expect([401, 404], p).toContain(res.status);
    }
  });

  it('rejects invalid, tampered and empty session cookies on every protected route', async () => {
    for (const cookie of ['seshat_session=garbage', 'seshat_session=', 'seshat_session=v1.e30.AAAA', 'other=1']) {
      for (const { method, path } of routes) {
        if (EXPECTED_PUBLIC.includes(`${method} ${path}`)) continue;
        const res = await call(method, materialize(path), { cookie });
        await res.text();
        expect(res.status, `${method} ${path} ${cookie}`).toBe(401);
      }
    }
  });
});
