import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Permission } from '@seshat/domain';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKey } from '../src/api-keys/api-key.entity.js';
import { ApiKeyStore } from '../src/api-keys/api-key.store.js';
import { createApp } from '../src/app.setup.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthorizationService } from '../src/auth/authorization.service.js';
import { CLOCK, systemClock } from '../src/auth/login-rate-limiter.js';
import { SESSION_COOKIE_NAME } from '../src/auth/session-token.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { SanitizedExceptionFilter } from '../src/common/sanitized-exception.filter.js';
import { ConfigModule } from '../src/config/config.module.js';
import type { EmbeddingService } from '../src/ingestion/embedding.service.js';
import { MemoriesController } from '../src/memories/memories.controller.js';
import { MemoriesService } from '../src/memories/memories.service.js';
import { Memory } from '../src/memories/memory.entity.js';
import { MemoryTag } from '../src/memories/memory-tag.entity.js';
import { MemoryEmbeddingCoordinator } from '../src/memories/memory-embedding.coordinator.js';
import { MEMORY_EMBEDDING_COORDINATOR } from '../src/memories/memory-embedding.worker.js';
import type { QueueService } from '../src/queue/queue.service.js';
import { Tag } from '../src/tags/tag.entity.js';
import { TagsService } from '../src/tags/tags.service.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

/** Every text gets the same unit vector, so every Memory is a perfect similarity candidate of every other one. */
class SameVectorEmbeddings implements EmbeddingService {
  readonly model = 'deterministic';
  readonly dimension = 1536;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, ...new Array<number>(1535).fill(0)]);
  }
}

const ALL: Permission[] = ['files:read', 'files:write', 'files:delete', 'collections:read', 'collections:write', 'memories:read', 'memories:write', 'memories:delete', 'search'];
type Auth = { key?: string; none?: boolean };

