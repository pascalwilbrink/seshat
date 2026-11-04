import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTIONS, PERMISSIONS, type Permission } from '@seshat/domain';
import { computeApiKeyHmac } from '../../src/api-keys/api-key-crypto.js';
import { TEST_API_KEY_PEPPER } from '../fixtures/admin.js';
import { EXPECTED, expectedOutcome } from './policy-oracle.js';
import type { Raw, SecurityApp } from './security-app.js';

export interface World {
  app: SecurityApp;
  own: { id: string; slug: string; name: string };
  foreign: { id: string; slug: string; name: string };
  /** Persists a key (through the real store contract) and returns its full secret, for the test only. */
  createKey(workspaceId: string, permissions: readonly Permission[], opts?: { expired?: boolean }): Promise<{ id: string; secret: string }>;
  revokeKey(workspaceId: string, id: string): Promise<void>;
  close(): Promise<void>;
}

const GENERIC_401 = { statusCode: 401, message: 'Unauthorized' };
const OPERATIONAL = PERMISSIONS.filter((p) => p !== 'global:read');

/** Singleton, dual-grant, global-only, all, and all-but-global sets: covers every permission and the Global grant. */
export function permissionSetsForMatrix(): Array<[string, Permission[]]> {
  const sets: Array<[string, Permission[]]> = [];
  for (const p of OPERATIONAL) {
    sets.push([`only ${p}`, [p]]);
    sets.push([`${p} + global:read`, [p, 'global:read']]);
  }
  sets.push(['only global:read', ['global:read']]);
  sets.push(['all', [...PERMISSIONS]]);
  sets.push(['all but global:read', [...OPERATIONAL]]);
  return sets;
}

const comparable = (r: Raw) => ({ status: r.status, headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => k !== 'date')), bytes: r.bytes.toString('base64') });

/** Everything in a response that could carry a credential. */
export function leakNeedles(secrets: string[]): string[] {
  const out = [TEST_API_KEY_PEPPER];
  for (const s of secrets) {
    const parts = s.split('_');
    out.push(s, parts[3]!);
    const hmac = computeApiKeyHmac(TEST_API_KEY_PEPPER, s);
    out.push(hmac.toString('hex'), hmac.toString('base64'), hmac.toString('base64url'));
  }
  return out;
}

/**
 * The shared HTTP security suite (AC-3 to AC-8, AC-10). It runs against the DB-free in-memory world in
 * `pnpm test` and against real PostgreSQL in the integration project, with identical assertions.
 */
