import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Controller, Delete, Get, type INestApplication, Module, Patch, Post, Put } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';

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
  'DELETE /api/workspaces/:workspaceId',
  'GET /api/auth/me',
  'GET /api/global/overview',
  'GET /api/global/workspaces',
  'GET /api/health',
  'GET /api/workspaces/:workspaceId',
  'GET /api/workspaces/:workspaceId/api-keys',
  'GET /api/workspaces/:workspaceId/overview',
  'PATCH /api/workspaces/:workspaceId',
  'PATCH /api/workspaces/:workspaceId/api-keys/:keyId',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/global/workspaces',
  'POST /api/workspaces/:workspaceId/api-keys',
  'POST /api/workspaces/:workspaceId/api-keys/:keyId/revoke',
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
    expect(routes.every((r) => r.path.startsWith('/api/'))).toBe(true);
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
      'PATCH /api/workspaces/:workspaceId/api-keys/:keyId',
      'POST /api/workspaces/:workspaceId/api-keys',
      'POST /api/workspaces/:workspaceId/api-keys/:keyId/revoke',
    ]);
    // No Global key-management route and no unauthenticated key route.
    expect(production.some((r) => r.includes('/global/') && r.includes('api-keys'))).toBe(false);
    expect(EXPECTED_PUBLIC.every((r) => !r.includes('api-keys'))).toBe(true);
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
      expect(both.status, `${method} ${path}`).toBe(400);
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
      ['PATCH', `/api/workspaces/${id}`],
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
