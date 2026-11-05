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

describeIntegration('Memory lifecycle (real PostgreSQL, HTTP)', () => {
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

  describe('create and deduplication (AC-2)', () => {
    it('creates in Global and a Workspace with 201, server provenance and pending embedding, without vector or hash', async () => {
      for (const p of [g, w(wsA)]) {
        const r = await send('POST', p, body('Use TLS', { title: 'T', metadata: { a: 1 }, confidence: 0.5, source: 's', tags: ['B', 'a'] }));
        expect(r.status).toBe(201);
        expect(r.json).toMatchObject({
          deduplicated: false, type: 'fact', content: 'Use TLS', title: 'T', metadata: { a: 1 }, confidence: 0.5, source: 's', tags: ['a', 'b'],
          status: 'active', supersededBy: null, embeddingStatus: 'pending', scope: p === g ? 'global' : 'workspace',
          provenance: { createdBy: { kind: 'admin', keyId: null, keyName: null }, client: null },
        });
        expect(r.text).not.toMatch(/embedding"|contentHash|content_hash/);
      }
    });

    it('reuses an identical active record sequentially: deduplicated true, tags unioned, content and provenance kept', async () => {
      const first = await send('POST', w(wsA), body('Use  TLS\n', { title: 'orig', tags: ['one'] }));
      const key = bearer(wsA, ['memories:write']);
      const second = await send('POST', w(wsA), body('use tls', { type: 'fact' }), { key });
      expect(second.json.deduplicated).toBe(false); // case differs: another Memory
      const dup = await send('POST', w(wsA), body(' Use TLS ', { title: 'changed', tags: ['Two', 'one'] }), { key });
      expect(dup.status).toBe(200);
      expect(dup.json).toMatchObject({ id: first.json.id, deduplicated: true, title: 'orig', content: 'Use  TLS\n', tags: ['one', 'two'], provenance: { createdBy: { kind: 'admin' } } });
      expect(await count()).toBe(2);
    });

    it('same content in another type, another Workspace or Global is a different record', async () => {
      await mk(w(wsA), 'same');
      expect((await send('POST', w(wsA), body('same', { type: 'decision' }))).json.deduplicated).toBe(false);
      expect((await send('POST', w(wsB), body('same'))).json.deduplicated).toBe(false);
      expect((await send('POST', g, body('same'))).json.deduplicated).toBe(false);
      expect(await count()).toBe(4);
    });

    it('concurrent duplicate creates leave exactly one active record and one non-deduplicated response', async () => {
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => send('POST', w(wsA), body('race', { tags: [`t${i % 3}`] }))));
      expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(results.filter((r) => r.json.deduplicated === false)).toHaveLength(1);
      expect(new Set(results.map((r) => r.json.id)).size).toBe(1);
      expect(await count()).toBe(1);
      expect(await tagsOf(results[0]!.json.id)).toEqual(['t0', 't1', 't2']);
    });

    it('a superseded record no longer blocks the same content', async () => {
      const a = await mk(w(wsA), 'old');
      const b = await mk(w(wsA), 'new');
      expect((await send('POST', `${w(wsA)}/${a.id}/supersede`, { successorId: b.id })).status).toBe(200);
      const again = await send('POST', w(wsA), body('old'));
      expect(again.status).toBe(201);
      expect(again.json.id).not.toBe(a.id);
    });

    it('rejects client-supplied provenance, scope, status, hash and embedding fields with 400', async () => {
      for (const extra of [{ provenance: {} }, { createdBy: 'x' }, { client: { name: 'x' } }, { clientName: 'x' }, { scope: 'global' }, { status: 'superseded' }, { contentHash: 'a' }, { embedding: [1] }, { workspaceId: wsB }]) {
        expect((await send('POST', w(wsA), body('c', extra))).status, JSON.stringify(extra)).toBe(400);
      }
      expect(await count()).toBe(0);
    });

    it('stores the key id and name snapshot for key-created Memories', async () => {
      const key = bearer(wsA, ['memories:write'], 'writer');
      const r = await send('POST', w(wsA), body('by key'), { key });
      expect(r.json.provenance).toEqual({ createdBy: { kind: 'api_key', keyId: keys.get(key)!.id, keyName: 'writer' }, client: null });
    });
  });

  describe('create with supersedes (AC-3)', () => {
    it('commits the successor and the predecessor link together', async () => {
      const old = await mk(w(wsA), 'old', { tags: ['x'] });
      const r = await send('POST', w(wsA), body('new', { supersedes: old.id }));
      expect(r.status).toBe(201);
      expect(r.json.status).toBe('active');
      const p = await row(old.id);
      expect(p).toMatchObject({ status: 'superseded', superseded_by: r.json.id });
    });

    it('foreign, missing and inactive predecessors change nothing and foreign equals missing', async () => {
      const foreign = await mk(w(wsB), 'in b');
      const inGlobal = await mk(g, 'in g');
      const missing = await send('POST', w(wsA), body('n1', { supersedes: randomUUID() }));
      const other = await send('POST', w(wsA), body('n1', { supersedes: foreign.id }));
      const glob = await send('POST', w(wsA), body('n1', { supersedes: inGlobal.id }));
      expect(missing.status).toBe(404);
      expect({ ...other, text: other.text }).toMatchObject({ status: 404, text: missing.text });
      expect(glob.status).toBe(404);
      const a = await mk(w(wsA), 'a');
      const b = await mk(w(wsA), 'b');
      await send('POST', `${w(wsA)}/${a.id}/supersede`, { successorId: b.id });
      const inactive = await send('POST', w(wsA), body('n2', { supersedes: a.id }));
      expect(inactive.status).toBe(409);
      expect(await count()).toBe(4);
      expect((await row(foreign.id)).status).toBe('active');
    });

    it('an injected failure after the insert rolls back the successor and the predecessor change', async () => {
      const old = await mk(w(wsA), 'old');
      const existing = await mk(w(wsA), 'dup');
      failTagUnion = true;
      const r = await send('POST', w(wsA), body('dup', { supersedes: old.id, tags: ['z'] }));
      expect(r.status).toBe(500);
      expect(await count()).toBe(2);
      expect((await row(old.id)).status).toBe('active');
      expect(await tagsOf(existing.id)).toEqual([]);
      expect(Number((await ds.query('SELECT count(*) c FROM tags'))[0].c)).toBe(0);
    });

    it('duplicate plus supersedes reuses a distinct successor and links the predecessor to it', async () => {
      const old = await mk(w(wsA), 'old');
      const target = await mk(w(wsA), 'target');
      const r = await send('POST', w(wsA), body('target', { supersedes: old.id, tags: ['k'] }));
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ id: target.id, deduplicated: true, status: 'active', tags: ['k'] });
      expect(await row(old.id)).toMatchObject({ status: 'superseded', superseded_by: target.id });
      expect(await count()).toBe(2);
    });

    it('rejects superseding itself through a duplicate without any change', async () => {
      const m = await mk(w(wsA), 'same', { tags: ['a'] });
      const r = await send('POST', w(wsA), body('same', { supersedes: m.id, tags: ['b'] }));
      expect(r.status).toBe(400);
      expect(await row(m.id)).toMatchObject({ status: 'active', superseded_by: null });
      expect(await tagsOf(m.id)).toEqual(['a']);
    });

    it('concurrent supersession of one predecessor yields exactly one winner', async () => {
      const old = await mk(w(wsA), 'old');
      const rs = await Promise.all(['n1', 'n2', 'n3', 'n4'].map((c) => send('POST', w(wsA), body(c, { supersedes: old.id }))));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
      expect(await count()).toBe(2);
    });
  });

  describe('PUT (full replacement)', () => {
    it('replaces every editable field, clears nulls, updates the hash and resets the embedding on content change only', async () => {
      const m = await mk(w(wsA), 'before', { title: 't', metadata: { k: 1 }, confidence: 0.2, source: 's', tags: ['a'] });
      await ds.query(`UPDATE memories SET embedding = ('[' || array_to_string(array_fill(0.1::float8, ARRAY[1536]), ',') || ']')::vector, embedding_model = 'm', embedding_status = 'ready' WHERE id = $1`, [m.id]);
      const before = await row(m.id);
      const keep = await put(w(wsA), m.id, { type: 'decision', content: 'before', title: 't', metadata: { k: 1 }, confidence: 0.2, source: 's', tags: ['a'] });
      expect(keep.status).toBe(200);
      expect(await row(m.id)).toMatchObject({ embedding_status: 'ready', embedding_model: 'm', type: 'decision' });
      const r = await put(w(wsA), m.id, { content: 'after', tags: ['B'] });
      expect(r.json).toMatchObject({ content: 'after', title: null, metadata: null, confidence: null, source: null, tags: ['b'], embeddingStatus: 'pending', embeddingModel: null });
      const after = await row(m.id);
      expect(after.embedding).toBeNull();
      expect(after.content_hash).not.toBe(before.content_hash);
      for (const f of ['created_by_kind', 'created_by_key_id', 'created_by_key_name', 'client_name', 'created_at', 'scope', 'workspace_id']) expect(after[f]).toEqual(before[f]);
      const titleOnly = await put(w(wsA), m.id, { content: 'after', title: 'new title', tags: ['b'] });
      expect(titleOnly.json.embeddingStatus).toBe('pending');
    });

    it('rejects missing fields, unknown fields and PATCH', async () => {
      const m = await mk(w(wsA), 'c');
      expect((await send('PUT', `${w(wsA)}/${m.id}`, { type: 'fact', content: 'c' })).status).toBe(400);
      expect((await put(w(wsA), m.id, { status: 'superseded' })).status).toBe(400);
      expect((await put(w(wsA), m.id, { createdBy: 'x' })).status).toBe(400);
      expect((await send('PATCH', `${w(wsA)}/${m.id}`, { content: 'z' })).status).toBe(404);
    });

    it('a superseded record answers 409 with its successor and stays unchanged', async () => {
      const a = await mk(w(wsA), 'a');
      const b = await mk(w(wsA), 'b');
      await send('POST', `${w(wsA)}/${a.id}/supersede`, { successorId: b.id });
      const r = await put(w(wsA), a.id, { content: 'edited' });
      expect(r.status).toBe(409);
      expect(r.json.supersededBy).toBe(b.id);
      expect((await row(a.id)).content).toBe('a');
    });

    it('409 when the new type/content collides with another active record, with no partial change', async () => {
      const a = await mk(w(wsA), 'a', { tags: ['keep'] });
      await mk(w(wsA), 'b');
      const r = await put(w(wsA), a.id, { content: ' b ', tags: ['lost'] });
      expect(r.status).toBe(409);
      expect(r.text).not.toContain('"b"');
      expect((await row(a.id)).content).toBe('a');
      expect(await tagsOf(a.id)).toEqual(['keep']);
    });

    it('concurrent updates to the same content: one wins, the other conflicts', async () => {
      const a = await mk(w(wsA), 'a');
      const b = await mk(w(wsA), 'b');
      const rs = await Promise.all([put(w(wsA), a.id, { content: 'same' }), put(w(wsA), b.id, { content: 'same' })]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    });
  });

  describe('explicit supersede', () => {
    it('marks only the predecessor, creates nothing and returns it', async () => {
      const a = await mk(w(wsA), 'a');
      const b = await mk(w(wsA), 'b');
      const r = await send('POST', `${w(wsA)}/${a.id}/supersede`, { successorId: b.id });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ id: a.id, status: 'superseded', supersededBy: b.id });
      expect(await row(b.id)).toMatchObject({ status: 'active', superseded_by: null });
      expect(await count()).toBe(2);
    });

    it('rejects self, inactive, cross-scope and missing records and creates no cycle', async () => {
      const a = await mk(w(wsA), 'a');
      const b = await mk(w(wsA), 'b');
      const other = await mk(w(wsB), 'o');
      const glob = await mk(g, 'gl');
      expect((await send('POST', `${w(wsA)}/${a.id}/supersede`, { successorId: a.id })).status).toBe(400);
      const missing = await send('POST', `${w(wsA)}/${a.id}/supersede`, { successorId: randomUUID() });
      const foreign = await send('POST', `${w(wsA)}/${a.id}/supersede`, { successorId: other.id });
      expect(missing.status).toBe(404);
      expect(foreign.text).toBe(missing.text);
      expect((await send('POST', `${w(wsA)}/${a.id}/supersede`, { successorId: glob.id })).status).toBe(404);
      expect((await send('POST', `${w(wsA)}/${other.id}/supersede`, { successorId: b.id })).status).toBe(404);
      await send('POST', `${w(wsA)}/${a.id}/supersede`, { successorId: b.id });
      expect((await send('POST', `${w(wsA)}/${b.id}/supersede`, { successorId: a.id })).status).toBe(409);
      expect((await send('POST', `${w(wsA)}/${a.id}/supersede`, { successorId: b.id })).status).toBe(409);
      expect((await send('POST', `${w(wsA)}/${a.id}/supersede`, { successorId: b.id, extra: 1 })).status).toBe(400);
      expect(await row(b.id)).toMatchObject({ status: 'active', superseded_by: null });
    });

    it('opposing concurrent supersessions cannot form a cycle', async () => {
      const a = await mk(w(wsA), 'a');
      const b = await mk(w(wsA), 'b');
      const rs = await Promise.all([
        send('POST', `${w(wsA)}/${a.id}/supersede`, { successorId: b.id }),
        send('POST', `${w(wsA)}/${b.id}/supersede`, { successorId: a.id }),
      ]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(Number((await ds.query(`SELECT count(*) c FROM memories WHERE status = 'active'`))[0].c)).toBe(1);
    });
  });

  describe('forget (AC-8)', () => {
    it('removes only the selected record and its joins, keeps predecessor status, clears links, spares independent successors', async () => {
      const a = await mk(w(wsA), 'a', { tags: ['t'] });
      const b = await mk(w(wsA), 'b', { tags: ['t'] });
      const c = await mk(w(wsA), 'c');
      await send('POST', `${w(wsA)}/${a.id}/supersede`, { successorId: b.id });
      expect((await send('DELETE', `${w(wsA)}/${b.id}`)).status).toBe(204);
      expect(await row(b.id)).toBeUndefined();
      expect(await row(a.id)).toMatchObject({ status: 'superseded', superseded_by: null });
      expect(await row(c.id)).toBeDefined();
      expect(await tagsOf(b.id)).toEqual([]);
      expect(await tagsOf(a.id)).toEqual(['t']);
      // forgetting the predecessor never deletes the successor
      const d = await mk(w(wsA), 'd');
      const e = await mk(w(wsA), 'e');
      await send('POST', `${w(wsA)}/${d.id}/supersede`, { successorId: e.id });
      expect((await send('DELETE', `${w(wsA)}/${d.id}`)).status).toBe(204);
      expect(await row(e.id)).toBeDefined();
      expect((await send('DELETE', `${w(wsA)}/${d.id}`)).status).toBe(404);
    });
  });

  describe('authorization (AC-7)', () => {
    it('keys need the matching permission in their own Workspace', async () => {
      const m = await mk(w(wsA), 'm');
      const readOnly = bearer(wsA, ['memories:read']);
      expect((await send('POST', w(wsA), body('k1'), { key: readOnly })).status).toBe(403);
      expect((await put(w(wsA), m.id, {}, { key: readOnly })).status).toBe(403);
      expect((await send('POST', `${w(wsA)}/${m.id}/supersede`, { successorId: randomUUID() }, { key: readOnly })).status).toBe(403);
      expect((await send('DELETE', `${w(wsA)}/${m.id}`, undefined, { key: readOnly })).status).toBe(403);
      const writer = bearer(wsA, ['memories:write']);
      expect((await send('POST', w(wsA), body('k2'), { key: writer })).status).toBe(201);
      expect((await put(w(wsA), m.id, { content: 'new' }, { key: writer })).status).toBe(200);
      expect((await send('DELETE', `${w(wsA)}/${m.id}`, undefined, { key: writer })).status).toBe(403);
      const deleter = bearer(wsA, ['memories:delete']);
      expect((await send('DELETE', `${w(wsA)}/${m.id}`, undefined, { key: deleter })).status).toBe(204);
    });

    it('a key of another Workspace gets the same 404 as a missing id, and nothing changes', async () => {
      const m = await mk(w(wsA), 'm');
      const foreign = bearer(wsB, ['memories:read', 'memories:write', 'memories:delete']);
      const missing = await send('DELETE', `${w(wsA)}/${randomUUID()}`, undefined, { key: foreign });
      for (const r of [
        await send('POST', w(wsA), body('x'), { key: foreign }),
        await put(w(wsA), m.id, {}, { key: foreign }),
        await send('DELETE', `${w(wsA)}/${m.id}`, undefined, { key: foreign }),
        await send('POST', `${w(wsA)}/${m.id}/supersede`, { successorId: m.id }, { key: foreign }),
      ]) {
        expect(r.status).toBe(404);
        expect(r.text).toBe(missing.text);
      }
      expect(await count()).toBe(1);
    });

    it('own-Workspace id used via the wrong Workspace route, and a Global id in a Workspace, behave like missing', async () => {
      const m = await mk(w(wsA), 'm');
      const gl = await mk(g, 'gl');
      const miss = await send('DELETE', `${w(wsB)}/${randomUUID()}`);
      expect((await send('DELETE', `${w(wsB)}/${m.id}`)).text).toBe(miss.text);
      expect((await send('DELETE', `${w(wsA)}/${gl.id}`)).status).toBe(404);
      expect((await put(w(wsB), m.id)).status).toBe(404);
      expect((await send('DELETE', `${g}/${m.id}`)).status).toBe(404);
    });

    it('keys never write Global: concealed without the grant, 403 with it, even with every permission', async () => {
      const gl = await mk(g, 'gl');
      const all = bearer(wsA, ['memories:read', 'memories:write', 'memories:delete', 'files:read', 'files:write', 'files:delete', 'collections:read', 'collections:write', 'search']);
      const ungranted = bearer(wsA, ['memories:write', 'memories:delete']);
      const granted = bearer(wsA, ['memories:read', 'memories:write', 'memories:delete', 'global:read']);
      const miss = await send('DELETE', `${g}/${randomUUID()}`, undefined, { key: ungranted });
      for (const [k, status] of [[ungranted, 404], [all, 404], [granted, 403]] as const) {
        for (const r of [
          await send('POST', g, body('x'), { key: k }),
          await put(g, gl.id, {}, { key: k }),
          await send('DELETE', `${g}/${gl.id}`, undefined, { key: k }),
          await send('POST', `${g}/${gl.id}/supersede`, { successorId: randomUUID() }, { key: k }),
        ]) {
          expect(r.status).toBe(status);
          if (status === 404) expect(r.text).toBe(miss.text);
        }
      }
      expect(await count()).toBe(1);
    });

    it('rejects unauthenticated calls and malformed ids', async () => {
      const res = await fetch(`${base}${w(wsA)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body('x')) });
      expect(res.status).toBe(401);
      expect((await send('DELETE', `${w(wsA)}/not-a-uuid`)).status).toBe(404);
      expect((await send('POST', `/api/workspaces/${randomUUID()}/memories`, body('x'))).status).toBe(404);
    });
  });
});
