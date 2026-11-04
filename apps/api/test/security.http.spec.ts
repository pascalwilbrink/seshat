import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiKeyStoreError } from '../src/api-keys/api-key.store.js';
import { loadConfig } from '../src/config/app-config.js';
import { loadConfigOrExit } from '../src/config/startup.js';
import { TEST_ADMIN_ENV, TEST_API_KEY_PEPPER } from './fixtures/admin.js';
import { InMemoryWorkspaces } from './helpers/workspace-app.js';
import { MemoryKeyStore, type SecurityApp, bootSecurityApp } from './helpers/security-app.js';
import { defineSecuritySuite, leakNeedles, type World } from './helpers/security-suite.js';

async function memoryWorld(): Promise<World & { mem: InMemoryWorkspaces; keys: MemoryKeyStore }> {
  const mem = new InMemoryWorkspaces();
  const own = await mem.repo.save({ name: 'Own Space', slug: 'own-space' } as never);
  const foreign = await mem.repo.save({ name: 'Foreign Space', slug: 'foreign-space' } as never);
  const keys = new MemoryKeyStore();
  const app = await bootSecurityApp({ workspaceRepo: mem.repo, dataSource: mem.dataSource, keys });
  app.probe.existing = new Set([own.id, foreign.id]);
  const pick = (w: { id: string; slug: string; name: string }) => ({ id: w.id, slug: w.slug, name: w.name });
  return {
    app,
    mem,
    keys,
    own: pick(own),
    foreign: pick(foreign),
    async createKey(workspaceId, permissions, o) {
      const g = await keys.create({ workspaceId, name: 'k', permissions, expiresAt: o?.expired ? new Date(Date.now() - 60_000) : null });
      return { id: g.record.id, secret: g.secret };
    },
    async revokeKey(workspaceId, id) {
      await keys.revoke(workspaceId, id);
    },
    close: () => app.close(),
  };
}

defineSecuritySuite('security matrix over HTTP (in-memory persistence)', memoryWorld);

