import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Permission } from '@seshat/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { ApiKey } from '../src/api-keys/api-key.entity.js';
import { ApiKeyStore } from '../src/api-keys/api-key.store.js';
import { createApp } from '../src/app.setup.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthorizationService } from '../src/auth/authorization.service.js';
import { CLOCK, systemClock } from '../src/auth/login-rate-limiter.js';
import { SESSION_COOKIE_NAME } from '../src/auth/session-token.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { Collection } from '../src/collections/collection.entity.js';
import { CollectionsService } from '../src/collections/collection.service.js';
import { SanitizedExceptionFilter } from '../src/common/sanitized-exception.filter.js';
import { ConfigModule } from '../src/config/config.module.js';
import { FileRecord } from '../src/files/file.entity.js';
import { FilesController } from '../src/files/files.controller.js';
import { FilesService } from '../src/files/files.service.js';
import { FILE_STORAGE, originalObjectKey } from '../src/storage/file-storage.js';
import { LocalVolumeFileStorage } from '../src/storage/local-volume-file-storage.js';
import { FileTag } from '../src/tags/file-tag.entity.js';
import { Tag } from '../src/tags/tag.entity.js';
import { TagsService } from '../src/tags/tags.service.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

describeIntegration('File list, metadata and download (real PostgreSQL and storage)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let adminCookie: string;
  let wsA: string;
  let wsB: string;
  let root: string;
  let storage: LocalVolumeFileStorage;
  const keys = new Map<string, { workspaceId: string; permissions: Permission[] }>();
  let seq = 0;

  const bearer = (workspaceId: string, permissions: Permission[]) => {
    const key = `sk_seshat_TestKey${++seq}_secret${'x'.repeat(40)}`;
    keys.set(key, { workspaceId, permissions });
    return key;
  };
  type Auth = { key?: string; cookie?: string | null };
  const get = async (p: string, auth: Auth = {}) => {
    const headers: Record<string, string> = {};
    if (auth.key) headers.authorization = `Bearer ${auth.key}`;
    else if (auth.cookie !== null) headers.cookie = auth.cookie ?? adminCookie;
    const res = await fetch(`${base}${p}`, { headers });
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString('utf8');
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, headers: res.headers, bytes, text, json };
  };

  const g = '/api/global/files';
  const w = (id: string) => `/api/workspaces/${id}/files`;
  const addWorkspace = async (slug: string) =>
    ((await ds.query('INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id', [slug])) as { id: string }[])[0]!.id;
  const scopeOf = (workspaceId: string | null) => ({ scope: workspaceId ? 'workspace' : 'global', workspaceId }) as const;

  /** Inserts a file row plus (optionally) its stored object. */
  async function seed(
    workspaceId: string | null,
    opts: { name?: string; data?: Buffer; mime?: string; createdAt?: string; id?: string; status?: string; collectionId?: string | null; tags?: string[]; store?: boolean } = {},
  ) {
    const id = opts.id ?? randomUUID();
    const data = opts.data ?? Buffer.from(`content of ${id}`);
    const sc = scopeOf(workspaceId);
    const key = originalObjectKey(workspaceId ? { kind: 'workspace', workspaceId } : { kind: 'global' }, id);
    if (opts.store !== false) await storage.put(key, Readable.from([data]));
    await ds.query(
      `INSERT INTO files (id, scope, workspace_id, name, extension, mime_type, size_bytes, sha256, storage_key, collection_id, ingestion_status, created_at)
       VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11::timestamptz)`,
      [id, sc.scope, sc.workspaceId, opts.name ?? `f-${id.slice(0, 8)}.txt`, opts.mime ?? 'text/plain', data.length, createHash('sha256').update(data).digest('hex'), key, opts.collectionId ?? null, opts.status ?? 'pending', opts.createdAt ?? new Date().toISOString()],
    );
    for (const name of opts.tags ?? []) {
      const [t] = await ds.query(
        `INSERT INTO tags (scope, workspace_id, name) VALUES ($1,$2,$3) ON CONFLICT ON CONSTRAINT "UQ_tags_scope_key_name" DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [sc.scope, sc.workspaceId, name],
      );
      await ds.query('INSERT INTO file_tags (file_id, tag_id, scope_key) VALUES ($1,$2,$3)', [id, t.id, workspaceId ?? 'global']);
    }
    return { id, data, key };
  }
  async function collection(workspaceId: string | null, name: string) {
    const sc = scopeOf(workspaceId);
    return ((await ds.query('INSERT INTO collections (scope, workspace_id, name) VALUES ($1,$2,$3) RETURNING id', [sc.scope, sc.workspaceId, name])) as { id: string }[])[0]!.id;
  }
  async function listAll(p: string, limit: number, auth: Auth = {}, extra = '') {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const res = await get(`${p}?limit=${limit}${extra}${cursor ? `&cursor=${cursor}` : ''}`, auth);
      expect(res.status).toBe(200);
      ids.push(...res.json.items.map((f: { id: string }) => f.id));
      if (!res.json.hasMore) {
        expect(res.json.nextCursor).toBeNull();
        return ids;
      }
      cursor = res.json.nextCursor;
    }
    throw new Error('did not terminate');
  }

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey, Collection, Tag, FileTag, FileRecord]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    wsA = await addWorkspace('alpha');
    wsB = await addWorkspace('beta');
    root = await mkdtemp(path.join(tmpdir(), 'seshat-read-'));
    storage = await LocalVolumeFileStorage.open(root);

    for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test', MAX_UPLOAD_BYTES: '1024' })) vi.stubEnv(k, v);
    const store = {
      findByKey: async (presented: string) => {
        const k = keys.get(presented);
        if (!k) return null;
        return { id: randomUUID(), workspaceId: k.workspaceId, name: 'k', prefix: 'TestKey00', permissions: k.permissions, createdAt: new Date(), expiresAt: null, lastUsedAt: null, revokedAt: null };
      },
      touchLastUsed: async () => true,
    };
    @Module({
      imports: [ConfigModule, EventEmitterModule.forRoot()],
      controllers: [FilesController],
      providers: [
        { provide: CLOCK, useValue: systemClock },
        AuthService,
        SessionGuard,
        { provide: APP_GUARD, useExisting: SessionGuard },
        { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
        { provide: ApiKeyStore, useValue: store },
        AuthorizationService,
        { provide: getDataSourceToken(), useValue: ds },
        { provide: FILE_STORAGE, useValue: storage },
        CollectionsService,
        TagsService,
        FilesService,
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
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    await ds.query('DELETE FROM file_tags');
    await ds.query('DELETE FROM files');
    await ds.query('DELETE FROM tags');
    await ds.query('DELETE FROM collections');
    for (const e of await readdir(root, { recursive: true, withFileTypes: true })) if (e.isFile()) await rm(path.join(e.parentPath, e.name), { force: true });
  });

  describe('list', () => {
    it('lists newest first in Global and a Workspace, with metadata and no storage details', async () => {
      const a = await seed(wsA, { createdAt: '2026-01-01T00:00:00Z', tags: ['b', 'a'] });
      const b = await seed(wsA, { createdAt: '2026-01-02T00:00:00Z' });
      const gl = await seed(null, { createdAt: '2026-01-03T00:00:00Z' });
      const res = await get(w(wsA));
      expect(res.status).toBe(200);
      expect(res.json.items.map((f: { id: string }) => f.id)).toEqual([b.id, a.id]);
      expect(res.json).toMatchObject({ hasMore: false, nextCursor: null, limit: 25 });
      expect(res.json.items[1].tags).toEqual(['a', 'b']);
      expect(res.text).not.toMatch(/originals|storage_key|storageKey|seshat-read/);
      expect((await get(g)).json.items.map((f: { id: string }) => f.id)).toEqual([gl.id]);
    });

    it('paginates without duplicates or skips when many rows share one timestamp', async () => {
      const same = '2026-02-02T02:02:02.123456Z';
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) ids.push((await seed(wsA, { createdAt: same, store: false })).id);
      for (let i = 0; i < 3; i++) ids.push((await seed(wsA, { createdAt: '2026-02-02T02:02:02.123457Z', store: false })).id);
      await seed(wsA, { createdAt: '2026-01-01T00:00:00Z', store: false });
      const all = await listAll(w(wsA), 3);
      expect(all).toHaveLength(11);
      expect(new Set(all).size).toBe(11);
      // Microsecond precision matters: the three newer rows come first, ties are broken by id descending.
      expect(all.slice(0, 3).sort()).toEqual(ids.slice(7).sort());
      expect(all.slice(0, 3)).toEqual([...all.slice(0, 3)].sort().reverse());
      expect(all.slice(3, 10)).toEqual([...ids.slice(0, 7)].sort().reverse());
      expect(await listAll(w(wsA), 1)).toEqual(all);
      expect(await listAll(w(wsA), 100)).toEqual(all);
    });

    it('combines Collection, tag, status and literal name filters', async () => {
      const c = await collection(wsA, 'docs');
      const hit = await seed(wsA, { name: '100%_done [v1].txt', collectionId: c, tags: ['alpha'], status: 'indexed', store: false });
      await seed(wsA, { name: '100x_done [v1].txt', collectionId: c, tags: ['alpha'], status: 'indexed', store: false });
      await seed(wsA, { name: '100%_done [v1].txt', tags: ['alpha'], status: 'indexed', store: false });
      await seed(wsA, { name: '100%_done [v1].txt', collectionId: c, tags: ['beta'], status: 'indexed', store: false });
      await seed(wsA, { name: '100%_done [v1].txt', collectionId: c, tags: ['alpha'], status: 'failed', store: false });
      const q = `collectionId=${c}&tag=ALPHA&status=indexed&name=${encodeURIComponent('%_done [V1]')}`;
      const res = await get(`${w(wsA)}?${q}`);
      expect(res.json.items.map((f: { id: string }) => f.id)).toEqual([hit.id]);
      // Wildcard characters are literal, not patterns.
      expect((await get(`${w(wsA)}?name=${encodeURIComponent('%')}`)).json.items).toHaveLength(4);
      expect((await get(`${w(wsA)}?name=${encodeURIComponent('_')}`)).json.items).toHaveLength(5);
      expect((await get(`${w(wsA)}?name=${encodeURIComponent('.*')}`)).json.items).toHaveLength(0);
      expect((await get(`${w(wsA)}?name=${encodeURIComponent('1%d')}`)).json.items).toHaveLength(0);
      // Filters combine with pagination.
      expect(await listAll(w(wsA), 1, {}, `&status=indexed`)).toHaveLength(4);
    });

    it('foreign Collection and tag filters behave exactly like nonexistent ones', async () => {
      const foreign = await collection(wsB, 'theirs');
      await seed(wsB, { collectionId: foreign, tags: ['shared'], store: false });
      await seed(wsA, { tags: ['shared'], store: false });
      const missing = randomUUID();
      const a = await get(`${w(wsA)}?collectionId=${foreign}`);
      const b = await get(`${w(wsA)}?collectionId=${missing}`);
      expect(a.status).toBe(200);
      expect(a.text).toBe(b.text);
      expect(a.json.items).toEqual([]);
      // A tag name that only exists in another scope is empty, the same as an unknown name.
      await ds.query('DELETE FROM file_tags WHERE scope_key = $1', [wsA]);
      const t1 = await get(`${w(wsA)}?tag=shared`);
      const t2 = await get(`${w(wsA)}?tag=never-used`);
      expect(t1.text).toBe(t2.text);
      expect((await get(`${g}?collectionId=${foreign}`)).json.items).toEqual([]);
    });

    it('rejects malformed queries and cursors with one generic 400', async () => {
      await seed(wsA, { store: false });
      const bad = ['limit=0', 'limit=101', 'limit=abc', 'collectionId=zzz', 'status=nope', 'tag=a%20b', 'cursor=!!!', `cursor=${Buffer.from('["x","y"]').toString('base64url')}`, 'bogus=1', 'limit=1&limit=2'];
      for (const q of bad) {
        const res = await get(`${w(wsA)}?${q}`);
        expect(res.status, q).toBe(400);
        expect(res.text).not.toMatch(/zzz|nope|bogus|stack|syntax/i);
      }
    });

    it('a list for a missing Workspace is the generic 404', async () => {
      const res = await get(w(randomUUID()));
      expect(res.status).toBe(404);
    });
  });

  describe('metadata', () => {
    it('returns one file in both scopes and 404s for foreign, missing and malformed ids with identical bodies', async () => {
      const own = await seed(wsA, { tags: ['t'], store: false });
      const gl = await seed(null, { store: false });
      const theirs = await seed(wsB, { store: false });
      const ok = await get(`${w(wsA)}/${own.id}`);
      expect(ok.status).toBe(200);
      expect(ok.json).toMatchObject({ id: own.id, scope: 'workspace', workspaceId: wsA, tags: ['t'] });
      expect((await get(`${g}/${gl.id}`)).json).toMatchObject({ id: gl.id, scope: 'global', workspaceId: null });
      const missing = await get(`${w(wsA)}/${randomUUID()}`);
      for (const id of [theirs.id, gl.id, 'not-a-uuid']) {
        const r = await get(`${w(wsA)}/${id}`);
        expect(r.status).toBe(404);
        expect(r.text).toBe(missing.text);
      }
      const gMissing = await get(`${g}/${randomUUID()}`);
      expect((await get(`${g}/${own.id}`)).text).toBe(gMissing.text);
    });
  });

  describe('permissions', () => {
    it('conceals foreign Workspaces and ungranted Global, and requires files:read in the own Workspace', async () => {
      const own = await seed(wsA);
      const gl = await seed(null);
      const reader = bearer(wsA, ['files:read']);
      const noFiles = bearer(wsA, ['memories:read']);
      const withGlobal = bearer(wsA, ['files:read', 'global:read']);
      const globalOnly = bearer(wsA, ['global:read']);

      for (const suffix of ['', `/${own.id}`, `/${own.id}/download`]) {
        expect((await get(`${w(wsA)}${suffix}`, { key: reader })).status).toBe(200);
        const denied = await get(`${w(wsA)}${suffix}`, { key: noFiles });
        expect(denied.status).toBe(403);
        expect(denied.text).toContain('files:read');
        expect(denied.text).not.toContain(own.id);
        // Another Workspace: same bytes as a nonexistent Workspace.
        const foreign = await get(`${w(wsB)}${suffix.replace(own.id, randomUUID())}`, { key: reader });
        const gone = await get(`${w(randomUUID())}${suffix.replace(own.id, randomUUID())}`, { key: reader });
        expect(foreign.status).toBe(404);
        expect(foreign.text).toBe(gone.text);
      }

      // Global without the grant is indistinguishable from a missing resource.
      const missingGlobal = await get(`${g}/${randomUUID()}`, { key: reader });
      for (const key of [reader, globalOnly, noFiles]) {
        const list = await get(g, { key });
        const one = await get(`${g}/${gl.id}`, { key });
        const dl = await get(`${g}/${gl.id}/download`, { key });
        expect([list.status, one.status, dl.status]).toEqual([404, 404, 404]);
        expect(one.text).toBe(missingGlobal.text);
        expect(dl.bytes.toString()).not.toContain(`content of ${gl.id}`);
      }
      // Operational permission plus global:read succeeds.
      expect((await get(g, { key: withGlobal })).json.items).toHaveLength(1);
      expect((await get(`${g}/${gl.id}`, { key: withGlobal })).status).toBe(200);
      const dl = await get(`${g}/${gl.id}/download`, { key: withGlobal });
      expect(dl.status).toBe(200);
      expect(dl.bytes.toString()).toBe(`content of ${gl.id}`);
    });

    it('requires a session or key', async () => {
      const f = await seed(wsA, { store: false });
      for (const p of [w(wsA), `${w(wsA)}/${f.id}`, `${w(wsA)}/${f.id}/download`, g]) expect((await get(p, { cookie: null })).status).toBe(401);
    });
  });

  describe('download', () => {
    it('streams the exact bytes as an attachment with nosniff in both scopes', async () => {
      const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
      for (const [p, ws] of [[g, null], [w(wsA), wsA]] as const) {
        const f = await seed(ws, { name: 'data.bin', data, mime: 'application/octet-stream' });
        const res = await get(`${p}/${f.id}/download`);
        expect(res.status).toBe(200);
        expect(res.bytes.equals(data)).toBe(true);
        expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="data\.bin"; filename\*=UTF-8''data\.bin$/);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('content-length')).toBe(String(data.length));
        expect(res.headers.get('content-type')).toBe('application/octet-stream');
      }
    });

    it('keeps hostile content inert: active types are octet-stream attachments and bytes are untouched', async () => {
      const payloads: [string, string, Buffer][] = [
        ['page.html', 'text/html', Buffer.from('<html><script>alert(1)</script></html>')],
        ['image.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
        ['doc.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n/JS (app.alert(1))')],
        ['feed.xml', 'application/xml', Buffer.from('<?xml version="1.0"?><x/>')],
      ];
      for (const [name, mime, data] of payloads) {
        const f = await seed(wsA, { name, mime, data });
        const res = await get(`${w(wsA)}/${f.id}/download`);
        expect(res.status).toBe(200);
        expect(res.bytes.equals(data)).toBe(true);
        expect(res.headers.get('content-type')).toBe('application/octet-stream');
        expect(res.headers.get('content-disposition')?.startsWith('attachment;')).toBe(true);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('content-security-policy')).toContain('sandbox');
      }
    });

    it('encodes hostile names (quotes, unicode, header injection) without injecting headers', async () => {
      const hostile = ['evil".html', 'x\r\nSet-Cookie: a=b.txt', 'résumé – 日本語 "final".txt', "o'neil (1)*.txt", '..%2f..%2fetc%2fpasswd', 'a\\b;c.txt'];
      for (const name of hostile) {
        const f = await seed(wsA, { name, data: Buffer.from('ok') });
        const res = await get(`${w(wsA)}/${f.id}/download`);
        expect(res.status, name).toBe(200);
        const cd = res.headers.get('content-disposition')!;
        expect(cd.startsWith('attachment; filename="')).toBe(true);
        expect(cd).toMatch(/^[\x20-\x7e]+$/);
        expect(cd.match(/"/g)).toHaveLength(2);
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(res.bytes.toString()).toBe('ok');
      }
      const f = await seed(wsA, { name: 'résumé "x".txt' });
      const cd = (await get(`${w(wsA)}/${f.id}/download`)).headers.get('content-disposition')!;
      expect(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(cd)![1]!)).toBe('résumé _x_.txt');
    });

    it('a missing object is a generic 404 with no path, and the row stays', async () => {
      const f = await seed(wsA, { store: false });
      const res = await get(`${w(wsA)}/${f.id}/download`);
      expect(res.status).toBe(404);
      const gone = await get(`${w(wsA)}/${randomUUID()}/download`);
      expect(res.text).toBe(gone.text);
      expect(res.text).not.toMatch(/originals|seshat-read|ENOENT/);
      expect((await get(`${w(wsA)}/${f.id}`)).status).toBe(200);
    });

    it('does not read storage for unauthorized or foreign requests', async () => {
      const theirs = await seed(wsB);
      const spy = vi.spyOn(storage, 'get');
      try {
        await get(`${w(wsA)}/${theirs.id}/download`);
        await get(`${w(wsB)}/${theirs.id}/download`, { key: bearer(wsA, ['files:read']) });
        await get(`${g}/${randomUUID()}/download`, { key: bearer(wsA, ['files:read']) });
        await get(`${w(wsA)}/${theirs.id}/download`, { key: bearer(wsA, ['memories:read']) });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('releases the file when the client disconnects mid-stream', async () => {
      const big = Buffer.alloc(8 * 1024 * 1024, 1);
      const f = await seed(wsA, { data: big });
      const stream = await storage.get(f.key);
      stream.destroy();
      const ctrl = new AbortController();
      const res = await fetch(`${base}${w(wsA)}/${f.id}/download`, { headers: { cookie: adminCookie }, signal: ctrl.signal });
      const reader = res.body!.getReader();
      await reader.read();
      ctrl.abort();
      await new Promise((r) => setTimeout(r, 100));
      // The server is still healthy and serves the next request.
      expect((await get(`${w(wsA)}/${f.id}`)).status).toBe(200);
    });
  });
});
