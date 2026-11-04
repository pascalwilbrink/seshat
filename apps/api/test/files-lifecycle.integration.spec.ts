import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { type INestApplication, Logger, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule, OnEvent } from '@nestjs/event-emitter';
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
import { FILE_DELETED_EVENT, type FileDeletedEvent } from '../src/files/file.events.js';
import { StorageCleanupService } from '../src/storage/storage-cleanup.service.js';
import { StorageCleanupListener } from '../src/storage/storage-cleanup.listener.js';
import { FileRecord } from '../src/files/file.entity.js';
import { FilesController } from '../src/files/files.controller.js';
import { FilesService } from '../src/files/files.service.js';
import { StorageCleanupIntent } from '../src/storage/storage-cleanup-intent.entity.js';
import { FILE_STORAGE, type FileStorage } from '../src/storage/file-storage.js';
import { LocalVolumeFileStorage } from '../src/storage/local-volume-file-storage.js';
import { FileTag } from '../src/tags/file-tag.entity.js';
import { Tag } from '../src/tags/tag.entity.js';
import { TagsService } from '../src/tags/tags.service.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

const LIMIT = 1024;

const seen: { event: FileDeletedEvent; rowExisted: boolean }[] = [];
let listenerShouldThrow = false;
let dsRef: DataSource;

class DeleteObserver {
  // Registered before the cleanup listener is not guaranteed; it only records the DB state at emit time.
  @OnEvent(FILE_DELETED_EVENT)
  async onDeleted(event: FileDeletedEvent) {
    const rows = await dsRef.query('SELECT 1 FROM files WHERE id = $1', [event.id]);
    seen.push({ event, rowExisted: rows.length === 1 });
    if (listenerShouldThrow) throw new Error('listener boom');
  }
}

/** Real storage with failure injection. */
class FlakyStorage implements FileStorage {
  failPut = false;
  failDelete = false;
  constructor(readonly inner: LocalVolumeFileStorage) {}
  async put(key: string, stream: Readable) {
    if (this.failPut) {
      stream.resume();
      throw new Error('disk on fire /secret/path');
    }
    return this.inner.put(key, stream);
  }
  get(key: string) {
    return this.inner.get(key);
  }
  exists(key: string) {
    return this.inner.exists(key);
  }
  async delete(key: string) {
    if (this.failDelete) throw new Error('cannot delete');
    return this.inner.delete(key);
  }
}