describe('AC-10: credentials never reach logs, errors or unintended responses', () => {
  let world: Awaited<ReturnType<typeof memoryWorld>> | undefined;
  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  const SENTINEL_DRIVER = 'SENTINEL-driver-host-10.9.8.7';

  it('only the create response carries the full key; logs, errors and other responses carry no key, HMAC or pepper', async () => {
    world = await memoryWorld();
    const w = world;
    const app: SecurityApp = w.app;
    const bodies: string[] = [];
    const record = (r: { text: string; headers: Record<string, string>; setCookie: string[] }) => {
      bodies.push(r.text, JSON.stringify(r.headers), r.setCookie.join(';'));
      return r;
    };

    // The one permitted full-key transport.
    const created = await app.http('POST', `/api/workspaces/${w.own.id}/api-keys`, { admin: true, body: { name: 'sentinel', permissions: ['files:read', 'global:read'] } });
    expect(created.status).toBe(201);
    const { secret, apiKey } = JSON.parse(created.text) as { secret: string; apiKey: { id: string; prefix: string } };
    expect(secret.startsWith('sk_seshat_')).toBe(true);
    expect(created.headers['cache-control']).toBe('no-store');
    // The prefix and id are the permitted identifiers.
    expect(apiKey.id).toMatch(/^[0-9a-f-]{36}$/);

    const expired = await w.createKey(w.own.id, ['files:read'], { expired: true });
    const revoked = await w.createKey(w.own.id, ['files:read']);
    await w.revokeKey(w.own.id, revoked.id);
    const sentinelKey = 'sk_seshat_SeNtInEl_SENTINELnotakey0123456789abcdefghijklmn';
    const needles = leakNeedles([secret, expired.secret, revoked.secret, sentinelKey]);

    // Successful authentication.
    record(await app.http('GET', '/api/auth/me', { bearer: secret }));
    record(await app.http('GET', `/api/probe/workspaces/${w.own.id}/file.list`, { bearer: secret }));
    record(await app.http('GET', `/api/probe/global/file.list`, { bearer: secret }));
    // Invalid credentials: unknown, expired, revoked, malformed, oversized, both credentials at once.
    for (const bearer of [sentinelKey, expired.secret, revoked.secret, 'x', 'sk_seshat_', 'A'.repeat(5000), `${secret}extra`]) {
      const r = record(await app.http('GET', '/api/auth/me', { bearer }));
      expect(r.status).toBe(401);
    }
    record(await app.http('GET', '/api/auth/me', { headers: { authorization: `Bearer ${secret}`, cookie: app.adminCookie } }));
    record(await app.http('GET', '/api/auth/me', { headers: { authorization: `Bearer ${sentinelKey}`, cookie: 'seshat_session=tampered' } }));
    // Authorization failures.
    record(await app.http('GET', `/api/probe/workspaces/${w.foreign.id}/file.list`, { bearer: secret }));
    record(await app.http('GET', `/api/workspaces/${w.own.id}/api-keys`, { bearer: secret }));
    // Malformed management input, including the secret itself as input.
    record(await app.http('POST', `/api/workspaces/${w.own.id}/api-keys`, { admin: true, body: { name: secret, permissions: [secret] } }));
    record(await app.http('POST', `/api/workspaces/${w.own.id}/api-keys`, { admin: true, body: `{"name":"${sentinelKey}"` }));
    record(await app.http('PUT', `/api/workspaces/${w.own.id}/api-keys/${secret}`, { admin: true, body: { name: 'x', permissions: ['search'] } }));
    record(await app.http('GET', `/api/workspaces/${w.own.id}/api-keys`, { admin: true }));
    record(await app.http('PUT', `/api/workspaces/${w.own.id}/api-keys/${apiKey.id}`, { admin: true, body: { name: 'renamed', permissions: ['search'] } }));
    record(await app.http('POST', `/api/workspaces/${w.own.id}/api-keys/${apiKey.id}/revoke`, { admin: true }));

    // ORM / driver failures at the store boundary, with a sentinel in the raw driver message.
    const store = w.keys as unknown as Record<string, unknown>;
    const failing = (): never => {
      throw Object.assign(new Error(`connect ECONNREFUSED ${SENTINEL_DRIVER} params=[${secret}]`), { parameters: [secret, sentinelKey] });
    };
    const originals = { findByKey: store.findByKey, list: store.list, create: store.create, touchLastUsed: store.touchLastUsed };
    try {
      store.findByKey = failing;
      expect(record(await app.http('GET', '/api/auth/me', { bearer: secret })).status).toBe(500);
      store.findByKey = async () => {
        throw new ApiKeyStoreError('persistence_failed');
      };
      expect(record(await app.http('GET', '/api/auth/me', { bearer: secret })).status).toBe(500);
      store.findByKey = originals.findByKey;
      store.list = failing;
      expect(record(await app.http('GET', `/api/workspaces/${w.own.id}/api-keys`, { admin: true })).status).toBe(500);
      store.create = failing;
      expect(record(await app.http('POST', `/api/workspaces/${w.own.id}/api-keys`, { admin: true, body: { name: 'n', permissions: ['search'] } })).status).toBe(500);
      // A failing last-used write must not fail or log the request.
      store.list = originals.list;
      store.create = originals.create;
      store.touchLastUsed = failing;
      const ok = await app.http('GET', `/api/probe/workspaces/${w.own.id}/file.list`, { bearer: expired.secret === secret ? secret : (await w.createKey(w.own.id, ['files:read'])).secret });
      record(ok);
      expect(ok.status).toBe(200);
    } finally {
      Object.assign(store, originals);
    }

    const haystack = [...bodies, app.output()].join('\n');
    // Strip the one permitted transport (the create response body) before checking everything else.
    const withoutCreate = haystack.replace(created.text, '');
    for (const needle of needles) {
      expect(withoutCreate.includes(needle), `leaked ${needle.slice(0, 12)}…`).toBe(false);
    }
    expect(withoutCreate).not.toContain(SENTINEL_DRIVER);
    expect(app.output()).not.toMatch(/\bat \S+ \(.*:\d+:\d+\)/);
    expect(app.output()).not.toContain('Bearer ');
    // The full key exists in exactly one response: the creation response.
    expect(bodies.filter((b) => b.includes(secret))).toEqual([]);
  });

  it('responses never contain digests: list, edit and revoke carry only the safe metadata allowlist', async () => {
    world = await memoryWorld();
    const w = world;
    const created = JSON.parse((await w.app.http('POST', `/api/workspaces/${w.own.id}/api-keys`, { admin: true, body: { name: 'meta', permissions: ['search'] } })).text);
    const list = await w.app.http('GET', `/api/workspaces/${w.own.id}/api-keys`, { admin: true });
    const edit = await w.app.http('PUT', `/api/workspaces/${w.own.id}/api-keys/${created.apiKey.id}`, { admin: true, body: { name: 'meta2', permissions: ['search'] } });
    const revoke = await w.app.http('POST', `/api/workspaces/${w.own.id}/api-keys/${created.apiKey.id}/revoke`, { admin: true });
    for (const r of [list, edit, revoke]) {
      expect(r.headers['cache-control']).toBe('no-store');
      for (const needle of leakNeedles([created.secret])) expect(r.text.includes(needle)).toBe(false);
      expect(r.text).not.toMatch(/hmac|digest|pepper|secret|workspaceId/i);
    }
    const dto = (JSON.parse(list.text) as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(dto).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'lastUsedAt', 'name', 'permissions', 'prefix', 'revokedAt', 'status']);
  });
});

describe('AC-10: invalid API key pepper configuration never prints secret values', () => {
  const SENTINEL_PEPPER = 'SENTINEL-pepper-do-not-print';
  const cases: Array<[string, Record<string, string>]> = [
    ['too short', { ...TEST_ADMIN_ENV, API_KEY_PEPPER: SENTINEL_PEPPER }],
    ['missing', { ...TEST_ADMIN_ENV, API_KEY_PEPPER: '' }],
  ];
  it.each(cases)('%s', (_n, env) => {
    const output: string[] = [];
    let exited = false;
    try {
      loadConfigOrExit(() => loadConfig({ DATABASE_URL: 'postgres://u:p@localhost/db', ...env }), {
        error: (m) => void output.push(m),
        exit: (): never => {
          exited = true;
          throw new Error('exit');
        },
      });
    } catch {
      /* exit */
    }
    expect(exited).toBe(true);
    expect(output.join('\n')).toContain('API_KEY_PEPPER');
    const text = output.join('\n');
    for (const s of [SENTINEL_PEPPER, TEST_API_KEY_PEPPER, TEST_ADMIN_ENV.SESSION_SECRET, TEST_ADMIN_ENV.ADMIN_PASSWORD_HASH]) expect(text).not.toContain(s);
  });
});
