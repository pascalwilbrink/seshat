import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type INestApplication, Module, NotFoundException } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiKeysController } from '../src/api-keys/api-keys.controller.js';
import { ApiKeysService } from '../src/api-keys/api-keys.service.js';
import { type ApiKeyRecord, ApiKeyStore, GeneratedApiKey } from '../src/api-keys/api-key.store.js';
import { generateApiKey } from '../src/api-keys/api-key-crypto.js';
import { createApp } from '../src/app.setup.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthorizationService } from '../src/auth/authorization.service.js';
import { CLOCK, systemClock } from '../src/auth/login-rate-limiter.js';
import type { Principal } from '../src/auth/principal.js';
import { SESSION_COOKIE_NAME } from '../src/auth/session-token.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { SanitizedExceptionFilter } from '../src/common/sanitized-exception.filter.js';
import { ConfigModule } from '../src/config/config.module.js';
import { globalScope, workspaceScope } from '../src/scopes/scope-ref.js';
import { WorkspacesService } from '../src/workspaces/workspace.service.js';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';

/** In-memory store that mirrors the real store's contract (Workspace+id lookups, soft revoke). */
class MemoryStore {
  rows: (ApiKeyRecord & { hmac: string })[] = [];
  async list(workspaceId: string) {
    return this.rows.filter((r) => r.workspaceId === workspaceId).map(({ hmac: _h, ...r }) => r);
  }
  async create(i: { workspaceId: string; name: string; permissions: string[]; expiresAt?: Date | null }) {
    const { key, prefix } = generateApiKey();
    const row = {
      id: randomUUID(), workspaceId: i.workspaceId, name: i.name, prefix, permissions: i.permissions as never,
      createdAt: new Date(), expiresAt: i.expiresAt ?? null, lastUsedAt: null, revokedAt: null, hmac: 'SENTINEL-HMAC',
    };
    this.rows.push(row);
    const { hmac: _h, ...record } = row;
    return new GeneratedApiKey(record, key);
  }
  async update(ws: string, id: string, c: { name?: string; permissions?: string[] }) {
    const r = this.rows.find((x) => x.id === id && x.workspaceId === ws);
    if (!r) return 'not_found' as const;
    if (r.revokedAt) return 'revoked' as const;
    if (c.name !== undefined) r.name = c.name;
    if (c.permissions) r.permissions = c.permissions as never;
    const { hmac: _h, ...record } = r;
    return record;
  }
  async revoke(ws: string, id: string) {
    const r = this.rows.find((x) => x.id === id && x.workspaceId === ws);
    if (!r) return null;
    r.revokedAt ??= new Date();
    const { hmac: _h, ...record } = r;
    return record;
  }
}

const workspaceIds = new Set<string>();
const fakeWorkspaces = {
  authorization: new AuthorizationService(),
  async resolve(principal: Principal, action: never, scope: { kind: string; workspaceId?: string }) {
    this.authorization.assertCan(principal, action, scope as never);
    if (!workspaceIds.has(scope.workspaceId!)) throw new NotFoundException('Not Found');
    return {};
  },
};

const store = new MemoryStore();
let app: INestApplication;
let base: string;
let cookie: string;
let service: ApiKeysService;
const SECRET_RE = /sk_seshat_[0-9A-Za-z]{8}_[0-9A-Za-z]{32,}/;

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers, json: text ? JSON.parse(text) : undefined };
}

const DTO_FIELDS = ['createdAt', 'expiresAt', 'id', 'lastUsedAt', 'name', 'permissions', 'prefix', 'revokedAt', 'status'];

beforeAll(async () => {
  for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) vi.stubEnv(k, v);
  @Module({
    imports: [ConfigModule],
    controllers: [ApiKeysController],
    providers: [
      { provide: CLOCK, useValue: systemClock },
      AuthService,
      SessionGuard,
      { provide: APP_GUARD, useExisting: SessionGuard },
      { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
      { provide: AuthorizationService, useValue: new AuthorizationService() },
      { provide: WorkspacesService, useValue: fakeWorkspaces },
      { provide: ApiKeyStore, useValue: store },
      ApiKeysService,
    ],
  })
  class TestRoot {}
  app = await createApp(TestRoot, { trustProxy: false }, false);
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  cookie = `${SESSION_COOKIE_NAME}=${app.get(AuthService).issueSessionToken()}`;
  service = app.get(ApiKeysService);
});
afterAll(async () => app?.close());

