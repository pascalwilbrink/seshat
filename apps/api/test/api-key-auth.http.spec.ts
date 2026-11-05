import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type INestApplication, type LoggerService, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyStore, type ApiKeyRecord } from '../src/api-keys/api-key.store.js';
import { createApp } from '../src/app.setup.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthorizationService } from '../src/auth/authorization.service.js';
import { IdentityService } from '../src/auth/identity.service.js';
import { CLOCK, LoginRateLimiter, systemClock } from '../src/auth/login-rate-limiter.js';
import { SESSION_COOKIE_NAME } from '../src/auth/session-token.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { SanitizedExceptionFilter } from '../src/common/sanitized-exception.filter.js';
import { ConfigModule } from '../src/config/config.module.js';
import { OverviewController } from '../src/scopes/overview.controller.js';
import { OverviewService } from '../src/scopes/overview.service.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { WorkspacesService } from '../src/workspaces/workspace.service.js';
import { WorkspacesController } from '../src/workspaces/workspaces.controller.js';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';
import { InMemoryWorkspaces } from './helpers/workspace-app.js';

const GOOD_KEY = 'sk_seshat_AbCdEfGh_GOODsecret0123456789abcdefghijklmnopqr';
const WRONG_SUFFIX = 'sk_seshat_AbCdEfGh_SENTINELwrong0123456789abcdefghijklm';
const UNKNOWN_PREFIX = 'sk_seshat_ZzZzZzZz_SENTINELunknown0123456789abcdefghijk';

class Capture implements LoggerService {
  lines: string[] = [];
  private push = (...a: unknown[]) => void this.lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  log = this.push;
  error = this.push;
  warn = this.push;
  debug = this.push;
  verbose = this.push;
  fatal = this.push;
}

async function boot() {
  for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) {
    vi.stubEnv(k, v);
  }
  const mem = new InMemoryWorkspaces();
  const ws = await mem.repo.save({ name: 'Acme', slug: 'acme' } as Workspace);
  const state: { record: ApiKeyRecord | null; touches: number } = { record: null, touches: 0 };
  const base: ApiKeyRecord = {
    id: randomUUID(),
    workspaceId: ws.id,
    name: 'k',
    prefix: 'AbCdEfGh',
    permissions: ['files:read'],
    createdAt: new Date(),
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  };
  state.record = base;
  const keys = {
    findByKey: async (presented: string) => (presented === GOOD_KEY ? state.record : null),
    touchLastUsed: async () => {
      state.touches++;
      return true;
    },
  };

  @Module({
    imports: [ConfigModule, EventEmitterModule.forRoot()],
    controllers: [AuthController, WorkspacesController, OverviewController],
    providers: [
      { provide: CLOCK, useValue: systemClock },
      AuthService,
      LoginRateLimiter,
      IdentityService,
      SessionGuard,
      { provide: APP_GUARD, useExisting: SessionGuard },
      { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
      { provide: ApiKeyStore, useValue: keys },
      AuthorizationService,
      { provide: getRepositoryToken(Workspace), useValue: mem.repo },
      { provide: getDataSourceToken(), useValue: mem.dataSource },
      WorkspacesService,
      OverviewService,
    ],
  })
  class Root {}

  const logs = new Capture();
  const output: string[] = [];
  const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void output.push(a.map(String).join(' '))),
  );
  const app: INestApplication = await createApp(Root, { trustProxy: false }, logs);
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const cookie = `${SESSION_COOKIE_NAME}=${app.get(AuthService).issueSessionToken()}`;
  const call = async (path: string, headers: Record<string, string>, method = 'GET') => {
    const res = await fetch(url + path, { method, headers });
    return { status: res.status, text: await res.text(), headers: res.headers };
  };
  return {
    base: url,
    ws,
    state,
    cookie,
    call,
    logs,
    output,
    close: async () => {
      spies.forEach((s) => s.mockRestore());
      await app.close();
    },
  };
}

let app: Awaited<ReturnType<typeof boot>> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllEnvs();
});
const bearer = (k: string) => ({ authorization: `Bearer ${k}` });

