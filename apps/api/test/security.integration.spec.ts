import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { ApiKey } from '../src/api-keys/api-key.entity.js';
import { ApiKeyStore } from '../src/api-keys/api-key.store.js';
import { createDataSourceOptions } from '../src/database/options.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { TEST_API_KEY_PEPPER } from './fixtures/admin.js';
import { type SecurityApp, bootSecurityApp } from './helpers/security-app.js';
import { defineSecuritySuite, leakNeedles, type World } from './helpers/security-suite.js';
import {
  TEST_DATABASE_URL,
  assertDisposableDatabase,
  createIsolatedSchema,
  describeIntegration,
  type IsolatedSchema,
} from './helpers/integration.js';

interface PgWorld extends World {
  ds: DataSource;
  store: ApiKeyStore;
  iso: IsolatedSchema;
  newWorkspace(name: string, slug: string): Promise<{ id: string; slug: string; name: string }>;
}

/** A real PostgreSQL schema with the real migrations, the real store, repositories and WorkspacesService. */
async function pgWorld(): Promise<PgWorld> {
  assertDisposableDatabase(TEST_DATABASE_URL!);
  const iso = await createIsolatedSchema();
  await iso.query('DROP EXTENSION IF EXISTS vector');
  const ds = iso.createDataSource([Workspace, ApiKey]);
  await ds.initialize();
  await ds.runMigrations({ transaction: 'each' });
  const store = new ApiKeyStore(ds.getRepository(ApiKey), { apiKeyPepper: TEST_API_KEY_PEPPER });
  const app = await bootSecurityApp({ workspaceRepo: ds.getRepository(Workspace), dataSource: ds, keys: store });
  const newWorkspace = async (name: string, slug: string) => {
    const w = await ds.getRepository(Workspace).save({ name, slug, description: null });
    app.probe.existing.add(w.id);
    return { id: w.id, slug: w.slug, name: w.name };
  };
  const own = await newWorkspace('Own Space', 'own-space');
  const foreign = await newWorkspace('Foreign Space', 'foreign-space');
  return {
    app,
    ds,
    store,
    iso,
    own,
    foreign,
    newWorkspace,
    async createKey(workspaceId, permissions, o) {
      const g = await store.create({ workspaceId, name: 'k', permissions, expiresAt: o?.expired ? new Date(Date.now() - 60_000) : null });
      return { id: g.record.id, secret: g.secret };
    },
    async revokeKey(workspaceId, id) {
      await store.revoke(workspaceId, id);
    },
    async close() {
      await app.close();
      await iso.dispose();
    },
  };
}

