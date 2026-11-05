import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
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
import { MemoriesController } from '../src/memories/memories.controller.js';
import { MemoriesService } from '../src/memories/memories.service.js';
import { Memory } from '../src/memories/memory.entity.js';
import { MemoryTag } from '../src/memories/memory-tag.entity.js';
import { Tag } from '../src/tags/tag.entity.js';
import { TagsService } from '../src/tags/tags.service.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

describeIntegration('Memory get and list (real PostgreSQL, HTTP)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let adminCookie: string;
  let wsA: string;
  let wsB: string;
  let failTagUnion = false;
  const keys = new Map<string, { workspaceId: string; permissions: Permission[]; id: string; name: string }>();
  let seq = 0;

  const bearer = (workspaceId: string, permissions: Permission[], name = 'agent key') => {
    const key = `sk_seshat_TestKey${++seq}_secret${'x'.repeat(40)}`;
    keys.set(key, { workspaceId, permissions, id: randomUUID(), name });
    return key;
  };
  type Auth = { key?: string };
  async function send(method: string, p: string, body?: unknown, auth: Auth = {}) {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { ...(auth.key ? { authorization: `Bearer ${auth.key}` } : { cookie: adminCookie }), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json };
  }
  const addWorkspace = async (slug: string) => ((await ds.query('INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id', [slug])) as { id: string }[])[0]!.id;
  const g = '/api/global/memories';
  const w = (id: string) => `/api/workspaces/${id}/memories`;
  const body = (content: string, extra: Record<string, unknown> = {}) => ({ type: 'fact', content, ...extra });
  const mk = async (p: string, content: string, extra: Record<string, unknown> = {}) => {
    const r = await send('POST', p, body(content, extra));
    expect(r.status).toBe(201);
    return r.json as { id: string };
  };
  const count = async () => Number((await ds.query('SELECT count(*) c FROM memories'))[0].c);
  const row = async (id: string) => (await ds.query('SELECT * FROM memories WHERE id = $1', [id]))[0] as any;
  const tagsOf = async (id: string) => (await ds.query('SELECT t.name FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.memory_id = $1 ORDER BY t.name', [id])).map((r: any) => r.name);
  const put = (p: string, id: string, extra: Record<string, unknown> = {}, auth: Auth = {}) =>
    send('PUT', `${p}/${id}`, { type: 'fact', content: 'x', title: null, metadata: null, confidence: null, source: null, tags: [], ...extra }, auth);

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey, Tag, Memory, MemoryTag]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    wsA = await addWorkspace('alpha');
    wsB = await addWorkspace('beta');
    for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) vi.stubEnv(k, v);
    const store = {
      findByKey: async (presented: string) => {
        const k = keys.get(presented);
        if (!k) return null;
        return { id: k.id, workspaceId: k.workspaceId, name: k.name, prefix: 'TestKey00', permissions: k.permissions, createdAt: new Date(), expiresAt: null, lastUsedAt: null, revokedAt: null };
      },
      touchLastUsed: async () => true,
    };
    class FlakyTags extends TagsService {
      override async unionMemoryTags(...args: Parameters<TagsService['unionMemoryTags']>) {
        if (failTagUnion) throw new Error('injected');
        return super.unionMemoryTags(...args);
      }
    }
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
        { provide: TagsService, useClass: FlakyTags },
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
    failTagUnion = false;
    await ds.query('DELETE FROM memory_tags');
    await ds.query('DELETE FROM memories');
    await ds.query('DELETE FROM tags');
  });

  const seed = async (scopeKind: 'g' | string, content: string, o: { type?: string; title?: string | null; status?: string; createdAt?: string; updatedAt?: string; id?: string; tags?: string[]; successor?: string } = {}) => {
    const id = o.id ?? randomUUID();
    const wid = scopeKind === 'g' ? null : scopeKind;
    await ds.query(
      `INSERT INTO memories (id, scope, workspace_id, type, content, title, status, superseded_by, created_by_kind, content_hash, created_at, updated_at, embedding_status)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8::uuid, 'admin', encode(sha256(convert_to($5::text || $1::text, 'UTF8')), 'hex'), $9::timestamptz, $10::timestamptz, 'pending')`,
      [id, wid ? 'workspace' : 'global', wid, o.type ?? 'fact', content, o.title ?? null, o.status ?? 'active', o.successor ?? null, o.createdAt ?? '2026-01-01T00:00:00Z', o.updatedAt ?? o.createdAt ?? '2026-01-01T00:00:00Z'],
    );
    for (const t of o.tags ?? []) {
      const sk = wid ?? 'global';
      const r = (await ds.query(`INSERT INTO tags (scope, workspace_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`, [wid ? 'workspace' : 'global', wid, t])) as { id: string }[];
      const tagId = r[0]?.id ?? ((await ds.query(`SELECT id FROM tags WHERE scope_key = $1 AND name = $2`, [sk, t])) as { id: string }[])[0]!.id;
      await ds.query(`INSERT INTO memory_tags (memory_id, tag_id, scope_key) VALUES ($1, $2, $3)`, [id, tagId, sk]);
    }
    return id;
  };
  const ids = (r: { json: any }) => (r.json.items as { id: string }[]).map((i) => i.id);

  describe('get', () => {
    it('returns an allowlisted DTO with tags, provenance and embedding status, never a vector or hash', async () => {
      const m = await mk(w(wsA), 'hello', { tags: ['b', 'a'], title: 'T' });
      const r = await send('GET', `${w(wsA)}/${m.id}`);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ id: m.id, scope: 'workspace', workspaceId: wsA, tags: ['a', 'b'], status: 'active', supersededBy: null, embeddingStatus: 'pending', provenance: { createdBy: { kind: 'admin' } } });
      expect(Object.keys(r.json).sort()).not.toEqual(expect.arrayContaining(['embedding']));
      expect(r.text).not.toMatch(/embedding"|content_hash|contentHash|\[0\./);
    });

    it('shows a superseded record with its same-scope successor id', async () => {
      const succ = await mk(g, 'new');
      const old = await mk(g, 'old');
      expect((await send('POST', `${g}/${old.id}/supersede`, { successorId: succ.id })).status).toBe(200);
      const r = await send('GET', `${g}/${old.id}`);
      expect(r.json).toMatchObject({ status: 'superseded', supersededBy: succ.id });
    });

    it('treats foreign, missing, malformed and ungranted ids identically', async () => {
      const inA = await mk(w(wsA), 'secret');
      const inG = await mk(g, 'global secret');
      const missing = await send('GET', `${w(wsA)}/${randomUUID()}`);
      expect(missing.status).toBe(404);
      const foreign = await send('GET', `${w(wsB)}/${inA.id}`);
      const viaGlobal = await send('GET', `${g}/${inA.id}`);
      const globalViaWs = await send('GET', `${w(wsA)}/${inG.id}`);
      const malformed = await send('GET', `${w(wsA)}/nope`);
      for (const r of [foreign, viaGlobal, globalViaWs, malformed]) expect(r.text).toBe(missing.text);
      expect([foreign, viaGlobal, globalViaWs, malformed].map((r) => r.status)).toEqual([404, 404, 404, 404]);
      const keyB = bearer(wsB, ['memories:read']);
      const k1 = await send('GET', `${w(wsA)}/${inA.id}`, undefined, { key: keyB });
      const noGrant = await send('GET', `${g}/${inG.id}`, undefined, { key: keyB });
      const noGrantMissing = await send('GET', `${g}/${randomUUID()}`, undefined, { key: keyB });
      expect(k1.status).toBe(404);
      expect(noGrant.status).toBe(404);
      expect(noGrant.text).toBe(noGrantMissing.text);
      expect((await send('GET', `/api/workspaces/${randomUUID()}/memories/${inA.id}`)).status).toBe(404);
    });

    it('lets keys read only their own Workspace with memories:read, and Global only with global:read too', async () => {
      const inA = await mk(w(wsA), 'a');
      const inG = await mk(g, 'g');
      const noPerm = bearer(wsA, ['files:read', 'global:read']);
      expect((await send('GET', `${w(wsA)}/${inA.id}`, undefined, { key: noPerm })).status).toBe(403);
      const ws = bearer(wsA, ['memories:read']);
      expect((await send('GET', `${w(wsA)}/${inA.id}`, undefined, { key: ws })).status).toBe(200);
      expect((await send('GET', `${g}/${inG.id}`, undefined, { key: ws })).status).toBe(404);
      const withGlobal = bearer(wsA, ['memories:read', 'global:read']);
      expect((await send('GET', `${g}/${inG.id}`, undefined, { key: withGlobal })).status).toBe(200);
      expect((await send('GET', g, undefined, { key: ws })).status).toBe(404);
      expect((await send('GET', g, undefined, { key: withGlobal })).status).toBe(200);
      expect((await send('GET', w(wsA), undefined, { key: bearer(wsB, ['memories:read', 'global:read']) })).status).toBe(404);
    });

    it('rejects an unauthenticated caller', async () => {
      const res = await fetch(`${base}${g}`);
      expect(res.status).toBe(401);
    });
  });

  describe('list', () => {
    it('is scoped: Global and each Workspace see only their own records', async () => {
      const a = await seed(wsA, 'a');
      const b = await seed(wsB, 'b');
      const gl = await seed('g', 'g');
      expect(ids(await send('GET', w(wsA)))).toEqual([a]);
      expect(ids(await send('GET', w(wsB)))).toEqual([b]);
      expect(ids(await send('GET', g))).toEqual([gl]);
      expect((await send('GET', `/api/workspaces/${randomUUID()}/memories`)).status).toBe(404);
    });

    it('orders newest first and pages across equal timestamps without repeats or gaps', async () => {
      const same = '2026-03-01T10:00:00.123456Z';
      const all: string[] = [];
      for (let n = 0; n < 7; n++) all.push(await seed(wsA, `m${n}`, { createdAt: same }));
      const newest = await seed(wsA, 'newest', { createdAt: '2026-04-01T00:00:00Z' });
      const oldest = await seed(wsA, 'oldest', { createdAt: '2025-01-01T00:00:00Z' });
      const expected = [newest, ...[...all].sort().reverse(), oldest];
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const r = await send('GET', `${w(wsA)}?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
        expect(r.status).toBe(200);
        seen.push(...ids(r));
        cursor = r.json.nextCursor;
        expect(r.json.hasMore).toBe(cursor !== null);
        pages++;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toEqual(expected);
    });

    it('preserves microsecond precision in the cursor', async () => {
      const a = await seed(wsA, 'a', { createdAt: '2026-03-01T10:00:00.000001Z' });
      const b = await seed(wsA, 'b', { createdAt: '2026-03-01T10:00:00.000002Z' });
      const first = await send('GET', `${w(wsA)}?limit=1`);
      expect(ids(first)).toEqual([b]);
      expect(ids(await send('GET', `${w(wsA)}?limit=1&cursor=${first.json.nextCursor}`))).toEqual([a]);
    });

    it('defaults to active; superseded and all are explicit and show successor ids without crossing scopes', async () => {
      const succ = await seed(wsA, 'succ');
      const old = await seed(wsA, 'old', { status: 'superseded', successor: succ, createdAt: '2025-01-01T00:00:00Z' });
      await seed(wsB, 'other', { status: 'superseded' });
      expect(ids(await send('GET', w(wsA)))).toEqual([succ]);
      const sup = await send('GET', `${w(wsA)}?status=superseded`);
      expect(ids(sup)).toEqual([old]);
      expect(sup.json.items[0].supersededBy).toBe(succ);
      expect(ids(await send('GET', `${w(wsA)}?status=all`))).toEqual([succ, old]);
      expect(ids(await send('GET', `${w(wsA)}?status=active`))).toEqual([succ]);
    });

    it('filters by type, normalized tag, ranges and literal text, individually and combined', async () => {
      const p = await seed(wsA, 'Pay 50% off_now', { type: 'fact', title: 'Prices', tags: ['finance', 'sale'], createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-10T00:00:00Z' });
      const q = await seed(wsA, 'Pay 50X off_now', { type: 'decision', tags: ['finance'], createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-10T00:00:00Z' });
      const r = await seed(wsA, 'ÉCOLE naïve ☃', { type: 'fact', tags: ['sale'], createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-10T00:00:00Z' });
      await seed(wsB, 'Pay 50% off_now', { tags: ['finance'] });
      const get = async (qs: string) => ids(await send('GET', `${w(wsA)}?${qs}`));
      expect(await get('type=fact')).toEqual([r, p]);
      expect(await get('type=decision')).toEqual([q]);
      expect(await get('tag=FINANCE')).toEqual([q, p]);
      expect(await get('tag=sale&type=fact')).toEqual([r, p]);
      expect(await get('createdFrom=2026-03-01T00:00:00Z')).toEqual([r, q]);
      expect(await get('createdTo=2026-03-01')).toEqual([q, p]);
      expect(await get('createdFrom=2026-02-01&createdTo=2026-03-01T00:00:00Z')).toEqual([q, p]);
      expect(await get('updatedFrom=2026-03-05&updatedTo=2026-04-10T00:00:00Z')).toEqual([r, q]);
      expect(await get('text=50%25')).toEqual([p]);
      expect(await get('text=_now')).toEqual([q, p]);
      expect(await get('text=50_')).toEqual([]);
      expect(await get('text=%25')).toEqual([p]);
      expect(await get('text=prices')).toEqual([p]);
      expect(await get('text=%C3%A9cole')).toEqual([r]);
      expect(await get('text=%E2%98%83')).toEqual([r]);
      expect(await get("text=%27%3B%20DROP%20TABLE%20memories%3B--")).toEqual([]);
      expect(await get('type=fact&tag=sale&text=pay&createdFrom=2026-01-01&updatedTo=2026-02-28')).toEqual([p]);
      expect(await get('tag=unknown')).toEqual([]);
    });

    it('returns a memory with several matching tags once', async () => {
      const m = await seed(wsA, 'x', { tags: ['one', 'two', 'three'] });
      const r = await send('GET', `${w(wsA)}?tag=one`);
      expect(ids(r)).toEqual([m]);
      expect(r.json.items[0].tags).toEqual(['one', 'three', 'two']);
    });

    it('never serializes embedding coordinates', async () => {
      const m = await mk(g, 'vec');
      await ds.query(`UPDATE memories SET embedding = (SELECT array_agg(0.7071)::vector FROM generate_series(1, 1536)), embedding_status = 'ready', embedding_model = 'm' WHERE id = $1`, [m.id]);
      const l = await send('GET', g);
      const d = await send('GET', `${g}/${m.id}`);
      for (const r of [l, d]) {
        expect(r.text).not.toMatch(/0\.7071|"embedding"\s*:|\[\s*0\./);
        expect(r.text).toContain('"embeddingStatus":"ready"');
      }
    });

    it.each([
      'limit=0', 'limit=101', 'limit=abc', 'cursor=bad', 'type=nope', 'status=deleted', 'tag=%20', 'tag=a&tag=b', 'sort=asc',
      'createdFrom=nope', 'createdFrom=2026-02-01&createdTo=2026-01-01', 'updatedFrom=2026-02-01&updatedTo=2026-01-01', `text=${'x'.repeat(201)}`,
    ])('rejects %s with a generic 400', async (qs) => {
      const r = await send('GET', `${w(wsA)}?${qs}`);
      expect(r.status).toBe(400);
      expect(r.text).not.toContain('SELECT');
    });

    it('does not accept a cursor from another scope to leak rows', async () => {
      await seed(wsB, 'b1', { createdAt: '2026-01-02T00:00:00Z' });
      await seed(wsB, 'b2', { createdAt: '2026-01-03T00:00:00Z' });
      const a = await seed(wsA, 'a1', { createdAt: '2026-01-01T00:00:00Z' });
      const page = await send('GET', `${w(wsB)}?limit=1`);
      expect(ids(await send('GET', `${w(wsA)}?cursor=${page.json.nextCursor}`))).toEqual([a]);
    });

    it('is gated by memories:read and conceals ungranted Global', async () => {
      const noPerm = bearer(wsA, ['files:read']);
      expect((await send('GET', w(wsA), undefined, { key: noPerm })).status).toBe(403);
      expect((await send('GET', w(wsA), undefined, { key: bearer(wsA, ['memories:read']) })).status).toBe(200);
    });
  });
});