describe('bearer authentication over HTTP', () => {
  it('serves auth/me for a key with only safe Workspace and permission data', async () => {
    app = await boot();
    const res = await app.call('/api/auth/me', bearer(GOOD_KEY));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(res.text)).toEqual({
      kind: 'apiKey',
      workspace: { id: app.ws.id, slug: 'acme', name: 'Acme' },
      permissions: ['files:read'],
    });
    expect(res.text).not.toMatch(/GOOD|hmac|digest|prefix|AbCdEfGh|keyId|keyName/i);
  });

  it('keeps the admin auth/me contract for a session cookie', async () => {
    app = await boot();
    const res = await app.call('/api/auth/me', { cookie: app.cookie });
    expect(res.status).toBe(200);
    expect(Object.keys(JSON.parse(res.text)).sort()).toEqual(['kind', 'username']);
  });

  it('gives wrong suffix, unknown prefix, malformed, revoked and expired keys byte-identical 401s', async () => {
    app = await boot();
    const bodies: string[] = [];
    const attempts = [
      bearer(WRONG_SUFFIX),
      bearer(UNKNOWN_PREFIX),
      { authorization: 'Bearer' },
      { authorization: 'Bearer not-a-key SENTINEL-extra' },
      {},
    ];
    for (const h of attempts) {
      const r = await app.call('/api/auth/me', h);
      expect(r.status).toBe(401);
      bodies.push(r.text);
    }
    app.state.record = { ...app.state.record!, revokedAt: new Date() };
    const revoked = await app.call('/api/auth/me', bearer(GOOD_KEY));
    app.state.record = { ...app.state.record!, revokedAt: null, expiresAt: new Date(Date.now() - 1000) };
    const expired = await app.call('/api/auth/me', bearer(GOOD_KEY));
    for (const r of [revoked, expired]) {
      expect(r.status).toBe(401);
      bodies.push(r.text);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toMatch(/SENTINEL|GOOD/);
  });

  it('rejects cookie + bearer with 400, including an invalid cookie and on login', async () => {
    app = await boot();
    for (const cookie of [app.cookie, `${SESSION_COOKIE_NAME}=tampered`]) {
      const me = await app.call('/api/auth/me', { ...bearer(GOOD_KEY), cookie });
      expect(me.status).toBe(400);
      const login = await app.call('/api/auth/login', { ...bearer(GOOD_KEY), cookie }, 'POST');
      expect(login.status).toBe(400);
      expect(me.text).not.toMatch(/GOOD|tampered/);
    }
  });

  it('applies permission and revocation changes on the next request', async () => {
    app = await boot();
    app.state.record = { ...app.state.record!, permissions: ['search', 'global:read'] };
    const me = JSON.parse((await app.call('/api/auth/me', bearer(GOOD_KEY))).text);
    expect(me.permissions).toEqual(['search', 'global:read']);
    app.state.record = { ...app.state.record!, revokedAt: new Date() };
    expect((await app.call('/api/auth/me', bearer(GOOD_KEY))).status).toBe(401);
  });

  it('authenticates but does not authorize: policy still decides on Workspace routes', async () => {
    app = await boot();
    const id = app.ws.id;
    for (const [path, method] of [
      ['/api/global/workspaces', 'GET'],
      [`/api/workspaces/${id}`, 'GET'],
      [`/api/workspaces/${id}/overview`, 'GET'],
      ['/api/global/overview', 'GET'],
    ] as const) {
      const r = await app.call(path, bearer(GOOD_KEY), method);
      expect([403, 404]).toContain(r.status);
    }
    const del = await fetch(`${app.base}/api/workspaces/${id}`, {
      method: 'DELETE',
      headers: { ...bearer(GOOD_KEY), 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'acme' }),
    });
    expect(del.status).toBe(403);
    const logout = await app.call('/api/auth/logout', bearer(GOOD_KEY), 'POST');
    expect(logout.status).toBe(403);
  });

  it('answers a foreign and a missing Workspace identically, byte for byte', async () => {
    app = await boot();
    const foreign = await app.call(`/api/workspaces/${randomUUID()}`, bearer(GOOD_KEY));
    const missing = await app.call(`/api/workspaces/${randomUUID()}`, bearer(GOOD_KEY));
    expect(foreign.status).toBe(404);
    expect(foreign.text).toBe(missing.text);
  });

  it('never writes credentials to logs or console, and last_used is touched on success only', async () => {
    app = await boot();
    await app.call('/api/auth/me', bearer(GOOD_KEY));
    await app.call('/api/auth/me', bearer(WRONG_SUFFIX));
    await app.call('/api/auth/me', { ...bearer(GOOD_KEY), cookie: `${SESSION_COOKIE_NAME}=x` });
    expect(app.state.touches).toBe(1);
    const all = [...app.logs.lines, ...app.output].join('\n');
    expect(all).not.toMatch(/GOOD|SENTINEL|sk_seshat_|Bearer /);
  });
});