describeIntegration('security over HTTP (real PostgreSQL)', () => {
  defineSecuritySuite('permission matrix, byte-identical 404s and key/Workspace management denial', pgWorld);

  describe('AC-7: Workspace deletion', () => {
    let w: PgWorld;
    beforeAll(async () => {
      w = await pgWorld();
    });
    afterAll(async () => w?.close());

    it('removes active and revoked keys with the Workspace and the old tokens then get the generic 401', async () => {
      const doomed = await w.newWorkspace('Doomed', 'doomed');
      const active = await w.createKey(doomed.id, ['files:read', 'search']);
      const revoked = await w.createKey(doomed.id, ['files:read']);
      await w.revokeKey(doomed.id, revoked.id);
      const expired = await w.createKey(doomed.id, ['files:read'], { expired: true });
      const survivor = await w.createKey(w.own.id, ['files:read']);
      const count = async (id: string) => Number((await w.ds.query('SELECT count(*) AS n FROM api_keys WHERE workspace_id = $1', [id]))[0]!.n);
      expect(await count(doomed.id)).toBe(3);
      expect((await w.app.http('GET', `/api/probe/workspaces/${doomed.id}/file.list`, { bearer: active.secret })).status).toBe(200);

      const del = await w.app.http('DELETE', `/api/workspaces/${doomed.id}`, { admin: true, body: { slug: 'doomed' } });
      expect(del.status).toBeLessThan(300);

      expect(await count(doomed.id)).toBe(0);
      expect(Number((await w.ds.query('SELECT count(*) AS n FROM workspaces WHERE id = $1', [doomed.id]))[0]!.n)).toBe(0);
      const unknown = await w.app.http('GET', '/api/auth/me', { bearer: 'sk_seshat_ZzZzZzZz_UNKNOWN0123456789abcdefghijklmnopqrstu' });
      for (const k of [active, revoked, expired]) {
        const r = await w.app.http('GET', '/api/auth/me', { bearer: k.secret });
        expect(r.status).toBe(401);
        expect(Buffer.compare(r.bytes, unknown.bytes)).toBe(0);
      }
      // Other Workspaces' keys are untouched.
      expect((await w.app.http('GET', '/api/auth/me', { bearer: survivor.secret })).status).toBe(200);
    });
  });

  describe('last-used writes', () => {
    let w: PgWorld;
    beforeAll(async () => {
      w = await pgWorld();
    });
    afterAll(async () => w?.close());

    it('concurrent authenticated requests write last_used_at exactly once per throttle window', async () => {
      const { id, secret } = await w.createKey(w.own.id, ['files:read']);
      const outcomes: boolean[] = [];
      const original = w.store.touchLastUsed.bind(w.store);
      const spy = vi.spyOn(w.store, 'touchLastUsed').mockImplementation(async (keyId: string) => {
        const wrote = await original(keyId);
        outcomes.push(wrote);
        return wrote;
      });
      try {
        const burst = await Promise.all(Array.from({ length: 30 }, () => w.app.http('GET', `/api/probe/workspaces/${w.own.id}/file.list`, { bearer: secret })));
        expect(burst.every((r) => r.status === 200)).toBe(true);
        expect(outcomes).toHaveLength(30);
        expect(outcomes.filter(Boolean)).toHaveLength(1);
        const [row] = await w.ds.query('SELECT last_used_at FROM api_keys WHERE id = $1', [id]);
        expect(row.last_used_at).not.toBeNull();
        const first = new Date(row.last_used_at).getTime();
        outcomes.length = 0;
        await Promise.all(Array.from({ length: 10 }, () => w.app.http('GET', '/api/auth/me', { bearer: secret })));
        expect(outcomes.filter(Boolean)).toHaveLength(0);
        const [again] = await w.ds.query('SELECT last_used_at FROM api_keys WHERE id = $1', [id]);
        expect(new Date(again.last_used_at).getTime()).toBe(first);
      } finally {
        spy.mockRestore();
      }
    });

    it('does not authenticate or write for a revoked key even under concurrency', async () => {
      const { id, secret } = await w.createKey(w.own.id, ['files:read']);
      await w.revokeKey(w.own.id, id);
      const results = await Promise.all(Array.from({ length: 10 }, () => w.app.http('GET', '/api/auth/me', { bearer: secret })));
      expect(results.every((r) => r.status === 401)).toBe(true);
      const [row] = await w.ds.query('SELECT last_used_at FROM api_keys WHERE id = $1', [id]);
      expect(row.last_used_at).toBeNull();
    });
  });

  describe('AC-10: ORM and driver failures, query logging and secrets', () => {
    let w: PgWorld;
    beforeAll(async () => {
      w = await pgWorld();
    });
    afterAll(async () => w?.close());

    it('does not enable TypeORM query or error logging, which would print bound parameters (digests)', () => {
      expect(createDataSourceOptions({ databaseUrl: 'postgres://u:p@localhost/db' }).logging).toBe(false);
      expect(w.ds.options.logging).toBeFalsy();
      expect((w.ds.options as { maxQueryExecutionTime?: number }).maxQueryExecutionTime).toBeUndefined();
    });

    it('keeps full keys, digests and the pepper out of logs, console and every response except creation', async () => {
      const app: SecurityApp = w.app;
      const bodies: string[] = [];
      const record = (r: { text: string; headers: Record<string, string>; setCookie: string[] }) => {
        bodies.push(r.text, JSON.stringify(r.headers), r.setCookie.join(';'));
        return r;
      };
      const created = await app.http('POST', `/api/workspaces/${w.own.id}/api-keys`, { admin: true, body: { name: 'pg', permissions: ['files:read', 'global:read'] } });
      expect(created.status).toBe(201);
      const { secret, apiKey } = JSON.parse(created.text) as { secret: string; apiKey: { id: string } };
      const expired = await w.createKey(w.own.id, ['files:read'], { expired: true });
      const revoked = await w.createKey(w.own.id, ['files:read']);
      await w.revokeKey(w.own.id, revoked.id);
      const wrongSuffix = `${secret.slice(0, secret.lastIndexOf('_') + 1)}${'W'.repeat(32)}`;
      const needles = leakNeedles([secret, expired.secret, revoked.secret, wrongSuffix]);

      record(await app.http('GET', '/api/auth/me', { bearer: secret }));
      record(await app.http('GET', `/api/probe/global/file.list`, { bearer: secret }));
      for (const bearer of [wrongSuffix, expired.secret, revoked.secret, 'x', `${secret}x`, 'A'.repeat(4000)]) {
        expect(record(await app.http('GET', '/api/auth/me', { bearer })).status).toBe(401);
      }
      record(await app.http('GET', '/api/auth/me', { headers: { authorization: `Bearer ${secret}`, cookie: app.adminCookie } }));
      record(await app.http('POST', `/api/workspaces/${w.own.id}/api-keys`, { admin: true, body: { name: secret, permissions: [secret] } }));
      record(await app.http('POST', `/api/workspaces/${w.own.id}/api-keys`, { admin: true, body: `{"name":"${secret}"` }));
      record(await app.http('PUT', `/api/workspaces/${w.own.id}/api-keys/${apiKey.id}`, { admin: true, body: { name: 'renamed', permissions: ['search'] } }));
      record(await app.http('GET', `/api/workspaces/${w.own.id}/api-keys`, { admin: true }));
      // A key for a Workspace that does not exist: a foreign-key violation inside the driver.
      record(await app.http('POST', `/api/workspaces/${randomUUID()}/api-keys`, { admin: true, body: { name: 'n', permissions: ['search'] } }));

      // Driver failures while authenticating and listing (relation missing): fixed 500, nothing leaked.
      const table = `"${w.iso.schema}".api_keys`;
      await w.iso.query(`ALTER TABLE ${table} RENAME TO api_keys_moved`);
      try {
        expect(record(await app.http('GET', '/api/auth/me', { bearer: secret })).status).toBe(500);
        expect(record(await app.http('GET', `/api/workspaces/${w.own.id}/api-keys`, { admin: true })).status).toBe(500);
        expect(record(await app.http('POST', `/api/workspaces/${w.own.id}/api-keys`, { admin: true, body: { name: 'n', permissions: ['search'] } })).status).toBe(500);
      } finally {
        await w.iso.query(`ALTER TABLE "${w.iso.schema}".api_keys_moved RENAME TO api_keys`);
      }

      const everything = [...bodies, app.output()].join('\n').replace(created.text, '');
      for (const needle of needles) expect(everything.includes(needle), `leaked ${needle.slice(0, 12)}…`).toBe(false);
      for (const fragment of ['api_keys_moved', 'relation "', 'key_hmac', 'violates foreign key', 'ECONNREFUSED', 'QueryFailedError: ']) {
        expect(bodies.join('\n'), fragment).not.toContain(fragment);
      }
      expect(app.output()).not.toMatch(/\bat \S+ \(.*:\d+:\d+\)/);
      expect(app.output()).not.toContain('Bearer ');
    });
  });
});
