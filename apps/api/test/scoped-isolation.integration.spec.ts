import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { type INestApplication, Logger, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { getDataSourceToken } from '@nestjs/typeorm';
import { PERMISSIONS, type Permission } from '@seshat/domain';
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
import { CollectionsController } from '../src/collections/collections.controller.js';
import { SanitizedExceptionFilter } from '../src/common/sanitized-exception.filter.js';
import { ConfigModule } from '../src/config/config.module.js';
import { FileRecord } from '../src/files/file.entity.js';
import { FilesController } from '../src/files/files.controller.js';
import { FilesService } from '../src/files/files.service.js';
import { FILE_STORAGE, type FileStorage, originalObjectKey } from '../src/storage/file-storage.js';
import { LocalVolumeFileStorage } from '../src/storage/local-volume-file-storage.js';
import { StorageCleanupIntent } from '../src/storage/storage-cleanup-intent.entity.js';
import { StorageCleanupListener } from '../src/storage/storage-cleanup.listener.js';
import { StorageCleanupService } from '../src/storage/storage-cleanup.service.js';
import { WorkspaceDataCleanup } from '../src/storage/workspace-data-cleanup.js';
import { FileTag } from '../src/tags/file-tag.entity.js';
import { Tag } from '../src/tags/tag.entity.js';
import { TagsController } from '../src/tags/tags.controller.js';
import { TagsService } from '../src/tags/tags.service.js';
import { WORKSPACE_CLEANUP } from '../src/workspaces/workspace-cleanup.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { WorkspacesService } from '../src/workspaces/workspace.service.js';
import { WorkspacesController } from '../src/workspaces/workspaces.controller.js';
import { TEST_ADMIN_ENV, TEST_API_KEY_PEPPER } from './fixtures/admin.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';
import { SCOPED_ENDPOINTS, type ScopedEndpoint, catalogMismatches, expectedRouteStrings } from './helpers/scoped-endpoints.js';

/** Counts every call so a rejected request can be proven not to have touched the storage; can also fail removals. */
class SpyStorage implements FileStorage {
  calls = { put: 0, get: 0, exists: 0, delete: 0 };
  failDelete = false;
  constructor(readonly inner: LocalVolumeFileStorage) {}
  reset() {
    this.calls = { put: 0, get: 0, exists: 0, delete: 0 };
  }
  total() {
    return Object.values(this.calls).reduce((a, b) => a + b, 0);
  }
  async put(key: string, stream: Readable) {
    this.calls.put++;
    return this.inner.put(key, stream);
  }
  get(key: string) {
    this.calls.get++;
    return this.inner.get(key);
  }
  exists(key: string) {
    this.calls.exists++;
    return this.inner.exists(key);
  }
  async delete(key: string) {
    this.calls.delete++;
    if (this.failDelete) throw new Error('cannot delete /secret/local/path');
    return this.inner.delete(key);
  }
}

function multipart(parts: { name: string; value?: string; filename?: string; type?: string; data?: Buffer }[]) {
  const b = '----isolationmatrix';
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${b}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"\r\nContent-Type: ${p.type ?? 'text/plain'}`;
    chunks.push(Buffer.from(`${head}\r\n\r\n`), p.data ?? Buffer.from(p.value ?? ''), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${b}` };
}

const NON_GLOBAL = PERMISSIONS.filter((p) => p !== 'global:read');

describeIntegration('Files, Collections and Tags: endpoint-wide scope isolation behind the production guard (real PostgreSQL, storage and persisted keys)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let adminCookie: string;
  let root: string;
  let storage: SpyStorage;
  let keyStore: ApiKeyStore;
  let wsA: string;
  let wsB: string;
  const events: string[] = [];
  const logged: string[] = [];
  /** Every response body and header block seen by the suite; scanned for leaks at the end. */
  const seen: string[] = [];

  type Auth = { key: string } | { admin: true } | { none: true };
  interface Res { status: number; text: string; headers: Headers; bytes: Buffer }
  const fresh = (r: Res) => ({ status: r.status, text: r.text });

  async function raw(method: string, p: string, auth: Auth, opts: { json?: unknown; multipart?: ReturnType<typeof multipart> } = {}): Promise<Res> {
    const headers: Record<string, string> = {};
    if ('key' in auth) headers.authorization = `Bearer ${auth.key}`;
    else if ('admin' in auth) headers.cookie = adminCookie;
    let body: Buffer | string | undefined;
    if (opts.multipart) {
      headers['content-type'] = opts.multipart.contentType;
      body = opts.multipart.body;
    } else if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    const res = await fetch(`${base}${p}`, { method, headers, body });
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString('utf8');
    const out = { status: res.status, text, headers: res.headers, bytes };
    seen.push(`${method} ${p}\n${[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${p.endsWith('/download') && res.status === 200 ? '' : text}`);
    return out;
  }

  const keyCache = new Map<string, string>();
  /** A persisted key (HMAC row in `api_keys`), authenticated through the real SessionGuard. */
  async function key(workspaceId: string, permissions: readonly Permission[]): Promise<{ key: string }> {
    const id = `${workspaceId}:${[...permissions].sort().join(',')}`;
    let secret = keyCache.get(id);
    if (!secret) {
      secret = (await keyStore.create({ workspaceId, name: 'matrix', permissions })).secret;
      keyCache.set(id, secret);
    }
    return { key: secret };
  }

  const addWorkspace = async (slug: string) =>
    ((await ds.query('INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id', [slug])) as { id: string }[])[0]!.id;
  const scopeCols = (ws: string | null) => ({ scope: ws ? 'workspace' : 'global', workspaceId: ws }) as const;
  const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

  interface Seeded { fileId: string; collectionId: string; tagId: string; tagName: string; data: Buffer }
  /** A file (with stored original), a Collection and a Tag of exactly one scope. The file carries the Tag and joins the Collection. */
  async function seed(ws: string | null): Promise<Seeded> {
    const sc = scopeCols(ws);
    const fileId = randomUUID();
    const data = Buffer.from(`original of ${fileId}`);
    const scope = ws ? ({ kind: 'workspace', workspaceId: ws } as const) : ({ kind: 'global' } as const);
    const storageKey = originalObjectKey(scope, fileId);
    await storage.inner.put(storageKey, (await import('node:stream')).Readable.from([data]));
    const collectionId = ((await ds.query('INSERT INTO collections (scope, workspace_id, name) VALUES ($1,$2,$3) RETURNING id', [sc.scope, sc.workspaceId, uniq('col')])) as { id: string }[])[0]!.id;
    await ds.query(
      `INSERT INTO files (id, scope, workspace_id, name, extension, mime_type, size_bytes, sha256, storage_key, collection_id) VALUES ($1,$2,$3,'seed.txt','txt','text/plain',$4,$5,$6,$7)`,
      [fileId, sc.scope, sc.workspaceId, data.length, createHash('sha256').update(data).digest('hex'), storageKey, collectionId],
    );
    const tagName = uniq('tag');
    const tagId = ((await ds.query('INSERT INTO tags (scope, workspace_id, name) VALUES ($1,$2,$3) RETURNING id', [sc.scope, sc.workspaceId, tagName])) as { id: string }[])[0]!.id;
    await ds.query('INSERT INTO file_tags (file_id, tag_id, scope_key) VALUES ($1,$2,$3)', [fileId, tagId, ws ?? 'global']);
    return { fileId, collectionId, tagId, tagName, data };
  }

  async function objects(dir = root): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await objects(p)));
      else out.push(p);
    }
    return out.sort();
  }
  /** Rows, ledger, objects, storage calls and events: anything an unauthorized request must not move. */
  async function state() {
    const q = async (t: string) => ds.query(`SELECT * FROM ${t} ORDER BY 1, 2`);
    return JSON.stringify({
      files: await q('files'), collections: await q('collections'), tags: await q('tags'), file_tags: await q('file_tags'),
      intents: await q('storage_cleanup_intents'), objects: await objects(), storage: storage.calls, events: [...events],
    });
  }

  type Ids = { fileId: string; collectionId: string; tagId: string };
  const missingIds = (): Ids => ({ fileId: randomUUID(), collectionId: randomUUID(), tagId: randomUUID() });
  const pathFor = (ep: ScopedEndpoint, scopeSeg: string, ids: Ids) =>
    `/api/${scopeSeg}/${ep.path.replace(':fileId', ids.fileId).replace(':collectionId', ids.collectionId).replace(':tagId', ids.tagId)}`;
  const scopeSegOf = (ws: string | null) => (ws ? `workspaces/${ws}` : 'global');

  /** A valid request body for the endpoint, or a syntactically valid but schema-invalid one (authorization must come first). */
  function requestFor(ep: ScopedEndpoint, valid: boolean): { json?: unknown; multipart?: ReturnType<typeof multipart> } {
    switch (ep.action) {
      case 'file.upload':
        return { multipart: valid ? multipart([{ name: 'file', filename: 'new.txt', data: Buffer.from('payload') }, { name: 'tags', value: uniq('up') }]) : multipart([{ name: 'bogus', value: 'x' }]) };
      case 'file.update':
        return { json: valid ? { name: 'renamed.txt', collectionId: null, tags: [] } : { bogus: 1 } };
      case 'collection.create':
        return { json: valid ? { name: uniq('created') } : { bogus: 1 } };
      case 'collection.update':
        return { json: valid ? { name: uniq('renamed'), description: null } : { bogus: 1 } };
      case 'tag.rename':
        return { json: valid ? { name: uniq('renamed') } : { name: 'not valid!' } };
      default:
        return {};
    }
  }
  const send = (ep: ScopedEndpoint, ws: string | null, ids: Ids, auth: Auth, valid = true) =>
    raw(ep.method, pathFor(ep, scopeSegOf(ws), ids), auth, requestFor(ep, valid));
  const hasId = (ep: ScopedEndpoint) => ep.path.includes(':');

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey, Collection, Tag, FileTag, FileRecord, StorageCleanupIntent]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    wsA = await addWorkspace('alpha');
    wsB = await addWorkspace('beta');
    root = await mkdtemp(path.join(tmpdir(), 'seshat-matrix-'));
    storage = new SpyStorage(await LocalVolumeFileStorage.open(root));
    keyStore = new ApiKeyStore(ds.getRepository(ApiKey), { apiKeyPepper: TEST_API_KEY_PEPPER });

    for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test', MAX_UPLOAD_BYTES: '1024' })) vi.stubEnv(k, v);
    @Module({
      imports: [ConfigModule, EventEmitterModule.forRoot()],
      controllers: [FilesController, CollectionsController, TagsController, WorkspacesController],
      providers: [
        { provide: CLOCK, useValue: systemClock },
        AuthService,
        SessionGuard,
        { provide: APP_GUARD, useExisting: SessionGuard },
        { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
        { provide: ApiKeyStore, useValue: keyStore },
        AuthorizationService,
        { provide: getDataSourceToken(), useValue: ds },
        { provide: 'WorkspaceRepository', useValue: ds.getRepository(Workspace) },
        { provide: FILE_STORAGE, useValue: storage },
        CollectionsService,
        TagsService,
        StorageCleanupService,
        StorageCleanupListener,
        WorkspaceDataCleanup,
        { provide: WORKSPACE_CLEANUP, useExisting: WorkspaceDataCleanup },
        FilesService,
        WorkspacesService,
      ],
    })
    class TestRoot {}
    app = await createApp(TestRoot, { trustProxy: false }, false);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    adminCookie = `${SESSION_COOKIE_NAME}=${app.get(AuthService).issueSessionToken()}`;
    app.get(EventEmitter2).onAny((name: string | string[]) => void events.push(String(name)));
    for (const level of ['error', 'warn', 'log'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((m: unknown) => void logged.push(String(m)));
    }
  });

  afterAll(async () => {
    await app?.close();
    await iso?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    storage.failDelete = false;
    await ds.query('DELETE FROM storage_cleanup_intents');
    await ds.query('DELETE FROM file_tags');
    await ds.query('DELETE FROM files');
    await ds.query('DELETE FROM tags');
    await ds.query('DELETE FROM collections');
    for (const f of await objects()) await rm(f, { force: true });
    storage.reset();
    events.length = 0;
  });

  /** Seeds both Workspaces and Global and returns the byte-for-byte reference for "not found". */
  async function world() {
    const a = await seed(wsA);
    const b = await seed(wsB);
    const g = await seed(null);
    storage.reset();
    events.length = 0;
    return { a, b, g };
  }
  const canonicalMissing = async () => fresh(await raw('GET', `/api/global/files/${randomUUID()}`, { admin: true }));

  it('the endpoint table matches the shared action catalog and covers every operation of the three resources', () => {
    expect(catalogMismatches()).toEqual([]);
    expect(SCOPED_ENDPOINTS.map((e) => e.action).sort()).toEqual([
      'collection.create', 'collection.delete', 'collection.get', 'collection.list', 'collection.update',
      'file.delete', 'file.download', 'file.get', 'file.list', 'file.update', 'file.upload',
      'tag.delete', 'tag.list', 'tag.rename',
    ]);
    expect(expectedRouteStrings()).toHaveLength(28);
  });

  it('no route is served without credentials, for every endpoint in Global and in a Workspace', async () => {
    const { a, g } = await world();
    for (const ep of SCOPED_ENDPOINTS) {
      for (const [ws, ids] of [[null, g], [wsA, a]] as const) {
        const before = await state();
        const res = await send(ep, ws, ids, { none: true });
        expect(res.status, `${ep.action} ${ws ?? 'global'}`).toBe(401);
        expect(await state(), `${ep.action} ${ws ?? 'global'}`).toBe(before);
      }
    }
  });

  describe.each(SCOPED_ENDPOINTS.map((ep) => [ep.action, ep] as const))('%s', (_name, ep) => {
    it('another Workspace behaves exactly like a missing Workspace (key and admin cannot tell them apart), for valid and invalid bodies', async () => {
      const { a, b } = await world();
      const full = await key(wsA, [...NON_GLOBAL, 'global:read']);
      for (const valid of [true, false]) {
        const before = await state();
        const foreign = await send(ep, wsB, b, full, valid);
        const missing = await send(ep, randomUUID(), missingIds(), full, valid);
        if (valid) expect(foreign.status).toBe(404);
        expect(fresh(foreign)).toEqual(fresh(missing));
        expect(await state()).toBe(before);
        // A malformed Workspace id is rejected by the scope pipe with one generic 400 that does not depend on the resource ids.
        const malformed = await raw(ep.method, pathFor(ep, 'workspaces/not-a-uuid', b), full, requestFor(ep, valid));
        expect(malformed.status).toBe(400);
        expect(fresh(malformed)).toEqual(fresh(await raw(ep.method, pathFor(ep, 'workspaces/not-a-uuid', missingIds()), full, requestFor(ep, valid))));
      }
      expect(a).toBeTruthy();
    });

    it('resources of another scope behave exactly like missing resources inside an allowed scope', async () => {
      if (!hasId(ep)) return;
      const { a, b, g } = await world();
      const full = await key(wsA, NON_GLOBAL);
      for (const auth of [full, { admin: true } as Auth]) {
        for (const valid of [true, false]) {
          const before = await state();
          const missing = fresh(await send(ep, wsA, missingIds(), auth, valid));
          if (valid) expect(missing.status).toBe(404);
          for (const foreignIds of [b, g]) {
            const res = fresh(await send(ep, wsA, foreignIds, auth, valid));
            expect(res).toEqual(missing);
          }
          // The same holds the other way round: a Workspace resource addressed through Global (admin only; keys are concealed below).
          if ('admin' in auth) expect(fresh(await send(ep, null, a, auth, valid))).toEqual(fresh(await send(ep, null, missingIds(), auth, valid)));
          expect(await state()).toBe(before);
        }
      }
    });

    it('Global without the grant is indistinguishable from a missing resource; nothing is touched', async () => {
      const { g } = await world();
      const missing404 = await canonicalMissing();
      expect(missing404.status).toBe(404);
      const op = ep.needs[0]!;
      const hiddenKeys = [
        await key(wsA, [op]), // operation permission, no grant
        await key(wsA, ['global:read']), // grant, no operation permission
        await key(wsA, NON_GLOBAL), // everything except the grant
        await key(wsA, ['search', 'global:read']),
      ];
      for (const k of hiddenKeys) {
        for (const valid of [true, false]) {
          const before = await state();
          const onExisting = fresh(await send(ep, null, g, k, valid));
          const onMissing = fresh(await send(ep, null, missingIds(), k, valid));
          // Body validation is a pipe that runs before the service decides, but never depends on the resource.
          expect(onExisting).toEqual(onMissing);
          if (valid) expect(onExisting).toEqual(missing404);
          else expect([400, 404]).toContain(onExisting.status);
          expect(await state()).toBe(before);
        }
      }
    });

    if (ep.kind === 'read') {
      it('Global is readable with the operation permission and global:read together (each Tag branch), and concealed with only one of them', async () => {
        const { g } = await world();
        for (const p of ep.needs) {
          const res = await send(ep, null, g, await key(wsA, [p, 'global:read']));
          expect(res.status, `${ep.action} via ${p}`).toBe(ep.ok);
          if (ep.action === 'file.download') expect(res.bytes.equals(g.data)).toBe(true);
          if (ep.action === 'file.get') expect(JSON.parse(res.text).id).toBe(g.fileId);
          if (ep.action === 'file.list') expect(JSON.parse(res.text).items.map((f: { id: string }) => f.id)).toEqual([g.fileId]);
          if (ep.action === 'collection.list') expect(JSON.parse(res.text).map((c: { id: string }) => c.id)).toEqual([g.collectionId]);
          if (ep.action === 'tag.list') expect(JSON.parse(res.text).map((t: { id: string }) => t.id)).toEqual([g.tagId]);
        }
        // Granted but missing is the canonical not-found.
        if (hasId(ep)) expect(fresh(await send(ep, null, missingIds(), await key(wsA, [ep.needs[0]!, 'global:read'])))).toEqual(await canonicalMissing());
      });
    } else {
      it('no key can mutate Global, even holding every permission and the grant; the refusal names nothing', async () => {
        const { g } = await world();
        const all = await key(wsA, PERMISSIONS);
        for (const valid of [true, false]) {
          const before = await state();
          const onExisting = await send(ep, null, g, all, valid);
          const onMissing = await send(ep, null, missingIds(), all, valid);
          expect(fresh(onExisting)).toEqual(fresh(onMissing));
          if (valid) {
            expect(onExisting.status).toBe(403);
            expect(JSON.parse(onExisting.text).message).toBe('Forbidden');
          } else expect([400, 403]).toContain(onExisting.status);
          expect(onExisting.text).not.toContain(g.fileId);
          expect(await state()).toBe(before);
        }
      });
    }

    it('a key of the own Workspace without the permission gets the safe 403 naming only the permission, equal for existing and missing resources', async () => {
      const { a } = await world();
      const without = await key(wsA, NON_GLOBAL.filter((p) => !ep.needs.includes(p)));
      const before = await state();
      const onExisting = await send(ep, wsA, a, without);
      const onMissing = await send(ep, wsA, missingIds(), without);
      expect(onExisting.status).toBe(403);
      expect(fresh(onExisting)).toEqual(fresh(onMissing));
      expect(JSON.parse(onExisting.text).message).toBe(`Missing permission: ${ep.needs.join(', ')}`);
      expect(onExisting.text).not.toMatch(new RegExp(`${a.fileId}|${a.collectionId}|${a.tagId}|${a.tagName}|seed\\.txt`));
      expect(await state()).toBe(before);
    });

    it('the own Workspace succeeds with exactly one sufficient permission (every branch of OR permissions)', async () => {
      for (const p of ep.needs) {
        const { a } = await world();
        const res = await send(ep, wsA, a, await key(wsA, [p]));
        expect(res.status, `${ep.action} via ${p}`).toBe(ep.ok);
        if (ep.action === 'file.download') expect(res.bytes.equals(a.data)).toBe(true);
        if (ep.action === 'file.delete') expect((await ds.query('SELECT 1 FROM files WHERE id = $1', [a.fileId])).length).toBe(0);
        if (ep.action === 'collection.delete') expect((await ds.query('SELECT 1 FROM collections WHERE id = $1', [a.collectionId])).length).toBe(0);
        if (ep.action === 'tag.delete') expect((await ds.query('SELECT 1 FROM tags WHERE id = $1', [a.tagId])).length).toBe(0);
        if (ep.action === 'file.upload') expect((await ds.query('SELECT 1 FROM files WHERE id = $1', [JSON.parse(res.text).id])).length).toBe(1);
      }
    });
  });

  describe('foreign ids in filters and membership bodies', () => {
    it('Collection and tag filters with other-scope ids are byte-identical to nonexistent ones and expose no counts', async () => {
      const { a, b, g } = await world();
      const k = await key(wsA, ['files:read']);
      for (const [ws, auth] of [[wsA, k], [wsA, { admin: true } as Auth], [null, { admin: true } as Auth]] as const) {
        const list = (q: string) => raw('GET', `/api/${scopeSegOf(ws)}/files?${q}`, auth);
        const foreignCollections = ws ? [b.collectionId, g.collectionId] : [a.collectionId, b.collectionId];
        for (const foreign of foreignCollections) {
          expect(fresh(await list(`collectionId=${foreign}`))).toEqual(fresh(await list(`collectionId=${randomUUID()}`)));
        }
        const t1 = await list(`tag=${ws ? b.tagName : a.tagName}`);
        expect(fresh(t1)).toEqual(fresh(await list('tag=never-used-tag')));
        const body = JSON.parse(t1.text);
        expect(Object.keys(body).sort()).toEqual(['hasMore', 'items', 'limit', 'nextCursor']);
        expect(body.items).toEqual([]);
      }
    });

    it('a Collection of another scope or a nonexistent one gives one identical 400 on upload and update, with no residue', async () => {
      const { a, b, g } = await world();
      const k = await key(wsA, ['files:write']);
      const bad = [b.collectionId, g.collectionId, randomUUID(), 'not-a-uuid'];
      const upload = (id: string) =>
        raw('POST', `/api/workspaces/${wsA}/files`, k, { multipart: multipart([{ name: 'file', filename: 'x.txt', data: Buffer.from('x') }, { name: 'collectionId', value: id }]) });
      const before = await state();
      const first = await upload(bad[0]!);
      expect(first.status).toBe(400);
      for (const id of bad) expect(fresh(await upload(id))).toEqual(fresh(first));
      const upd = (id: string) => raw('PUT', `/api/workspaces/${wsA}/files/${a.fileId}`, k, { json: { name: 'moved.txt', collectionId: id, tags: [] } });
      const firstUpd = await upd(bad[0]!);
      expect(firstUpd.status).toBe(400);
      for (const id of bad) expect(fresh(await upd(id))).toEqual(fresh(firstUpd));
      expect(first.text).not.toMatch(new RegExp(`${b.collectionId}|${g.collectionId}`));
      // Every upload attempt cleaned up after itself; only the (rejected) update left the file as it was.
      const after = JSON.parse(await state());
      expect(JSON.parse(before).files).toEqual(after.files);
      expect(after.objects).toEqual(JSON.parse(before).objects);
      expect(after.intents).toEqual([]);
      expect(events.filter((e) => e === 'file.uploaded')).toEqual([]);
      // The same for the Global file: a Workspace Collection is "other scope" there.
      const gk = await raw('PUT', `/api/global/files/${g.fileId}`, { admin: true }, { json: { name: 'moved.txt', collectionId: a.collectionId, tags: [] } });
      const gm = await raw('PUT', `/api/global/files/${g.fileId}`, { admin: true }, { json: { name: 'moved.txt', collectionId: randomUUID(), tags: [] } });
      expect(gk.status).toBe(400);
      expect(fresh(gk)).toEqual(fresh(gm));
    });

    it('tag lists and Collection lists count only their own scope', async () => {
      const a = await seed(wsA);
      const shared = uniq('shared');
      for (const ws of [wsA, wsB, null]) {
        const sc = scopeCols(ws);
        const tag = ((await ds.query('INSERT INTO tags (scope, workspace_id, name) VALUES ($1,$2,$3) RETURNING id', [sc.scope, sc.workspaceId, shared])) as { id: string }[])[0]!.id;
        const extra = await seed(ws);
        await ds.query('INSERT INTO file_tags (file_id, tag_id, scope_key) VALUES ($1,$2,$3)', [extra.fileId, tag, ws ?? 'global']);
      }
      const list = JSON.parse((await raw('GET', `/api/workspaces/${wsA}/tags`, await key(wsA, ['files:read']))).text) as { name: string; fileCount: number; workspaceId: string | null }[];
      expect(list.every((t) => t.workspaceId === wsA)).toBe(true);
      expect(list.find((t) => t.name === shared)!.fileCount).toBe(1);
      expect(list).toHaveLength(3);
      expect(a.tagName).toBeTruthy();
    });
  });

  describe('hostile names and downloads', () => {
    const hostileNames = ['<img src=x onerror=alert(1)>.html', '../../etc/passwd', 'a"; filename="evil.exe', 'x\r\nSet-Cookie: pwn=1.txt', '‮gnp.exe', '..', 'CON.txt'];

    it('stores hostile names as inert text and always serves attachments with safe headers and a neutral type', async () => {
      const k = await key(wsA, ['files:write', 'files:read']);
      for (const name of hostileNames) {
        const up = await raw('POST', `/api/workspaces/${wsA}/files`, k, { multipart: multipart([{ name: 'file', filename: name.replace(/["\r\n]/g, '_'), type: 'text/html', data: Buffer.from('<script>alert(1)</script>') }]) });
        expect(up.status, name).toBe(201);
        expect(up.headers.get('content-type')).toMatch(/^application\/json/);
        const dto = JSON.parse(up.text);
        expect(dto.name).not.toMatch(/[\\/\r\n‮]/);
        expect(up.text).not.toMatch(/storage|originals|seshat-matrix/);
        const dl = await raw('GET', `/api/workspaces/${wsA}/files/${dto.id}/download`, k);
        expect(dl.status).toBe(200);
        expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%._~-]*$/);
        expect(dl.headers.get('content-disposition')).not.toMatch(/[\r\n]/);
        expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
        expect(dl.headers.get('content-type')).toBe('application/octet-stream');
        expect(dl.headers.get('content-security-policy')).toContain('sandbox');
        expect(dl.headers.get('cache-control')).toBe('private, no-store');
        expect(dl.headers.get('set-cookie')).toBeNull();
      }
    });

    it('Collection names and descriptions are returned verbatim as JSON data, never as markup, and invalid tag names are rejected', async () => {
      const k = await key(wsA, ['collections:write', 'collections:read', 'files:write']);
      const xss = '<script>alert("x")</script>';
      const created = await raw('POST', `/api/workspaces/${wsA}/collections`, k, { json: { name: xss, description: '<b onmouseover=1>' } });
      expect(created.status).toBe(201);
      expect(created.headers.get('content-type')).toMatch(/^application\/json/);
      expect(JSON.parse(created.text).name).toBe(xss);
      for (const tag of ['<script>', 'a b', 'x\ny', 'a;b']) {
        const res = await raw('POST', `/api/workspaces/${wsA}/files`, k, { multipart: multipart([{ name: 'file', filename: 'a.txt', data: Buffer.from('a') }, { name: 'tags', value: tag }]) });
        expect(res.status, tag).toBe(400);
        expect(res.text).not.toContain(tag);
      }
      expect(await objects()).toEqual([]);
    });
  });

  describe('end-to-end regressions with the production guard', () => {
    it('rejects an oversized upload with 413 and leaves no row, object, ledger entry or event; the next upload works', async () => {
      const k = await key(wsA, ['files:write']);
      const big = await raw('POST', `/api/workspaces/${wsA}/files`, k, { multipart: multipart([{ name: 'file', filename: 'big.bin', data: Buffer.alloc(5000, 1) }]) });
      expect(big.status).toBe(413);
      expect(big.text).not.toMatch(/seshat-matrix|originals/);
      expect(await objects()).toEqual([]);
      expect(await ds.query('SELECT 1 FROM files')).toEqual([]);
      expect(await ds.query('SELECT 1 FROM tags')).toEqual([]);
      expect(await ds.query('SELECT 1 FROM storage_cleanup_intents')).toEqual([]);
      expect(events).toEqual([]);
      const ok = await raw('POST', `/api/workspaces/${wsA}/files`, k, { multipart: multipart([{ name: 'file', filename: 'ok.txt', data: Buffer.alloc(1024, 2) }]) });
      expect(ok.status).toBe(201);
    });

    it('records size, hash and sanitized metadata, orders events after the commit and keeps the original byte-exact', async () => {
      const bus = app.get(EventEmitter2);
      const atUploaded: number[] = [];
      const atDeleted: number[] = [];
      const onUp = async (p: { id: string }) => void atUploaded.push((await ds.query('SELECT 1 FROM files WHERE id = $1', [p.id])).length);
      const onDel = async (p: { id: string }) => void atDeleted.push((await ds.query('SELECT 1 FROM files WHERE id = $1', [p.id])).length);
      bus.on('file.uploaded', onUp);
      bus.on('file.deleted', onDel);
      try {
        const data = Buffer.from('hello seshat');
        const rw = await key(wsA, ['files:write', 'files:read', 'files:delete']);
        const up = await raw('POST', `/api/workspaces/${wsA}/files`, rw, { multipart: multipart([{ name: 'file', filename: 'Report.TXT', type: 'text/plain', data }]) });
        const dto = JSON.parse(up.text);
        expect(up.status).toBe(201);
        expect(dto).toMatchObject({ name: 'Report.TXT', extension: 'txt', mimeType: 'text/plain', sizeBytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
        const dl = await raw('GET', `/api/workspaces/${wsA}/files/${dto.id}/download`, rw);
        expect(dl.bytes.equals(data)).toBe(true);
        expect((await raw('DELETE', `/api/workspaces/${wsA}/files/${dto.id}`, rw)).status).toBe(204);
        await vi.waitFor(async () => expect(await objects()).toEqual([]));
        // Uploaded was seen with a committed row; Deleted with the row already gone; uploaded precedes deleted.
        expect(atUploaded).toEqual([1]);
        expect(atDeleted).toEqual([0]);
        expect(events.indexOf('file.uploaded')).toBeLessThan(events.indexOf('file.deleted'));
        expect((await raw('GET', `/api/workspaces/${wsA}/files/${dto.id}`, rw)).status).toBe(404);
      } finally {
        bus.off('file.uploaded', onUp);
        bus.off('file.deleted', onDel);
      }
    });

    it('deleting a Collection keeps its files; detaching or deleting a Tag keeps the file and the other tags', async () => {
      const a = await seed(wsA);
      const k = await key(wsA, ['files:read', 'files:write', 'collections:write', 'collections:read']);
      expect((await raw('DELETE', `/api/workspaces/${wsA}/collections/${a.collectionId}`, k)).status).toBe(204);
      const file = JSON.parse((await raw('GET', `/api/workspaces/${wsA}/files/${a.fileId}`, k)).text);
      expect(file.collectionId).toBeNull();
      expect(file.tags).toEqual([a.tagName]);
      const second = uniq('second');
      await raw('PUT', `/api/workspaces/${wsA}/files/${a.fileId}`, k, { json: { name: file.name, collectionId: null, tags: [a.tagName, second] } });
      const detached = JSON.parse((await raw('PUT', `/api/workspaces/${wsA}/files/${a.fileId}`, k, { json: { name: file.name, collectionId: null, tags: [second] } })).text);
      expect(detached.tags).toEqual([second]);
      // The detached Tag still exists (Tags are reusable); deleting it affects no file.
      const tags = JSON.parse((await raw('GET', `/api/workspaces/${wsA}/tags`, k)).text) as { id: string; name: string }[];
      const old = tags.find((t) => t.name === a.tagName)!;
      expect((await raw('DELETE', `/api/workspaces/${wsA}/tags/${old.id}`, k)).status).toBe(204);
      expect(JSON.parse((await raw('GET', `/api/workspaces/${wsA}/files/${a.fileId}`, k)).text).tags).toEqual([second]);
      expect(await objects()).toHaveLength(1);
    });

    it('deleting a Workspace removes its data at once and retries stored-object removal from the persisted ledger after a failure; its keys stop working', async () => {
      const wsC = await addWorkspace('gamma');
      const k = await key(wsC, ['files:write', 'files:read']);
      const bystander = await seed(wsA);
      const up = await raw('POST', `/api/workspaces/${wsC}/files`, k, { multipart: multipart([{ name: 'file', filename: 'c.txt', data: Buffer.from('c') }]) });
      expect(up.status).toBe(201);
      expect(await objects()).toHaveLength(2);
      storage.failDelete = true;
      const del = await raw('DELETE', `/api/workspaces/${wsC}`, { admin: true }, { json: { slug: 'gamma' } });
      expect(del.status).toBe(204);
      expect(await ds.query('SELECT 1 FROM files WHERE workspace_id = $1', [wsC])).toEqual([]);
      await vi.waitFor(async () => expect(((await ds.query('SELECT attempts FROM storage_cleanup_intents')) as { attempts: number }[]).every((i) => i.attempts >= 1)).toBe(true));
      expect((await ds.query('SELECT 1 FROM storage_cleanup_intents')).length).toBe(1);
      expect(await objects()).toHaveLength(2);
      expect(logged.join('\n')).not.toMatch(/secret\/local|seshat-matrix/);
      // After the "restart" the ledger is drained and only the bystander's original remains.
      storage.failDelete = false;
      await ds.query('UPDATE storage_cleanup_intents SET next_attempt_at = now()');
      const restarted = new StorageCleanupService(ds, storage);
      restarted.onApplicationBootstrap();
      await restarted.drain();
      restarted.onApplicationShutdown();
      await vi.waitFor(async () => expect(await ds.query('SELECT 1 FROM storage_cleanup_intents')).toEqual([]));
      expect(await objects()).toHaveLength(1);
      expect((await raw('GET', `/api/workspaces/${wsC}/files`, k)).status).toBe(401);
      expect((await raw('GET', `/api/workspaces/${wsA}/files/${bystander.fileId}`, { admin: true })).status).toBe(200);
    });
  });

  it('leaks no storage keys, local paths, the pepper or key material in any response or logged failure of this suite', () => {
    const everything = [...seen, ...logged].join('\n');
    expect(everything.length).toBeGreaterThan(1000);
    expect(everything).not.toContain(root);
    expect(everything).not.toMatch(/seshat-matrix|"storageKey"|storage_key|\/originals\//);
    expect(everything).not.toContain(TEST_API_KEY_PEPPER);
    for (const secret of keyCache.values()) {
      expect(seen.join('\n')).not.toContain(secret);
      expect(logged.join('\n')).not.toContain(secret.split('_')[3]!);
    }
  });
});