function multipart(parts: { name: string; value?: string; filename?: string; type?: string; data?: Buffer }[], boundary = '----seshattest') {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.type) head += `Content-Type: ${p.type}\r\n`;
    chunks.push(Buffer.from(`${head}\r\n`), p.data ?? Buffer.from(p.value ?? ''), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describeIntegration('File edit and delete (real PostgreSQL and storage)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let adminCookie: string;
  let wsA: string;
  let wsB: string;
  let root: string;
  let storage: FlakyStorage;
  let cleanup: StorageCleanupService;
  const keys = new Map<string, { workspaceId: string; permissions: Permission[] }>();
  let seq = 0;

  const bearer = (workspaceId: string, permissions: Permission[]) => {
    const key = `sk_seshat_TestKey${++seq}_secret${'x'.repeat(40)}`;
    keys.set(key, { workspaceId, permissions });
    return key;
  };
  type Auth = { key?: string };
  const headersFor = (auth: Auth) => (auth.key ? { authorization: `Bearer ${auth.key}` } : { cookie: adminCookie });
  const safeJson = (t: string) => {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };
  async function send(method: string, p: string, body?: unknown, auth: Auth = {}) {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { ...headersFor(auth), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: (text ? safeJson(text) : undefined) as any };
  }
  async function upload(p: string, parts: Parameters<typeof multipart>[0]) {
    const { body, contentType } = multipart(parts);
    const res = await fetch(`${base}${p}`, { method: 'POST', headers: { ...headersFor({}), 'content-type': contentType }, body });
    return { status: res.status, json: safeJson(await res.text()) as any };
  }
  const put = async (p: string, data = 'hello', extra: Parameters<typeof multipart>[0] = []) => {
    const res = await upload(p, [{ name: 'file', filename: 'doc.txt', type: 'text/plain', data: Buffer.from(data) }, ...extra]);
    expect(res.status).toBe(201);
    return res.json as { id: string; sha256: string; sizeBytes: number };
  };
  const keyOf = async (id: string) => ((await ds.query('SELECT storage_key FROM files WHERE id = $1', [id]))[0]?.storage_key ?? null) as string | null;
  const objectPath = (key: string) => path.join(root, ...key.split('/'));
  async function objects(dir = root): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await objects(p)));
      else out.push(p);
    }
    return out;
  }
  const intents = async () => (await ds.query('SELECT * FROM storage_cleanup_intents ORDER BY created_at')) as any[];
  const makeDue = () => ds.query('UPDATE storage_cleanup_intents SET next_attempt_at = now()');
  const addWorkspace = async (slug: string) =>
    ((await ds.query('INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id', [slug])) as { id: string }[])[0]!.id;

  const g = '/api/global/files';
  const w = (id: string) => `/api/workspaces/${id}/files`;

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey, Collection, Tag, FileTag, FileRecord, StorageCleanupIntent]);
    dsRef = ds;
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    wsA = await addWorkspace('alpha');
    wsB = await addWorkspace('beta');
    root = await mkdtemp(path.join(tmpdir(), 'seshat-lifecycle-'));
    storage = new FlakyStorage(await LocalVolumeFileStorage.open(root));

    for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test', MAX_UPLOAD_BYTES: String(LIMIT) })) {
      vi.stubEnv(k, v);
    }
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
        StorageCleanupService,
        StorageCleanupListener,
        FilesService,
        DeleteObserver,
      ],
    })
    class TestRoot {}
    app = await createApp(TestRoot, { trustProxy: false }, false);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    adminCookie = `${SESSION_COOKIE_NAME}=${app.get(AuthService).issueSessionToken()}`;
    cleanup = app.get(StorageCleanupService);
  });

  afterAll(async () => {
    await app?.close();
    await iso?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    storage.failDelete = false;
    listenerShouldThrow = false;
    seen.length = 0;
    await ds.query('DELETE FROM storage_cleanup_intents');
    await ds.query('DELETE FROM file_tags');
    await ds.query('DELETE FROM files');
    await ds.query('DELETE FROM tags');
    await ds.query('DELETE FROM collections');
    for (const f of await objects()) await rm(f, { force: true });
  });

  const collection = async (scopeWs: string | null, name: string) =>
    ((await ds.query(
      scopeWs
        ? `INSERT INTO collections (scope, workspace_id, name) VALUES ('workspace', $1, $2) RETURNING id`
        : `INSERT INTO collections (scope, workspace_id, name) VALUES ('global', $1, $2) RETURNING id`,
      [scopeWs, name],
    )) as { id: string }[])[0]!.id;

  describe('PATCH', () => {
    it('renames, sets and clears the Collection and replaces tags in Global and a Workspace, keeping bytes, hash and size', async () => {
      for (const [p, ws] of [[g, null], [w(wsA), wsA]] as const) {
        const f = await put(p, 'original bytes', [{ name: 'tags', value: 'old' }]);
        const key = (await keyOf(f.id))!;
        const col = await collection(ws, `c-${ws ?? 'g'}`);
        const res = await send('PATCH', `${p}/${f.id}`, { name: '../Notes.MD', collectionId: col, tags: ['B', 'a', 'a'] });
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ id: f.id, name: 'Notes.MD', extension: 'md', collectionId: col, tags: ['a', 'b'], sha256: f.sha256, sizeBytes: f.sizeBytes, mimeType: 'text/plain' });
        expect(res.text).not.toMatch(/originals|storage|seshat-lifecycle/i);
        expect(await readFile(objectPath(key), 'utf8')).toBe('original bytes');
        expect(await keyOf(f.id)).toBe(key);

        const cleared = await send('PATCH', `${p}/${f.id}`, { collectionId: null });
        expect(cleared.json).toMatchObject({ collectionId: null, name: 'Notes.MD', tags: ['a', 'b'] });
        const noTags = await send('PATCH', `${p}/${f.id}`, { tags: [] });
        expect(noTags.json.tags).toEqual([]);
        expect(Number((await ds.query('SELECT count(*) c FROM file_tags WHERE file_id = $1', [f.id]))[0].c)).toBe(0);
      }
    });

    it('rejects unknown and forbidden fields and empty bodies with 400 and changes nothing', async () => {
      const f = await put(w(wsA));
      const before = (await ds.query('SELECT * FROM files WHERE id = $1', [f.id]))[0];
      for (const body of [
        {},
        { name: '' },
        { name: 'ok', sha256: 'a'.repeat(64) },
        { storageKey: 'x' },
        { scope: 'global' },
        { workspaceId: wsB },
        { sizeBytes: 1 },
        { ingestionStatus: 'indexed' },
        { mimeType: 'text/html' },
        { collectionId: 5 },
        { tags: 'a' },
        { tags: [1] },
      ]) {
        const res = await send('PATCH', `${w(wsA)}/${f.id}`, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect((await ds.query('SELECT * FROM files WHERE id = $1', [f.id]))[0]).toEqual(before);
    });

    it('answers the same 400 for a nonexistent, malformed and other-scope Collection and rolls the whole edit back', async () => {
      const f = await put(w(wsA), 'x', [{ name: 'tags', value: 'keep' }]);
      const foreign = await collection(wsB, 'foreign');
      const global = await collection(null, 'global-col');
      const results = [];
      for (const collectionId of [randomUUID(), foreign, global, 'not-a-uuid']) {
        const res = await send('PATCH', `${w(wsA)}/${f.id}`, { name: 'renamed.txt', tags: ['new'], collectionId });
        expect(res.status).toBe(400);
        results.push(res.text);
      }
      expect(new Set(results).size).toBe(1);
      const row = (await ds.query('SELECT name, collection_id FROM files WHERE id = $1', [f.id]))[0];
      expect(row).toEqual({ name: 'doc.txt', collection_id: null });
      expect((await ds.query('SELECT t.name FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = $1', [f.id])).map((r: any) => r.name)).toEqual(['keep']);
      expect((await ds.query(`SELECT 1 FROM tags WHERE name = 'new'`)).length).toBe(0);
    });

    it('rolls back rename and Collection when a tag name is invalid', async () => {
      const f = await put(w(wsA));
      const col = await collection(wsA, 'c');
      const res = await send('PATCH', `${w(wsA)}/${f.id}`, { name: 'changed.txt', collectionId: col, tags: ['bad name!'] });
      expect(res.status).toBe(400);
      expect((await ds.query('SELECT name, collection_id FROM files WHERE id = $1', [f.id]))[0]).toEqual({ name: 'doc.txt', collection_id: null });
    });

    it('is gated by files:write; foreign and missing files give identical 404s; keys cannot touch Global', async () => {
      const f = await put(w(wsA));
      const read = bearer(wsA, ['files:read']);
      const write = bearer(wsA, ['files:write']);
      const otherWs = bearer(wsB, ['files:write', 'files:read', 'files:delete']);
      const globalKey = bearer(wsA, ['files:write', 'global:read']);
      const body = { name: 'x.txt' };

      expect((await send('PATCH', `${w(wsA)}/${f.id}`, body, { key: read })).status).toBe(403);
      expect((await send('PATCH', `${w(wsA)}/${f.id}`, body, { key: write })).status).toBe(200);

      const foreign = await send('PATCH', `${w(wsA)}/${f.id}`, body, { key: otherWs });
      const missing = await send('PATCH', `${w(wsA)}/${randomUUID()}`, body, { key: otherWs });
      expect(foreign.status).toBe(404);
      expect(foreign.text).toBe(missing.text);
      expect((await send('PATCH', `${w(wsA)}/not-a-uuid`, body)).status).toBe(404);

      const gf = await put(g);
      const gRes = await send('PATCH', `${g}/${gf.id}`, body, { key: globalKey });
      const gMissing = await send('PATCH', `${g}/${randomUUID()}`, body, { key: globalKey });
      expect(gRes.status).toBe(gMissing.status);
      expect(gRes.text).toBe(gMissing.text);
      expect((await ds.query('SELECT name FROM files WHERE id = $1', [gf.id]))[0].name).toBe('doc.txt');

      // a Workspace-A file addressed through Workspace B's path (admin) is simply missing
      expect((await send('PATCH', `${w(wsB)}/${f.id}`, body)).status).toBe(404);
      expect((await ds.query('SELECT name FROM files WHERE id = $1', [f.id]))[0].name).toBe('x.txt');
    });
  });

  describe('DELETE', () => {
    it('removes row, joins and the stored original, emits file.deleted only after commit, and clears the ledger', async () => {
      for (const [p, ws] of [[g, null], [w(wsA), wsA]] as const) {
        seen.length = 0;
        const col = await collection(ws, `c${ws}`);
        const f = await put(p, 'bye', [{ name: 'tags', value: 't1' }, { name: 'collectionId', value: col }]);
        const key = (await keyOf(f.id))!;
        expect(await readFile(objectPath(key), 'utf8')).toBe('bye');
        const res = await send('DELETE', `${p}/${f.id}`);
        expect(res.status).toBe(204);
        expect(res.text).toBe('');
        expect(await keyOf(f.id)).toBeNull();
        expect(Number((await ds.query('SELECT count(*) c FROM file_tags WHERE file_id = $1', [f.id]))[0].c)).toBe(0);
        expect((await objects()).length).toBe(0);
        expect(await intents()).toEqual([]);
        expect(seen).toHaveLength(1);
        expect(seen[0]!.rowExisted).toBe(false); // the commit happened before the event
        expect(seen[0]!.event.id).toBe(f.id);
        // the Collection and the Tag stay
        expect((await ds.query('SELECT 1 FROM collections WHERE id = $1', [col])).length).toBe(1);
        expect((await ds.query(`SELECT 1 FROM tags WHERE name = 't1' AND scope_key = $1`, [ws ?? 'global'])).length).toBe(1);
        expect((await send('DELETE', `${p}/${f.id}`)).status).toBe(404);
      }
    });

    it('tolerates an already missing object', async () => {
      const f = await put(w(wsA));
      await rm(objectPath((await keyOf(f.id))!));
      expect((await send('DELETE', `${w(wsA)}/${f.id}`)).status).toBe(204);
      expect(await intents()).toEqual([]);
    });

    it('is gated by files:delete; foreign and missing give identical 404s and touch nothing; no event', async () => {
      const f = await put(w(wsA));
      const noDelete = bearer(wsA, ['files:read', 'files:write']);
      const otherWs = bearer(wsB, ['files:delete']);
      const globalKey = bearer(wsA, ['files:delete', 'global:read']);
      expect((await send('DELETE', `${w(wsA)}/${f.id}`, undefined, { key: noDelete })).status).toBe(403);
      const foreign = await send('DELETE', `${w(wsA)}/${f.id}`, undefined, { key: otherWs });
      const missing = await send('DELETE', `${w(wsA)}/${randomUUID()}`, undefined, { key: otherWs });
      expect(foreign.status).toBe(404);
      expect(foreign.text).toBe(missing.text);
      const gf = await put(g);
      const gRes = await send('DELETE', `${g}/${gf.id}`, undefined, { key: globalKey });
      expect(gRes.status).toBe(404);
      expect((await send('DELETE', `${w(wsB)}/${f.id}`)).status).toBe(404);
      expect((await send('DELETE', `${w(wsA)}/not-a-uuid`)).status).toBe(404);
      expect(await keyOf(f.id)).not.toBeNull();
      expect(await keyOf(gf.id)).not.toBeNull();
      expect((await objects()).length).toBe(2);
      expect(seen).toEqual([]);
      expect(await intents()).toEqual([]);
    });

    it('keeps the 204 and a persisted retry intent when storage fails, then removes the object on retry', async () => {
      const errSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const f = await put(w(wsA), 'stuck');
        const key = (await keyOf(f.id))!;
        storage.failDelete = true;
        const res = await send('DELETE', `${w(wsA)}/${f.id}`);
        expect(res.status).toBe(204);
        expect(await keyOf(f.id)).toBeNull(); // the row is not resurrected
        expect((await objects()).length).toBe(1);
        const [intent] = await intents();
        expect(intent).toMatchObject({ resource_type: 'file', resource_id: f.id, attempts: 1, last_error: 'Error', storage_key: key });
        expect(new Date(intent.next_attempt_at).getTime()).toBeGreaterThan(Date.now()); // backed off

        // not yet due: nothing happens
        expect(await cleanup.drain()).toEqual({ removed: 0, failed: 0 });

        storage.failDelete = false;
        await makeDue();
        expect(await cleanup.drain()).toEqual({ removed: 1, failed: 0 });
        expect((await objects()).length).toBe(0);
        expect(await intents()).toEqual([]);

        const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(logged).toContain(f.id);
        expect(logged).not.toMatch(/originals|seshat-lifecycle|secret|stuck|\/tmp/i);
      } finally {
        errSpy.mockRestore();
      }
    });

    it('recovers pending intents on restart and survives duplicate and concurrent drains and events', async () => {
      const f1 = await put(g, 'one');
      const f2 = await put(w(wsA), 'two');
      storage.failDelete = true;
      expect((await send('DELETE', `${g}/${f1.id}`)).status).toBe(204);
      expect((await send('DELETE', `${w(wsA)}/${f2.id}`)).status).toBe(204);
      expect(await intents()).toHaveLength(2);
      expect((await objects()).length).toBe(2);

      // "restart": a fresh service instance over the same database and storage
      storage.failDelete = false;
      await makeDue();
      const restarted = new StorageCleanupService(ds, storage);
      restarted.onApplicationBootstrap();
      const results = await Promise.all([restarted.drain(), cleanup.drain(), restarted.drain({ resourceId: f1.id })]);
      expect(results.every((r) => r.failed === 0)).toBe(true); // claims never overlap, nothing fails
      restarted.onApplicationShutdown();
      expect((await objects()).length).toBe(0);
      expect(await intents()).toEqual([]);

      // duplicate event for an already cleaned file is harmless
      const listener = app.get(StorageCleanupListener);
      await expect(Promise.all([listener.onFileDeleted({ id: f1.id, scope: { kind: 'global' } }), listener.onFileDeleted({ id: f1.id, scope: { kind: 'global' } })])).resolves.toBeDefined();
    });

    it('does not turn a failing event listener into an error; the cleanup intent stays recoverable', async () => {
      const errSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        listenerShouldThrow = true;
        const f = await put(w(wsA));
        const res = await send('DELETE', `${w(wsA)}/${f.id}`);
        expect(res.status).toBe(204);
        expect(await keyOf(f.id)).toBeNull();
        // Other listeners ran independently or the intent is still there: either way nothing is lost.
        await cleanup.drain();
        expect((await objects()).length).toBe(0);
        expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/secret|\/tmp|originals/);
      } finally {
        errSpy.mockRestore();
      }
    });
  });

  describe('transaction helpers', () => {
    it('rolls everything back, intent included, when the surrounding transaction fails (no event)', async () => {
      const f = await put(w(wsA));
      await expect(
        ds.transaction(async (manager) => {
          await cleanup.deleteScopedFilesWithIntents(manager, { kind: 'workspace', workspaceId: wsA });
          expect(await manager.query('SELECT 1 FROM storage_cleanup_intents')).toHaveLength(1);
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await keyOf(f.id)).not.toBeNull();
      expect(await intents()).toEqual([]);
      expect((await objects()).length).toBe(1);
      expect(seen).toEqual([]);
    });

    it('captures keys and deletes only the scope\'s files and joins; the intents then drain', async () => {
      const a = await put(w(wsA), 'a', [{ name: 'tags', value: 'x' }]);
      const b = await put(w(wsB), 'b');
      const gl = await put(g, 'g');
      const count = await ds.transaction((m) => cleanup.deleteScopedFilesWithIntents(m, { kind: 'workspace', workspaceId: wsA }));
      expect(count).toBe(1);
      expect(await keyOf(a.id)).toBeNull();
      expect(await keyOf(b.id)).not.toBeNull();
      expect(await keyOf(gl.id)).not.toBeNull();
      expect((await intents()).map((i) => i.resource_id)).toEqual([a.id]);
      expect(await cleanup.drain({ scopeKey: wsA })).toEqual({ removed: 1, failed: 0 });
      expect((await objects()).length).toBe(2);
    });
  });
});