describe('API key management (admin HTTP)', () => {
  const ws = randomUUID();
  const other = randomUUID();
  workspaceIds.add(ws).add(other);
  const url = (w = ws) => `/api/workspaces/${w}/api-keys`;

  it('creates once with the secret, no-store, safe metadata; list/edit/revoke never carry it', async () => {
    const created = await req('POST', url(), { name: '  Agent  ', permissions: ['files:read', 'search', 'files:read'] });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(created.json).sort()).toEqual(['apiKey', 'secret']);
    expect(Object.keys(created.json.apiKey).sort()).toEqual(DTO_FIELDS);
    expect(created.json.secret).toMatch(SECRET_RE);
    expect(created.json.apiKey).toMatchObject({ name: 'Agent', permissions: ['files:read', 'search'], status: 'active' });
    expect(created.json.secret).toContain(created.json.apiKey.prefix);
    const id = created.json.apiKey.id;

    const list = await req('GET', url());
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe('no-store');
    expect(list.json).toHaveLength(1);
    expect(Object.keys(list.json[0]).sort()).toEqual(DTO_FIELDS);

    const edit = await req('PUT', `${url()}/${id}`, { name: 'Renamed', permissions: ['memories:read'] });
    expect(edit.status).toBe(200);
    expect(edit.json).toMatchObject({ name: 'Renamed', permissions: ['memories:read'] });
    expect(Object.keys(edit.json).sort()).toEqual(DTO_FIELDS);

    const revoke = await req('POST', `${url()}/${id}/revoke`);
    expect(revoke.status).toBe(200);
    expect(revoke.json.status).toBe('revoked');
    for (const r of [list, edit, revoke]) {
      expect(r.text).not.toMatch(SECRET_RE);
      expect(r.text).not.toContain('SENTINEL-HMAC');
      expect(r.text.toLowerCase()).not.toContain('hmac');
    }
  });

  it('rejects malformed, unknown, empty and invalid-date input without echoing it', async () => {
    const bad: unknown[] = [
      {}, { name: 'x' }, { name: 'x', permissions: [] }, { name: 'x', permissions: ['files:nuke'] },
      { name: 'x', permissions: 'files:read' }, { name: '   ', permissions: ['search'] },
      { name: 'x'.repeat(101), permissions: ['search'] }, { name: 'x', permissions: ['search'], extra: 1 },
      { name: 'x', permissions: ['search'], expiresAt: 'not-a-date' },
      { name: 'x', permissions: ['search'], expiresAt: '2000-01-01T00:00:00Z' },
      { name: 'x', permissions: ['search'], workspaceId: other }, { name: 5, permissions: ['search'] },
    ];
    for (const body of bad) {
      const r = await req('POST', url(), body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.text).not.toContain('files:nuke');
      expect(r.text).not.toContain('not-a-date');
    }
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const ok = await req('POST', url(), { name: 'exp', permissions: ['search'], expiresAt: future });
    expect(ok.status).toBe(201);
    expect(ok.json.apiKey.expiresAt).toBe(future);
  });

  it('PUT requires the complete body and only accepts name/permissions', async () => {
    const { json } = await req('POST', url(), { name: 'p', permissions: ['search'] });
    const id = json.apiKey.id;
    const ok = { name: 'p', permissions: ['search'] };
    for (const body of [{}, { name: 'p' }, { permissions: ['search'] }, { ...ok, expiresAt: null }, { ...ok, revokedAt: null }, { ...ok, prefix: 'AAAAAAAA' }, { ...ok, workspaceId: other }, { name: 'p', permissions: [] }, { name: '', permissions: ['search'] }]) {
      expect((await req('PUT', `${url()}/${id}`, body)).status, JSON.stringify(body)).toBe(400);
    }
    const missing = await req('PUT', `${url()}/${id}`, { name: 'p' });
    expect(JSON.stringify(missing.json)).toContain('permissions');
    expect((await req('PUT', `${url()}/${id}`, { permissions: ['search'] })).status).toBe(400);
  });

  it('PATCH is gone: it is answered like any unsupported method and changes nothing', async () => {
    const { json } = await req('POST', url(), { name: 'keep', permissions: ['search'] });
    const id = json.apiKey.id;
    const res = await req('PATCH', `${url()}/${id}`, { name: 'changed', permissions: ['search'] });
    expect(res.status).toBe(404);
    expect(store.rows.find((r) => r.id === id)!.name).toBe('keep');
  });

  it('is scoped by Workspace and key id: substitution, missing keys and missing Workspaces are 404', async () => {
    const { json } = await req('POST', url(), { name: 'mine', permissions: ['search'] });
    const id = json.apiKey.id;
    expect((await req('PUT', `${url(other)}/${id}`, { name: 'hijack', permissions: ['search'] })).status).toBe(404);
    expect((await req('POST', `${url(other)}/${id}/revoke`)).status).toBe(404);
    expect((await req('GET', url(other))).json).toEqual([]);
    const row = store.rows.find((r) => r.id === id)!;
    expect(row.name).toBe('mine');
    expect(row.revokedAt).toBeNull();
    expect((await req('PUT', `${url()}/${randomUUID()}`, { name: 'x', permissions: ['search'] })).status).toBe(404);
    expect((await req('PUT', `${url()}/not-a-uuid`, { name: 'x', permissions: ['search'] })).status).toBe(404);
    expect((await req('POST', `${url()}/${randomUUID()}/revoke`)).status).toBe(404);
    const ghost = randomUUID();
    for (const [m, p, b] of [['GET', url(ghost)], ['POST', url(ghost), { name: 'x', permissions: ['search'] }]] as const) {
      expect((await req(m, p, b)).status).toBe(404);
    }
    expect((await req('GET', '/api/workspaces/nope/api-keys')).status).toBe(400);
  });

  it('revocation is soft, idempotent and irreversible', async () => {
    const { json } = await req('POST', url(), { name: 'r', permissions: ['search'] });
    const id = json.apiKey.id;
    const first = await req('POST', `${url()}/${id}/revoke`);
    const second = await req('POST', `${url()}/${id}/revoke`);
    expect(second.status).toBe(200);
    expect(second.json.revokedAt).toBe(first.json.revokedAt);
    expect(store.rows.some((r) => r.id === id)).toBe(true);
    for (const body of [{ name: 'again', permissions: ['search'] }, { name: 'r', permissions: ['files:read'] }]) {
      expect((await req('PUT', `${url()}/${id}`, body)).status).toBe(409);
    }
    expect((await req('GET', url())).json.find((k: { id: string }) => k.id === id).status).toBe('revoked');
  });

  it('requires the admin session and exposes no Global key routes', async () => {
    const anon = await fetch(`${base}${url()}`);
    expect(anon.status).toBe(401);
    for (const p of ['/api/global/api-keys', '/api/api-keys']) expect((await req('GET', p)).status).toBe(404);
  });

  it('central policy rejects API-key principals for every management operation', async () => {
    const key: Principal = { kind: 'apiKey', keyId: randomUUID(), keyName: 'key', workspaceId: ws, permissions: ['files:read', 'files:write', 'files:delete', 'search', 'global:read'] };
    const scope = workspaceScope(ws);
    const id = randomUUID();
    await expect(service.list(key, scope)).rejects.toThrow('Forbidden');
    await expect(service.create(key, scope, { name: 'x', permissions: ['search'] })).rejects.toThrow('Forbidden');
    await expect(service.update(key, scope, id, { name: 'x' })).rejects.toThrow('Forbidden');
    await expect(service.revoke(key, scope, id)).rejects.toThrow('Forbidden');
    // A foreign Workspace is indistinguishable from a missing one.
    await expect(service.list(key, workspaceScope(other))).rejects.toThrow('Not Found');
    await expect(service.list(key, workspaceScope(randomUUID()))).rejects.toThrow('Not Found');
    // Global keys cannot be created or listed.
    await expect(service.create(ws as never, globalScope(), { name: 'x', permissions: ['search'] })).rejects.toThrow('Not Found');
    await expect(service.list({ kind: 'admin' }, globalScope())).rejects.toThrow('Not Found');
  });
});