describeIntegration('Memory permission and scope isolation (real PostgreSQL, HTTP)', () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  let iso: IsolatedSchema;
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let adminCookie: string;
  let wsA: string;
  let wsB: string;
  let seq = 0;
  const keys = new Map<string, { workspaceId: string; permissions: Permission[]; id: string; name: string }>();

  const bearer = (workspaceId: string, permissions: Permission[], name = 'agent key') => {
    const key = `sk_seshat_SecKey${++seq}_secret${'x'.repeat(40)}`;
    keys.set(key, { workspaceId, permissions, id: randomUUID(), name });
    return key;
  };
  async function send(method: string, p: string, body?: unknown, auth: Auth = {}) {
    const headers: Record<string, string> = {};
    if (auth.key) headers.authorization = `Bearer ${auth.key}`;
    else if (!auth.none) headers.cookie = adminCookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json };
  }
  const g = '/api/global/memories';
  const w = (id: string) => `/api/workspaces/${id}/memories`;
  const scopeOf = (b: string) => (b === g ? null : b.split('/')[3]!);
  const seed = async (b: string, content: string) => {
    const ws = scopeOf(b);
    const rows = (await ds.query(
      `INSERT INTO memories (scope, workspace_id, type, content, created_by_kind, content_hash) VALUES ($1, $2, 'fact', $3, 'admin', $4) RETURNING id`,
      [ws ? 'workspace' : 'global', ws, content, createHash('sha256').update(`${ws}${content}${randomUUID()}`).digest('hex')],
    )) as { id: string }[];
    return rows[0]!.id;
  };
  const count = async (where = 'true') => Number((await ds.query(`SELECT count(*) c FROM memories WHERE ${where}`))[0].c);
  const snapshot = async () => JSON.stringify(await ds.query('SELECT id, status, superseded_by, content, title, updated_at FROM memories ORDER BY id'));

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey, Tag, Memory, MemoryTag]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    wsA = ((await ds.query(`INSERT INTO workspaces (name, slug) VALUES ('alpha', 'alpha') RETURNING id`)) as { id: string }[])[0]!.id;
    wsB = ((await ds.query(`INSERT INTO workspaces (name, slug) VALUES ('beta', 'beta') RETURNING id`)) as { id: string }[])[0]!.id;
    for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) vi.stubEnv(k, v);
    const store = {
      findByKey: async (presented: string) => {
        const k = keys.get(presented);
        if (!k) return null;
        return { id: k.id, workspaceId: k.workspaceId, name: k.name, prefix: 'SecKey000', permissions: k.permissions, createdAt: new Date(), expiresAt: null, lastUsedAt: null, revokedAt: null };
      },
      touchLastUsed: async () => true,
    };
    const queue = { enqueueMemoryEmbedding: async () => undefined } as unknown as QueueService;
    @Module({
      imports: [ConfigModule, EventEmitterModule.forRoot()],
      controllers: [MemoriesController],
      providers: [
        { provide: CLOCK, useValue: systemClock },
        AuthService,
        SessionGuard,
        { provide: APP_GUARD, useExisting: SessionGuard },
        { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
        { provide: ApiKeyStore, useValue: store },
        AuthorizationService,
        { provide: getDataSourceToken(), useValue: ds },
        TagsService,
        {
          provide: MEMORY_EMBEDDING_COORDINATOR,
          useFactory: () => new MemoryEmbeddingCoordinator(ds, new SameVectorEmbeddings(), queue, { similarityHint: 0.9, inlineTimeoutMs: 2000, reconcileGraceMs: 0 }),
        },
        MemoriesService,
      ],
    })
    class TestRoot {}
    app = await createApp(TestRoot, { trustProxy: false }, false);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    adminCookie = `${SESSION_COOKIE_NAME}=${app.get(AuthService).issueSessionToken()}`;
  });
  afterAll(async () => {
    await app?.close();
    await iso?.dispose();
    vi.unstubAllEnvs();
  });
  beforeEach(async () => {
    await ds.query('DELETE FROM memory_tags');
    await ds.query('DELETE FROM memories');
    await ds.query('DELETE FROM tags');
  });

  // ---------------------------------------------------------------- endpoint matrix (AC-7)
  interface Op {
    name: string;
    /** Permission a key needs; `null` means the route is admin only. */
    perm: Permission | null;
    write: boolean;
    ok: number;
    call(b: string, ids: { m: string; s: string }, auth: Auth): ReturnType<typeof send>;
  }
  const full = (extra: Record<string, unknown> = {}) => ({ type: 'fact', content: `matrix ${randomUUID()}`, title: null, metadata: null, confidence: null, source: null, tags: [], ...extra });
  const OPS: Op[] = [
    { name: 'list', perm: 'memories:read', write: false, ok: 200, call: (b, _i, a) => send('GET', b, undefined, a) },
    { name: 'get', perm: 'memories:read', write: false, ok: 200, call: (b, i, a) => send('GET', `${b}/${i.m}`, undefined, a) },
    { name: 'create', perm: 'memories:write', write: true, ok: 201, call: (b, _i, a) => send('POST', b, { type: 'fact', content: `matrix ${randomUUID()}` }, a) },
    { name: 'update', perm: 'memories:write', write: true, ok: 200, call: (b, i, a) => send('PUT', `${b}/${i.m}`, full(), a) },
    { name: 'supersede', perm: 'memories:write', write: true, ok: 200, call: (b, i, a) => send('POST', `${b}/${i.m}/supersede`, { successorId: i.s }, a) },
    { name: 'retry-embedding', perm: null, write: true, ok: 409, call: (b, i, a) => send('POST', `${b}/${i.m}/retry-embedding`, undefined, a) },
    { name: 'forget', perm: 'memories:delete', write: true, ok: 204, call: (b, i, a) => send('DELETE', `${b}/${i.m}`, undefined, a) },
  ];
  const fixtures = async (b: string) => ({ m: await seed(b, 'm'), s: await seed(b, 's') });

  describe.each(OPS)('$name', (op) => {
    it('Workspace route: unauthenticated 401; admin allowed; own key by permission; foreign key concealed', async () => {
      const b = w(wsA);
      expect((await op.call(b, await fixtures(b), { none: true })).status).toBe(401);
      expect((await op.call(b, await fixtures(b), {})).status).toBe(op.ok);

      const own = bearer(wsA, op.perm ? [op.perm] : ['memories:read', 'memories:write', 'memories:delete']);
      const ownRes = await op.call(b, await fixtures(b), { key: own });
      expect(ownRes.status).toBe(op.perm ? op.ok : 403); // retry is admin only: a key is refused even with every memory permission

      // Everything except the one needed permission (and for admin-only routes: everything) is refused with 403.
      const others = bearer(wsA, ALL.filter((p) => p !== op.perm));
      const denied = await op.call(b, await fixtures(b), { key: op.perm ? others : bearer(wsA, ALL) });
      expect(denied.status).toBe(403);
      expect(denied.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // names no ids

      // A key of another Workspace, even with everything, gets exactly the answer for a Workspace that does not exist.
      const foreign = bearer(wsB, [...ALL, 'global:read']);
      const ids = await fixtures(b);
      const before = await snapshot();
      const foreignRes = await op.call(b, ids, { key: foreign });
      const ghost = w(randomUUID());
      const ghostRes = await op.call(ghost, ids, { key: foreign });
      expect(foreignRes.status).toBe(404);
      expect(foreignRes.text).toBe(ghostRes.text);
      expect(await snapshot()).toBe(before);
    });

    it('Global route: admin allowed; ungranted keys concealed; granted keys read but never write; all-permission keys still cannot write', async () => {
      expect((await op.call(g, await fixtures(g), { none: true })).status).toBe(401);
      expect((await op.call(g, await fixtures(g), {})).status).toBe(op.ok);

      const holds = op.perm ? [op.perm] : ['memories:read' as Permission];
      const ungranted = bearer(wsA, holds);
      const everything = bearer(wsA, ALL); // all ten permissions but no global:read
      const miss = await send('DELETE', `${g}/${randomUUID()}`, undefined, { key: ungranted });
      expect(miss.status).toBe(404);
      for (const k of [ungranted, everything]) {
        if (!op.perm) break; // admin-only routes answer every key with the same 403, whatever the id or scope
        const ids = await fixtures(g);
        const before = await snapshot();
        const r = await op.call(g, ids, { key: k });
        expect(r.status).toBe(404);
        expect(r.text).toBe(miss.text);
        expect(await snapshot()).toBe(before);
      }

      const granted = bearer(wsA, [...holds, 'memories:read', 'global:read']); // Global is visible only with the read permission too
      const grantedAll = bearer(wsA, [...ALL, 'global:read']);
      for (const k of [granted, grantedAll]) {
        const ids = await fixtures(g);
        const before = await snapshot();
        const r = await op.call(g, ids, { key: k });
        if (op.write) {
          expect(r.status).toBe(403); // never writable by a key, retry-embedding included
          expect(await snapshot()).toBe(before); // nothing written
        } else {
          expect(r.status).toBe(op.ok);
        }
      }
    });

    it('a write refused for a key leaves the stored data untouched', async () => {
      if (!op.write) return;
      const b = w(wsA);
      const ids = await fixtures(b);
      const before = await snapshot();
      const weak = bearer(wsA, ['memories:read', 'files:write']);
      const res = await op.call(b, ids, { key: weak });
      expect(res.status).toBe(403);
      expect(await snapshot()).toBe(before);
    });
  });

  // ---------------------------------------------------------------- references across scopes
  describe('ids and references cannot reveal other scopes', () => {
    it('supersedes and successor ids from another scope behave exactly like unknown ids and change nothing', async () => {
      const inB = await seed(w(wsB), 'in b');
      const inGlobal = await seed(g, 'in global');
      const mine = await seed(w(wsA), 'mine');
      const before = await snapshot();
      const unknown = randomUUID();
      const baseline = await send('POST', w(wsA), { type: 'fact', content: 'new one', supersedes: unknown });
      expect(baseline.status).toBe(404);
      for (const foreign of [inB, inGlobal]) {
        const r = await send('POST', w(wsA), { type: 'fact', content: 'new one', supersedes: foreign });
        expect(r.status).toBe(404);
        expect(r.text).toBe(baseline.text);
        const s = await send('POST', `${w(wsA)}/${mine}/supersede`, { successorId: foreign });
        const sBase = await send('POST', `${w(wsA)}/${mine}/supersede`, { successorId: unknown });
        expect(s.status).toBe(404);
        expect(s.text).toBe(sBase.text);
        const p = await send('POST', `${w(wsA)}/${foreign}/supersede`, { successorId: mine });
        expect(p.status).toBe(404);
        expect(p.text).toBe(sBase.text);
      }
      expect(await snapshot()).toBe(before);
    });

    it('a Memory superseded in one Workspace never shows another Workspace as its successor', async () => {
      const a1 = await seed(w(wsA), 'a1');
      const a2 = await seed(w(wsA), 'a2');
      const b1 = await seed(w(wsB), 'b1');
      expect((await send('POST', `${w(wsA)}/${a1}/supersede`, { successorId: a2 })).status).toBe(200);
      const list = await send('GET', `${w(wsB)}?status=all`);
      expect(list.json.items.map((i: any) => i.id)).toEqual([b1]);
      expect(list.text).not.toContain(a1);
      expect(list.text).not.toContain(a2);
      expect((await send('GET', `${w(wsB)}/${a1}`)).status).toBe(404);
    });

    it('shared tag names stay per scope: lists, filters and edits never cross', async () => {
      const mk = async (b: string, content: string, tags: string[]) => (await send('POST', b, { type: 'fact', content, tags })).json.id as string;
      const a = await mk(w(wsA), 'a', ['Shared', 'only-a']);
      const bb = await mk(w(wsB), 'b', ['shared']);
      const gl = await mk(g, 'gl', ['shared']);
      expect(Number((await ds.query(`SELECT count(DISTINCT scope_key) c FROM tags WHERE name = 'shared'`))[0].c)).toBe(3);
      expect((await send('GET', `${w(wsB)}/${bb}`)).json.tags).toEqual(['shared']);
      const filtered = await send('GET', `${w(wsB)}?tag=shared`);
      expect(filtered.json.items.map((i: any) => i.id)).toEqual([bb]);
      // A tag that exists only elsewhere answers like a tag that exists nowhere.
      const foreignTag = await send('GET', `${w(wsB)}?tag=only-a`);
      const nowhere = await send('GET', `${w(wsB)}?tag=nowhere`);
      expect(foreignTag.text).toBe(nowhere.text);
      expect(foreignTag.json.items).toEqual([]);
      // Editing or emptying tags in A leaves B and Global untouched.
      expect((await send('PUT', `${w(wsA)}/${a}`, full({ content: 'a', tags: [] }))).json.tags).toEqual([]);
      expect((await send('GET', `${w(wsB)}/${bb}`)).json.tags).toEqual(['shared']);
      expect((await send('GET', `${g}/${gl}`)).json.tags).toEqual(['shared']);
    });

    it('a duplicate create never reuses, tags or reveals a Memory of another scope', async () => {
      const original = await send('POST', w(wsA), { type: 'fact', content: 'same text', title: 'private title', metadata: { secret: 'meta' }, tags: ['a-tag'] });
      for (const target of [w(wsB), g]) {
        const r = await send('POST', target, { type: 'fact', content: 'same text', tags: ['other'] });
        expect(r.status).toBe(201);
        expect(r.json).toMatchObject({ deduplicated: false, title: null, metadata: null, tags: ['other'] });
        expect(r.json.id).not.toBe(original.json.id);
        expect(r.text).not.toContain(original.json.id);
        expect(r.text).not.toContain('private title');
      }
      expect((await send('GET', `${w(wsA)}/${original.json.id}`)).json.tags).toEqual(['a-tag']);
    });

    it('similarity hints list only same-scope active Memories and never other scopes', async () => {
      const inA = await send('POST', w(wsA), { type: 'fact', content: 'alpha record' });
      const inB = await send('POST', w(wsB), { type: 'fact', content: 'beta record' });
      const inG = await send('POST', g, { type: 'fact', content: 'global record' });
      expect(inA.json.hints).toEqual([]);
      expect(inB.json.hints).toEqual([]); // a perfect match exists in A, but B must not see it
      expect(inG.json.hints).toEqual([]);
      const next = await send('POST', w(wsA), { type: 'decision', content: 'another alpha record' });
      expect(next.json.hints.map((h: any) => h.id)).toEqual([inA.json.id]);
      expect(next.text).not.toContain(inB.json.id);
      expect(next.text).not.toContain(inG.json.id);
      expect(next.text).not.toContain('beta record');
    });

    it('a key without memories:read gets no similarity previews, a reader does', async () => {
      await send('POST', w(wsA), { type: 'fact', content: 'existing private text' });
      const writeOnly = bearer(wsA, ['memories:write']);
      const r = await send('POST', w(wsA), { type: 'fact', content: 'new text' }, { key: writeOnly });
      expect(r.status).toBe(201);
      expect(r.json.hints).toEqual([]);
      expect(r.text).not.toContain('existing private text');
      const rw = bearer(wsA, ['memories:write', 'memories:read']);
      const r2 = await send('POST', w(wsA), { type: 'fact', content: 'third text' }, { key: rw });
      expect(r2.json.hints.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------- forged provenance and key snapshots (AC-6)
  describe('provenance is server-owned', () => {
    it('forged provenance never enters a stored record, on create, update, supersede or duplicate', async () => {
      const forged = [{ createdBy: { kind: 'admin' } }, { provenance: { client: { name: 'evil' } } }, { clientName: 'evil', clientVersion: '9' }, { createdByKeyId: randomUUID() }, { created_by_kind: 'admin' }];
      const key = bearer(wsA, ['memories:read', 'memories:write'], 'honest');
      const base0 = await send('POST', w(wsA), { type: 'fact', content: 'prov' }, { key });
      expect(base0.status).toBe(201);
      for (const extra of forged) {
        expect((await send('POST', w(wsA), { type: 'fact', content: 'x', ...extra }, { key })).status).toBe(400);
        expect((await send('POST', w(wsA), { type: 'fact', content: 'prov', ...extra }, { key })).status).toBe(400);
        expect((await send('PUT', `${w(wsA)}/${base0.json.id}`, full({ content: 'prov', ...extra }), { key })).status).toBe(400);
      }
      const row = (await ds.query('SELECT created_by_kind, created_by_key_id, created_by_key_name, client_name, client_version FROM memories'))[0];
      expect(row).toMatchObject({ created_by_kind: 'api_key', created_by_key_name: 'honest', client_name: null, client_version: null });
      expect(await count()).toBe(1);
    });

    it('an update, a duplicate create and a supersede by another principal keep the original provenance', async () => {
      const k1 = bearer(wsA, ['memories:read', 'memories:write'], 'first key');
      const k2 = bearer(wsA, ['memories:read', 'memories:write'], 'second key');
      const a = await send('POST', w(wsA), { type: 'fact', content: 'orig' }, { key: k1 });
      const expected = { createdBy: { kind: 'api_key', keyId: keys.get(k1)!.id, keyName: 'first key' }, client: null };
      expect(a.json.provenance).toEqual(expected);
      expect((await send('PUT', `${w(wsA)}/${a.json.id}`, full({ content: 'changed' }), { key: k2 })).json.provenance).toEqual(expected);
      expect((await send('PUT', `${w(wsA)}/${a.json.id}`, full({ content: 'changed' }))).json.provenance).toEqual(expected);
      const dup = await send('POST', w(wsA), { type: 'fact', content: 'changed' }, { key: k2 });
      expect(dup.json).toMatchObject({ deduplicated: true, provenance: expected });
      const b = await send('POST', w(wsA), { type: 'fact', content: 'successor' });
      const sup = await send('POST', `${w(wsA)}/${a.json.id}/supersede`, { successorId: b.json.id }, { key: k2 });
      expect(sup.json.provenance).toEqual(expected);
    });

    it('the stored key id and name snapshot survives rename, revocation and expiry of the key', async () => {
      const key = bearer(wsA, ['memories:read', 'memories:write'], 'before rename');
      const keyId = keys.get(key)!.id;
      const created = await send('POST', w(wsA), { type: 'fact', content: 'snapshot' }, { key });
      keys.get(key)!.name = 'after rename';
      keys.get(key)!.permissions = ['memories:read'];
      const second = bearer(wsA, ['memories:read', 'memories:write'], 'reader');
      const renamed = await send('GET', `${w(wsA)}/${created.json.id}`, undefined, { key: second });
      expect(renamed.json.provenance.createdBy).toEqual({ kind: 'api_key', keyId, keyName: 'before rename' });
      keys.delete(key); // revoked
      expect((await send('GET', `${w(wsA)}/${created.json.id}`, undefined, { key })).status).toBe(401);
      const afterRevoke = await send('GET', `${w(wsA)}/${created.json.id}`);
      expect(afterRevoke.json.provenance.createdBy).toEqual({ kind: 'api_key', keyId, keyName: 'before rename' });
      const list = await send('GET', w(wsA));
      expect(list.json.items[0].provenance.createdBy).toEqual({ kind: 'api_key', keyId, keyName: 'before rename' });
      // Deleting the key row from api_keys must not touch the Memory either (no FK): simulated with the stored columns.
      const row = (await ds.query('SELECT created_by_key_id, created_by_key_name FROM memories WHERE id = $1', [created.json.id]))[0];
      expect(row).toEqual({ created_by_key_id: keyId, created_by_key_name: 'before rename' });
    });
  });

  // ---------------------------------------------------------------- concurrency regression (AC-2/3)
  describe('concurrent lifecycle regression', () => {
    it('duplicates in several scopes at once stay one active record per scope', async () => {
      const targets = [w(wsA), w(wsB), g];
      const results = await Promise.all(targets.flatMap((t) => Array.from({ length: 6 }, (_, i) => send('POST', t, { type: 'fact', content: 'burst', tags: [`t${i}`] }).then((r) => ({ t, r })))));
      for (const t of targets) {
        const rs = results.filter((x) => x.t === t).map((x) => x.r);
        expect(rs.filter((r) => r.json.deduplicated === false)).toHaveLength(1);
        expect(new Set(rs.map((r) => r.json.id)).size).toBe(1);
      }
      expect(await count()).toBe(3);
      expect(await count(`status = 'active'`)).toBe(3);
    });

    it('a mixed burst of supersede, update and forget on one pair never leaves a dangling or cyclic link', async () => {
      for (let round = 0; round < 6; round++) {
        const b = w(wsA);
        const ids = await fixtures(b);
        await Promise.all([
          send('POST', `${b}/${ids.m}/supersede`, { successorId: ids.s }),
          send('POST', `${b}/${ids.s}/supersede`, { successorId: ids.m }),
          send('PUT', `${b}/${ids.m}`, full({ content: `upd ${round}` })),
          send('PUT', `${b}/${ids.s}`, full({ content: `upd s ${round}` })),
          send('DELETE', `${b}/${round % 2 ? ids.m : ids.s}`),
        ]);
        const dangling = Number((await ds.query(`SELECT count(*) c FROM memories m WHERE m.superseded_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memories n WHERE n.id = m.superseded_by)`))[0].c);
        const cycles = Number((await ds.query(`SELECT count(*) c FROM memories a JOIN memories b ON a.superseded_by = b.id AND b.superseded_by = a.id`))[0].c);
        const badStatus = Number((await ds.query(`SELECT count(*) c FROM memories WHERE (status = 'superseded') <> (superseded_by IS NOT NULL) AND status = 'active' AND superseded_by IS NOT NULL`))[0].c);
        expect({ dangling, cycles, badStatus }).toEqual({ dangling: 0, cycles: 0, badStatus: 0 });
        await ds.query('DELETE FROM memories');
      }
    });
  });
});