export function defineSecuritySuite(name: string, makeWorld: () => Promise<World>): void {
  describe(name, () => {
    let w: World;
    let own: string;
    let foreign: string;
    const missing = randomUUID();
    const path = (action: string, where: 'own' | 'foreign' | 'missing' | 'global') =>
      where === 'global' ? `/api/probe/global/${encodeURIComponent(action)}` : `/api/probe/workspaces/${{ own, foreign, missing }[where]}/${encodeURIComponent(action)}`;
    const call = (action: string, where: 'own' | 'foreign' | 'missing' | 'global', bearer: string) => w.app.http('GET', path(action, where), { bearer });

    beforeAll(async () => {
      w = await makeWorld();
      own = w.own.id;
      foreign = w.foreign.id;
    });
    afterAll(async () => w?.close());

    describe('AC-8 / AC-3 / AC-4 / AC-5 / AC-6: every permission set x every catalog action x own / foreign / missing Workspace / Global', () => {
      for (const [label, held] of permissionSetsForMatrix()) {
        it(`active key with ${label}`, async () => {
          const { secret } = await w.createKey(own, held);
          for (const action of ACTIONS) {
            const [ownRes, foreignRes, missingRes, globalRes] = await Promise.all((['own', 'foreign', 'missing', 'global'] as const).map((where) => call(action, where, secret)));
            const check = (res: Raw, where: 'own' | 'other' | 'global') => {
              const want = expectedOutcome(action, held, where);
              const ctx = `${action} ${where} [${label}]`;
              if (want.status === 'allow') {
                expect(res.status, ctx).toBe(200);
                expect(res.text, ctx).toBe('{"ok":true}');
              } else if (want.status === 404) {
                expect(res.status, ctx).toBe(404);
              } else {
                expect(res.status, ctx).toBe(403);
                expect(JSON.parse(res.text).message, ctx).toBe(want.message);
              }
            };
            check(ownRes!, 'own');
            check(foreignRes!, 'other');
            check(missingRes!, 'other');
            check(globalRes!, 'global');
            // AC-5: an existing foreign Workspace and a nonexistent one are byte-identical.
            expect(comparable(foreignRes!), `${action} [${label}]`).toEqual(comparable(missingRes!));
            expect(Buffer.compare(foreignRes!.bytes, missingRes!.bytes), `${action} [${label}]`).toBe(0);
          }
        });
      }

      it('covers every catalog action in the independent oracle (no action escapes the matrix)', () => {
        expect([...ACTIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
      });
    });

    describe('AC-3: revoked and expired keys always stop at the generic 401 before any action handling', () => {
      it('gives the same 401, byte for byte, as an unknown or malformed key, for every action and scope', async () => {
        const revoked = await w.createKey(own, [...PERMISSIONS]);
        await w.revokeKey(own, revoked.id);
        const expired = await w.createKey(own, [...PERMISSIONS], { expired: true });
        const unknown = 'sk_seshat_ZzZzZzZz_UNKNOWN0123456789abcdefghijklmnopqrstu';
        const before = w.app.probe.handled;
        for (const action of ACTIONS) {
          for (const where of ['own', 'foreign', 'missing', 'global'] as const) {
            const results = await Promise.all([revoked.secret, expired.secret, unknown, 'garbage'].map((k) => call(action, where, k)));
            for (const r of results) {
              expect(r.status, `${action} ${where}`).toBe(401);
              expect(JSON.parse(r.text)).toEqual(expect.objectContaining(GENERIC_401));
              expect(comparable(r)).toEqual(comparable(results[0]!));
            }
          }
        }
        expect(w.app.probe.handled).toBe(before);
      });

      it('applies revocation and permission edits on the very next request', async () => {
        const created = await w.app.http('POST', `/api/workspaces/${own}/api-keys`, { admin: true, body: { name: 'live', permissions: ['files:read', 'files:write'] } });
        expect(created.status).toBe(201);
        const { secret, apiKey } = JSON.parse(created.text) as { secret: string; apiKey: { id: string } };
        expect((await call('file.upload', 'own', secret)).status).toBe(200);
        const edit = await w.app.http('PUT', `/api/workspaces/${own}/api-keys/${apiKey.id}`, { admin: true, body: { name: 'k', permissions: ['files:read'] } });
        expect(edit.status).toBe(200);
        const denied = await call('file.upload', 'own', secret);
        expect(denied.status).toBe(403);
        expect(JSON.parse(denied.text).message).toBe('Missing permission: files:write');
        expect((await call('file.list', 'own', secret)).status).toBe(200);
        const revoke = await w.app.http('POST', `/api/workspaces/${own}/api-keys/${apiKey.id}/revoke`, { admin: true });
        expect(revoke.status).toBe(200);
        const after = await call('file.list', 'own', secret);
        expect(after.status).toBe(401);
        expect(JSON.parse(after.text)).toEqual(expect.objectContaining(GENERIC_401));
        // Revocation is irreversible: it cannot be edited back to life.
        expect((await w.app.http('PUT', `/api/workspaces/${own}/api-keys/${apiKey.id}`, { admin: true, body: { name: 'again', permissions: ['files:read'] } })).status).toBe(409);
        expect((await call('file.list', 'own', secret)).status).toBe(401);
      });
    });

    describe('AC-5: raw response bytes for a foreign and a nonexistent Workspace', () => {
      it('are byte-identical and disclose no Workspace id, name, slug, path or timestamp', async () => {
        const sets: Permission[][] = [[...PERMISSIONS], ['files:read'], ['global:read'], ['search', 'global:read']];
        for (const held of sets) {
          const { secret } = await w.createKey(own, held);
          for (const action of ACTIONS) {
            const a = await call(action, 'foreign', secret);
            const b = await call(action, 'missing', secret);
            expect(a.status).toBe(404);
            expect(Buffer.compare(a.bytes, b.bytes)).toBe(0);
            expect(comparable(a)).toEqual(comparable(b));
            for (const needle of [foreign, missing, w.foreign.slug, w.foreign.name, w.own.id, '/api/', 'createdAt', 'updatedAt']) {
              expect(a.text, `${action} ${needle}`).not.toContain(needle);
            }
          }
        }
      });
    });

    describe('AC-4: the 403 for a missing permission names only what is required', () => {
      it('contains the permission identifier and no resource or Workspace detail', async () => {
        const { secret } = await w.createKey(own, ['search']);
        const res = await call('file.delete', 'own', secret);
        expect(res.status).toBe(403);
        const body = JSON.parse(res.text);
        expect(Object.keys(body).sort()).toEqual(['error', 'message', 'statusCode']);
        expect(body.message).toBe('Missing permission: files:delete');
        for (const needle of [own, w.own.slug, w.own.name, foreign, 'search']) expect(res.text).not.toContain(needle);
        // Dual Global grant: both missing grants are named, nothing else.
        const other = await w.createKey(own, ['files:write']);
        const g = await call('search.query', 'global', other.secret);
        expect(JSON.parse(g.text).message).toBe('Missing permission: search, global:read');
        // Files, Collections and Tags conceal Global: no grant is the generic missing-resource 404.
        const hidden = await call('file.list', 'global', secret);
        expect(hidden.status).toBe(404);
        expect(JSON.parse(hidden.text)).toEqual({ message: 'Not Found', error: 'Not Found', statusCode: 404 });
        // A Global mutation is a plain 403, whatever the key holds.
        const all = await w.createKey(own, [...PERMISSIONS]);
        for (const action of ACTIONS.filter((a) => ['write', 'delete', 'admin'].includes(EXPECTED[a]!.kind))) {
          const r = await call(action, 'global', all.secret);
          expect(r.status, action).toBe(403);
          expect(JSON.parse(r.text).message, action).toBe('Forbidden');
        }
      });
    });

    describe('AC-7: a key cannot manage keys or Workspaces; the admin still can', () => {
      it('denies every key-management and Workspace-management route to a key with all permissions', async () => {
        const { secret, id: keyId } = await w.createKey(own, [...PERMISSIONS]);
        const keyRoute = (ws: string) => `/api/workspaces/${ws}/api-keys`;
        const attempts: Array<[string, string, unknown?]> = [
          ['GET', keyRoute(own)],
          ['POST', keyRoute(own), { name: 'escalate', permissions: ['files:read'] }],
          ['PUT', `${keyRoute(own)}/${keyId}`, { name: 'renamed', permissions: ['files:read'] }],
          ['POST', `${keyRoute(own)}/${keyId}/revoke`],
          ['GET', '/api/global/workspaces'],
          ['POST', '/api/global/workspaces', { name: 'Created by key' }],
          ['GET', `/api/workspaces/${own}`],
          ['PUT', `/api/workspaces/${own}`, { name: 'Hijacked', description: null }],
          ['DELETE', `/api/workspaces/${own}`, { slug: w.own.slug }],
          ['GET', `/api/workspaces/${own}/overview`],
          ['GET', '/api/global/overview'],
          ['POST', '/api/auth/logout'],
        ];
        for (const [method, p, body] of attempts) {
          const res = await w.app.http(method, p, { bearer: secret, body });
          expect(res.status, `${method} ${p}`).toBe(403);
          expect(JSON.parse(res.text).message).toBe('Forbidden');
        }
        // Another Workspace's key routes: indistinguishable from a missing Workspace.
        const f = await w.app.http('GET', keyRoute(foreign), { bearer: secret });
        const m = await w.app.http('GET', keyRoute(missing), { bearer: secret });
        expect(f.status).toBe(404);
        expect(Buffer.compare(f.bytes, m.bytes)).toBe(0);
        // Nothing changed.
        const list = JSON.parse((await w.app.http('GET', keyRoute(own), { admin: true })).text) as Array<{ id: string; name: string; status: string }>;
        expect(list.find((k) => k.id === keyId)).toMatchObject({ status: 'active' });
        expect(list.some((k) => k.name === 'escalate' || k.name === 'renamed')).toBe(false);
        expect((await w.app.http('GET', `/api/workspaces/${own}`, { admin: true })).status).toBe(200);
        expect(JSON.parse((await w.app.http('GET', '/api/global/workspaces', { admin: true })).text).some((x: { name: string }) => x.name === 'Created by key')).toBe(false);
      });

      it('lets the admin list, create, edit and revoke keys and manage Workspaces', async () => {
        const created = await w.app.http('POST', `/api/workspaces/${own}/api-keys`, { admin: true, body: { name: 'admin made', permissions: ['search'] } });
        expect(created.status).toBe(201);
        const id = JSON.parse(created.text).apiKey.id as string;
        expect((await w.app.http('GET', `/api/workspaces/${own}/api-keys`, { admin: true })).status).toBe(200);
        expect((await w.app.http('PUT', `/api/workspaces/${own}/api-keys/${id}`, { admin: true, body: { name: 'admin renamed', permissions: ['files:read'] } })).status).toBe(200);
        expect((await w.app.http('POST', `/api/workspaces/${own}/api-keys/${id}/revoke`, { admin: true })).status).toBe(200);
        expect((await w.app.http('GET', '/api/global/workspaces', { admin: true })).status).toBe(200);
        expect((await w.app.http('GET', `/api/workspaces/${own}`, { admin: true })).status).toBe(200);
        expect((await w.app.http('GET', `/api/workspaces/${own}/overview`, { admin: true })).status).toBe(200);
        expect((await w.app.http('GET', '/api/auth/me', { admin: true })).status).toBe(200);
      });

      it('answers every probe action for the admin with allow in the existing scopes and 404 only for a missing Workspace', async () => {
        for (const action of ACTIONS) {
          for (const where of ['own', 'foreign', 'global'] as const) {
            const r = await w.app.http('GET', path(action, where), { admin: true });
            expect(r.status, `${action} ${where}`).toBe(200);
          }
          expect((await w.app.http('GET', path(action, 'missing'), { admin: true })).status).toBe(404);
        }
      });
    });
  });
}
