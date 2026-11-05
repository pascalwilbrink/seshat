import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { ApiKey } from '../src/api-keys/api-key.entity.js';
import { computeApiKeyHmac, generateApiKey } from '../src/api-keys/api-key-crypto.js';
import { ApiKeyStore, ApiKeyStoreError, LAST_USED_THROTTLE_SECONDS } from '../src/api-keys/api-key.store.js';
import { initializeDatabase } from '../src/database/bootstrap.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { TEST_API_KEY_PEPPER } from './fixtures/admin.js';
import {
  TEST_DATABASE_URL,
  assertDisposableDatabase,
  createIsolatedSchema,
  describeIntegration,
  type IsolatedSchema,
} from './helpers/integration.js';

describeIntegration('API keys (real PostgreSQL)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let store: ApiKeyStore;

  const workspace = async (slug: string) =>
    (await ds.getRepository(Workspace).save({ name: slug, slug, description: null })).id;
  const create = (workspaceId: string, over: Record<string, unknown> = {}) =>
    store.create({ workspaceId, name: 'key', permissions: ['files:read', 'search'], ...over });
  const count = async () => Number((await ds.query('SELECT count(*) AS n FROM api_keys'))[0]!.n);

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    store = new ApiKeyStore(ds.getRepository(ApiKey), { apiKeyPepper: TEST_API_KEY_PEPPER });
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM workspaces');
  });

  afterAll(async () => {
    await iso?.dispose();
  });

  describe('migration', () => {
    it('creates api_keys with the documented columns and no plaintext column', async () => {
      const cols = await ds.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = '${iso.schema}' AND table_name = 'api_keys' ORDER BY column_name`,
      );
      expect(cols.map((c) => c.column_name)).toEqual([
        'created_at', 'expires_at', 'id', 'key_hmac', 'last_used_at', 'name', 'permissions', 'prefix',
        'revoked_at', 'workspace_id',
      ]);
      expect(cols.find((c) => c.column_name === 'key_hmac')).toMatchObject({ data_type: 'bytea', is_nullable: 'NO' });
    });

    it('down drops the table, up recreates it (reversible)', async () => {
      const names = ds.migrations.map((m) => m.constructor.name);
      // Newer migrations (files, Collections, Tags, cleanup ledger, chunks) sit on top of it: revert them first.
      expect(names.at(-6)).toBe('CreateApiKeys1762500000000');
      await ds.undoLastMigration({ transaction: 'each' });
      await ds.undoLastMigration({ transaction: 'each' });
      await ds.undoLastMigration({ transaction: 'each' });
      await ds.undoLastMigration({ transaction: 'each' });
      await ds.undoLastMigration({ transaction: 'each' });
      await ds.undoLastMigration({ transaction: 'each' });
      expect(await ds.query(`SELECT to_regclass('"${iso.schema}".api_keys') AS t`)).toEqual([{ t: null }]);
      expect(await ds.query(`SELECT to_regclass('"${iso.schema}".workspaces') AS t`)).not.toEqual([{ t: null }]);
      const again = await ds.runMigrations({ transaction: 'each' });
      expect(again.map((m) => m.name)).toEqual(['CreateApiKeys1762500000000', 'CreateFilesCollectionsTags1762600000000', 'CreateStorageCleanupIntents1762700000000', 'CreateChunks1762800000000', 'CreateMemories1762900000000', 'AddMemoryEmbeddingGeneration1763000000000']);
      expect(await ds.runMigrations({ transaction: 'each' })).toEqual([]);
    });
  });

  describe('persisted fields', () => {
    it('stores prefix, a 32-byte HMAC and metadata only, never the key or its secret part', async () => {
      const ws = await workspace('alpha');
      const expiresAt = new Date(Date.now() + 86_400_000);
      const generated = await create(ws, { expiresAt });
      const secretPart = generated.secret.split('_')[3]!;

      const [row] = await ds.query('SELECT * FROM api_keys');
      expect(Object.keys(row!).sort()).toEqual([
        'created_at', 'expires_at', 'id', 'key_hmac', 'last_used_at', 'name', 'permissions', 'prefix',
        'revoked_at', 'workspace_id',
      ]);
      expect(row).toMatchObject({
        id: generated.record.id, workspace_id: ws, name: 'key', prefix: generated.record.prefix,
        permissions: ['files:read', 'search'], last_used_at: null, revoked_at: null,
      });
      expect(new Date(row!.expires_at as string).getTime()).toBe(expiresAt.getTime());
      expect(row!.key_hmac).toEqual(computeApiKeyHmac(TEST_API_KEY_PEPPER, generated.secret));

      const dump = JSON.stringify(row) + (await ds.query('SELECT row(a.*)::text AS t FROM api_keys a'))[0]!.t;
      expect(dump).not.toContain(generated.secret);
      expect(dump).not.toContain(secretPart);
      expect(dump).not.toContain(TEST_API_KEY_PEPPER);
    });

    it('does not select the HMAC in normal reads and maps records without it', async () => {
      const ws = await workspace('alpha');
      const g = await create(ws);
      const found = await ds.getRepository(ApiKey).findOneByOrFail({ id: g.record.id });
      expect(found.keyHmac).toBeUndefined();
      expect(JSON.stringify(g)).not.toContain(g.secret);
      expect(Object.keys(g.record)).not.toContain('keyHmac');
    });

    it('enforces nonempty permissions, a 32 byte digest and a valid prefix in the database', async () => {
      const ws = await workspace('alpha');
      const insert = (over: Record<string, string>) => {
        const v = { prefix: `'abcd1234'`, hmac: `decode(repeat('ab', 32), 'hex')`, perms: `ARRAY['search']::text[]`, ...over };
        return ds.query(
          `INSERT INTO api_keys (workspace_id, name, prefix, key_hmac, permissions)
           VALUES ('${ws}', 'n', ${v.prefix}, ${v.hmac}, ${v.perms})`,
        );
      };
      await expect(insert({ perms: `ARRAY[]::text[]` })).rejects.toThrow(/CK_api_keys_permissions_not_empty/);
      await expect(insert({ hmac: `decode('abcd', 'hex')` })).rejects.toThrow(/CK_api_keys_key_hmac_length/);
      await expect(insert({ prefix: `'abc'` })).rejects.toThrow();
      await expect(insert({ prefix: `'abcd123_'` })).rejects.toThrow(/CK_api_keys_prefix_format/);
      await insert({});
      await expect(insert({})).rejects.toThrow(/UQ_api_keys_prefix/);
    });

    it('rejects unknown permissions through the store', async () => {
      const ws = await workspace('alpha');
      await expect(create(ws, { permissions: ['files:everything'] })).rejects.toMatchObject({ code: 'invalid_permissions' });
      await expect(create(ws, { permissions: [] })).rejects.toMatchObject({ code: 'invalid_permissions' });
      expect(await count()).toBe(0);
    });

    it('reports a missing Workspace as a sanitized error', async () => {
      const err = await create('00000000-0000-4000-8000-000000000000').catch((e) => e);
      expect(err).toBeInstanceOf(ApiKeyStoreError);
      expect(err.code).toBe('workspace_not_found');
    });
  });

  describe('prefixes', () => {
    it('are unique, and a collision retries with a fresh prefix', async () => {
      const ws = await workspace('alpha');
      const first = await create(ws);
      let calls = 0;
      store.generator = () => {
        calls += 1;
        return calls <= 2
          ? { key: `sk_seshat_${first.record.prefix}_${'a'.repeat(43)}`, prefix: first.record.prefix }
          : generateApiKey();
      };
      try {
        const second = await create(ws);
        expect(calls).toBe(3);
        expect(second.record.prefix).not.toBe(first.record.prefix);
        expect(await count()).toBe(2);
      } finally {
        store.generator = generateApiKey;
      }
    });

    it('gives up after bounded retries with a sanitized error and no row', async () => {
      const ws = await workspace('alpha');
      const first = await create(ws);
      let calls = 0;
      store.generator = () => {
        calls += 1;
        return { key: `sk_seshat_${first.record.prefix}_${'b'.repeat(43)}`, prefix: first.record.prefix };
      };
      try {
        const err = await create(ws).catch((e) => e);
        expect(err).toBeInstanceOf(ApiKeyStoreError);
        expect(err.code).toBe('prefix_collision');
        expect(calls).toBe(5);
        expect(await count()).toBe(1);
      } finally {
        store.generator = generateApiKey;
      }
    });
  });

  describe('lookup and digest comparison', () => {
    it('finds a key by its full secret and returns current state', async () => {
      const ws = await workspace('alpha');
      const g = await create(ws);
      expect(await store.findByKey(g.secret)).toMatchObject({ id: g.record.id, workspaceId: ws, permissions: ['files:read', 'search'] });

      // No caching: revocation and permission edits are visible on the next call.
      await ds.query(`UPDATE api_keys SET revoked_at = now(), permissions = ARRAY['search'] WHERE id = '${g.record.id}'`);
      const after = await store.findByKey(g.secret);
      expect(after?.revokedAt).toBeInstanceOf(Date);
      expect(after?.permissions).toEqual(['search']);
    });

    it('never returns the digest', async () => {
      const ws = await workspace('alpha');
      const g = await create(ws);
      const found = (await store.findByKey(g.secret))!;
      expect(JSON.stringify(found)).not.toContain('hmac');
      expect(Object.keys(found)).not.toContain('keyHmac');
    });

    it('rejects a wrong suffix, an unknown prefix, and malformed input', async () => {
      const ws = await workspace('alpha');
      const g = await create(ws);
      const wrongSuffix = `${g.secret.slice(0, -1)}${g.secret.endsWith('a') ? 'b' : 'a'}`;
      expect(await store.findByKey(wrongSuffix)).toBeNull();
      expect(await store.findByKey(generateApiKey().key)).toBeNull();
      for (const bad of ['', 'sk_seshat_', undefined, null, 7, 'x'.repeat(100_000)]) {
        expect(await store.findByKey(bad)).toBeNull();
      }
    });

    it('rejects a key whose digest was made under a different pepper', async () => {
      const ws = await workspace('alpha');
      const g = await create(ws);
      const other = new ApiKeyStore(ds.getRepository(ApiKey), { apiKeyPepper: `${TEST_API_KEY_PEPPER}-rotated` });
      expect(await other.findByKey(g.secret)).toBeNull();
    });

    it('fails closed on a stored row with unknown permissions', async () => {
      const ws = await workspace('alpha');
      const g = await create(ws);
      await ds.query(`UPDATE api_keys SET permissions = ARRAY['search','bogus'] WHERE id = '${g.record.id}'`);
      expect((await store.findByKey(g.secret))?.permissions).toEqual([]);
    });
  });

  describe('last_used_at throttling', () => {
    const lastUsed = async (id: string) =>
      (await ds.query(`SELECT last_used_at AS t FROM api_keys WHERE id = '${id}'`))[0]!.t as Date | null;

    it('writes once, then not again within a minute, then again after it', async () => {
      const ws = await workspace('alpha');
      const { record } = await create(ws);
      expect(record.lastUsedAt).toBeNull();
      expect(await store.touchLastUsed(record.id)).toBe(true);
      const t1 = await lastUsed(record.id);
      expect(t1).toBeInstanceOf(Date);
      expect(await store.touchLastUsed(record.id)).toBe(false);
      expect((await lastUsed(record.id))!.getTime()).toBe(t1!.getTime());

      await ds.query(
        `UPDATE api_keys SET last_used_at = now() - interval '${LAST_USED_THROTTLE_SECONDS + 1} seconds' WHERE id = '${record.id}'`,
      );
      expect(await store.touchLastUsed(record.id)).toBe(true);
      expect((await lastUsed(record.id))!.getTime()).toBeGreaterThan(Date.now() - 30_000);
    });

    it('is exactly once under concurrent calls (also across connections)', async () => {
      const ws = await workspace('alpha');
      const { record } = await create(ws);
      const results = await Promise.all(Array.from({ length: 25 }, () => store.touchLastUsed(record.id)));
      expect(results.filter(Boolean)).toHaveLength(1);

      await ds.query(`UPDATE api_keys SET last_used_at = now() - interval '2 minutes' WHERE id = '${record.id}'`);
      const again = await Promise.all(Array.from({ length: 25 }, () => store.touchLastUsed(record.id)));
      expect(again.filter(Boolean)).toHaveLength(1);
    });

    it('does nothing for an unknown id', async () => {
      expect(await store.touchLastUsed('00000000-0000-4000-8000-000000000000')).toBe(false);
    });
  });

  describe('Workspace deletion', () => {
    it('cascades to all of its keys, revoked included, and leaves other Workspaces alone', async () => {
      const a = await workspace('alpha');
      const b = await workspace('beta');
      const k1 = await create(a);
      const k2 = await create(a);
      await ds.query(`UPDATE api_keys SET revoked_at = now() WHERE id = '${k2.record.id}'`);
      const kb = await create(b);

      await ds.query('DELETE FROM workspaces WHERE id = $1', [a]);

      expect(await ds.query('SELECT id FROM api_keys')).toEqual([{ id: kb.record.id }]);
      expect(await store.findByKey(k1.secret)).toBeNull();
      expect(await store.findByKey(k2.secret)).toBeNull();
      expect(await store.findByKey(kb.secret)).not.toBeNull();
    });

    it('is atomic: a rolled-back Workspace delete keeps the keys', async () => {
      const a = await workspace('alpha');
      await create(a);
      await ds
        .transaction(async (m) => {
          await m.query('DELETE FROM workspaces WHERE id = $1', [a]);
          throw new Error('rollback');
        })
        .catch(() => undefined);
      expect(await count()).toBe(1);
    });
  });

  describe('management lifecycle', () => {
    it('lists, edits and revokes by Workspace and key id, and persists the results', async () => {
      const a = await workspace('mgmt-a');
      const b = await workspace('mgmt-b');
      const k = await create(a);
      await create(b);
      expect((await store.list(a)).map((r) => r.id)).toEqual([k.record.id]);
      expect(await store.update(b, k.record.id, { name: 'hijack' })).toBe('not_found');
      expect(await store.revoke(b, k.record.id)).toBeNull();
      const edited = await store.update(a, k.record.id, { name: 'new', permissions: ['memories:read'] });
      expect(edited).toMatchObject({ name: 'new', permissions: ['memories:read'], revokedAt: null });
      const first = await store.revoke(a, k.record.id);
      const again = await store.revoke(a, k.record.id);
      expect(first?.revokedAt).toBeInstanceOf(Date);
      expect(again?.revokedAt?.getTime()).toBe(first?.revokedAt?.getTime());
      expect(await store.update(a, k.record.id, { name: 'revived' })).toBe('revoked');
      const [row] = await ds.query('SELECT name, revoked_at FROM api_keys WHERE id = $1', [k.record.id]);
      expect(row.name).toBe('new');
      expect(row.revoked_at).not.toBeNull();
      expect((await store.findByKey(k.secret))?.revokedAt).not.toBeNull();
    });

    it('deleting a Workspace removes its active and revoked keys', async () => {
      const w = await workspace('mgmt-del');
      const active = await create(w);
      const revoked = await create(w);
      await store.revoke(w, revoked.record.id);
      await ds.getRepository(Workspace).delete({ id: w });
      expect(await count()).toBe(0);
      expect(await store.findByKey(active.secret)).toBeNull();
      expect(await store.findByKey(revoked.secret)).toBeNull();
    });
  });

  describe('error logging', () => {
    it('a failing insert leaks no digest, key or pepper into logs or the thrown error', async () => {
      const lines: string[] = [];
      const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' '))),
      );
      const write = vi.spyOn(process.stderr, 'write').mockImplementation((c) => (lines.push(String(c)), true));
      try {
        const err = await create('00000000-0000-4000-8000-000000000000').catch((e) => e);
        // Same options as the app (logging: false); an error-logging data source would print the parameters.
        const text = `${err.message} ${JSON.stringify(err)} ${err.stack} ${lines.join('\n')}`;
        expect(text).not.toContain(TEST_API_KEY_PEPPER);
        expect(text).not.toMatch(/sk_seshat_/);
        expect(text).not.toMatch(/\\x[0-9a-f]{64}/i);
        expect(ds.options.logging).toBe(false);
      } finally {
        for (const s of spies) s.mockRestore();
        write.mockRestore();
      }
    });

    it('a failed data source connection error is sanitized', async () => {
      const bad = iso.createDataSource([Workspace, ApiKey]);
      bad.setOptions({ url: 'postgres://u:SENTINEL-pw@127.0.0.1:1/x' });
      const err = await initializeDatabase(bad, { migrateOnStart: false }).catch((e) => e);
      expect(String(err.message)).not.toContain('SENTINEL-pw');
    });
  });
});
