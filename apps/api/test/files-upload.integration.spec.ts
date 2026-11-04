import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { type INestApplication, Module } from '@nestjs/common';
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
import { FILE_UPLOADED_EVENT, type FileUploadedEvent } from '../src/files/file.events.js';
import { FileRecord } from '../src/files/file.entity.js';
import { FilesController } from '../src/files/files.controller.js';
import { FilesService } from '../src/files/files.service.js';
import { FILE_STORAGE, type FileStorage } from '../src/storage/file-storage.js';
import { LocalVolumeFileStorage } from '../src/storage/local-volume-file-storage.js';
import { StorageCleanupIntent } from '../src/storage/storage-cleanup-intent.entity.js';
import { StorageCleanupListener } from '../src/storage/storage-cleanup.listener.js';
import { StorageCleanupService } from '../src/storage/storage-cleanup.service.js';
import { FileTag } from '../src/tags/file-tag.entity.js';
import { Tag } from '../src/tags/tag.entity.js';
import { TagsService } from '../src/tags/tags.service.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

const LIMIT = 1024;

/** Collects what happened, in order, so tests can assert on event ordering relative to the commit. */
const seen: { event: FileUploadedEvent; rowExisted: boolean }[] = [];
let listenerShouldThrow = false;
let dsRef: DataSource;

class UploadListener {
  @OnEvent(FILE_UPLOADED_EVENT)
  async onUploaded(event: FileUploadedEvent) {
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

describeIntegration('File upload (real PostgreSQL and storage)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let adminCookie: string;
  let wsA: string;
  let wsB: string;
  let root: string;
  let storage: FlakyStorage;
  const keys = new Map<string, { workspaceId: string; permissions: Permission[] }>();
  let seq = 0;

  const bearer = (workspaceId: string, permissions: Permission[]) => {
    const key = `sk_seshat_TestKey${++seq}_secret${'x'.repeat(40)}`;
    keys.set(key, { workspaceId, permissions });
    return key;
  };

  type Auth = { key?: string; cookie?: string | null };
  const headersFor = (auth: Auth) => {
    const h: Record<string, string> = {};
    if (auth.key) h.authorization = `Bearer ${auth.key}`;
    else if (auth.cookie !== null) h.cookie = auth.cookie ?? adminCookie;
    return h;
  };

  async function upload(path: string, parts: Parameters<typeof multipart>[0], auth: Auth = {}) {
    const { body, contentType } = multipart(parts);
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { ...headersFor(auth), 'content-type': contentType }, body });
    const text = await res.text();
    return { status: res.status, text, json: (text ? safeJson(text) : undefined) as any };
  }

  /** Same upload without a Content-Length header (chunked transfer encoding). */
  async function uploadChunked(path: string, parts: Parameters<typeof multipart>[0], auth: Auth = {}) {
    const { body, contentType } = multipart(parts);
    async function* gen() {
      for (let i = 0; i < body.length; i += 100) yield body.subarray(i, i + 100);
    }
    const stream = ReadableStream.from(gen());
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...headersFor(auth), 'content-type': contentType },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const text = await res.text();
    return { status: res.status, text, json: (text ? safeJson(text) : undefined) as any };
  }

  const safeJson = (t: string) => {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };

  const file = (data: Buffer | string, extra: Partial<{ filename: string; type: string }> = {}) => ({
    name: 'file',
    filename: extra.filename ?? 'doc.txt',
    type: extra.type ?? 'text/plain',
    data: Buffer.isBuffer(data) ? data : Buffer.from(data),
  });

  async function storedFiles(dir = root): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await storedFiles(p)));
      else out.push(p);
    }
    return out;
  }
  const counts = async () => ({
    files: Number((await ds.query('SELECT count(*) c FROM files'))[0].c),
    tags: Number((await ds.query('SELECT count(*) c FROM tags'))[0].c),
    joins: Number((await ds.query('SELECT count(*) c FROM file_tags'))[0].c),
    objects: (await storedFiles()).length,
  });
  const none = { files: 0, tags: 0, joins: 0, objects: 0 };

  const g = '/api/global/files';
  const w = (id: string) => `/api/workspaces/${id}/files`;
  const addWorkspace = async (slug: string) =>
    ((await ds.query('INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id', [slug])) as { id: string }[])[0]!.id;

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
    root = await mkdtemp(path.join(tmpdir(), 'seshat-upload-'));
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
        UploadListener,
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
    storage.failPut = false;
    storage.failDelete = false;
    listenerShouldThrow = false;
    seen.length = 0;
    await ds.query('DELETE FROM file_tags');
    await ds.query('DELETE FROM files');
    await ds.query('DELETE FROM tags');
    await ds.query('DELETE FROM collections');
    for (const f of await storedFiles()) await rm(f, { force: true });
  });

  it('stores an upload of exactly the limit in Global and a Workspace with exact size, SHA-256 and metadata', async () => {
    const data = Buffer.alloc(LIMIT, 7);
    const sha = createHash('sha256').update(data).digest('hex');
    for (const [p, scope, workspaceId] of [[g, 'global', null], [w(wsA), 'workspace', wsA]] as const) {
      const res = await upload(p, [file(data, { filename: 'Report.PDF', type: 'Application/PDF' })]);
      expect(res.status).toBe(201);
      expect(Object.keys(res.json).sort()).toEqual(['collectionId', 'createdAt', 'extension', 'id', 'ingestionStatus', 'mimeType', 'name', 'scope', 'sha256', 'sizeBytes', 'tags', 'updatedAt', 'workspaceId']);
      expect(res.json).toMatchObject({ scope, workspaceId, name: 'Report.PDF', extension: 'pdf', mimeType: 'application/pdf', sizeBytes: LIMIT, sha256: sha, collectionId: null, tags: [], ingestionStatus: 'pending' });
      expect(res.text).not.toMatch(/originals|storage|\/tmp/i);
      const [row] = await ds.query('SELECT storage_key FROM files WHERE id = $1', [res.json.id]);
      const key = row.storage_key as string;
      expect(key).toBe(scope === 'global' ? `originals/global/${res.json.id}` : `originals/workspaces/${wsA}/${res.json.id}`);
      expect(await readFile(path.join(root, ...key.split('/')))).toEqual(data);
    }
  });

  it('answers limit+1 with 413 and leaves no row, join, tag, object or temporary file (Content-Length and chunked)', async () => {
    const data = Buffer.alloc(LIMIT + 1, 1);
    for (const send of [upload, uploadChunked]) {
      for (const p of [g, w(wsA)]) {
        const res = await send(p, [{ name: 'tags', value: 'one' }, file(data)]);
        expect(res.status).toBe(413);
        expect(res.json).toMatchObject({ statusCode: 413, message: 'Payload too large' });
        expect(await counts()).toEqual(none);
      }
    }
    expect(seen).toEqual([]);
    // the server keeps working afterwards
    expect((await upload(g, [file('ok')])).status).toBe(201);
  });

  it('accepts an at-limit chunked upload without Content-Length', async () => {
    const data = Buffer.alloc(LIMIT, 9);
    const res = await uploadChunked(w(wsA), [file(data)]);
    expect(res.status).toBe(201);
    expect(res.json.sizeBytes).toBe(LIMIT);
    expect(res.json.sha256).toBe(createHash('sha256').update(data).digest('hex'));
  });

  it('sanitizes hostile names and never uses them as paths', async () => {
    const cases: [string, string, string | null][] = [
      ['../../etc/passwd', 'passwd', null],
      ['..\\..\\boot\\Evil.TXT', 'Evil.TXT', 'txt'],
      ['na\u202eme.TxT', 'name.TxT', 'txt'],
      ['  ..  ', 'file', null],
      ['x'.repeat(300) + '.md', 'x'.repeat(251) + '.md', 'md'],
    ];
    for (const [raw, name, extension] of cases) {
      const res = await upload(w(wsA), [file('hi', { filename: raw })]);
      expect(res.status, raw).toBe(201);
      expect(res.json.name.length).toBeLessThanOrEqual(255);
      if (raw.startsWith('x')) expect(res.json.name.startsWith('x')).toBe(true);
      else expect(res.json).toMatchObject({ name, extension });
    }
    const keys = (await ds.query('SELECT storage_key FROM files')).map((r: any) => r.storage_key as string);
    for (const k of keys) expect(k).toMatch(/^originals\/workspaces\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    expect((await storedFiles()).every((p) => !/passwd|Evil/i.test(path.relative(root, p)))).toBe(true);
  });

  it('defaults a missing or malformed MIME type', async () => {
    const res = await upload(g, [{ name: 'file', filename: 'a.bin', data: Buffer.from('x') }]);
    expect(res.json.mimeType).toBe('text/plain'); // multipart's own default when the part declares nothing
    const res2 = await upload(g, [file('x', { type: 'nonsense' })]);
    expect(res2.status).toBe(201);
    expect(res2.json.mimeType).toMatch(/^[a-z]+\/[a-z.+-]+$/); // busboy already normalizes junk; the sanitizer is unit-tested
  });

  it('commits an optional same-scope Collection and auto-created normalized tags atomically', async () => {
    const [{ id: cid }] = await ds.query(`INSERT INTO collections (scope, workspace_id, name) VALUES ('workspace', $1, 'Docs') RETURNING id`, [wsA]);
    const res = await upload(w(wsA), [{ name: 'collectionId', value: cid }, { name: 'tags', value: ' Alpha ' }, { name: 'tags', value: 'beta' }, { name: 'tags', value: 'ALPHA' }, file('x')]);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ collectionId: cid, tags: ['alpha', 'beta'] });
    const tags = await ds.query('SELECT name, scope, workspace_id FROM tags ORDER BY name');
    expect(tags).toEqual([{ name: 'alpha', scope: 'workspace', workspace_id: wsA }, { name: 'beta', scope: 'workspace', workspace_id: wsA }]);
    expect(Number((await ds.query('SELECT count(*) c FROM file_tags'))[0].c)).toBe(2);
    // same tag name in Global is a separate tag
    expect((await upload(g, [{ name: 'tags', value: 'alpha' }, file('x')])).status).toBe(201);
    expect(Number((await ds.query('SELECT count(*) c FROM tags'))[0].c)).toBe(3);
  });

  it('answers an invalid Collection with one non-revealing 400 and rolls everything back', async () => {
    const [{ id: foreign }] = await ds.query(`INSERT INTO collections (scope, workspace_id, name) VALUES ('workspace', $1, 'Theirs') RETURNING id`, [wsB]);
    const [{ id: global }] = await ds.query(`INSERT INTO collections (scope, workspace_id, name) VALUES ('global', NULL, 'Shared') RETURNING id`);
    const bodies = new Set<string>();
    for (const cid of [foreign, global, randomUUID(), 'not-a-uuid']) {
      const res = await upload(w(wsA), [{ name: 'collectionId', value: cid }, { name: 'tags', value: 'leaktest' }, file('x')]);
      expect(res.status).toBe(400);
      bodies.add(res.text);
      expect(await counts()).toEqual(none);
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).not.toContain(foreign);
  });

  it('rejects invalid tags with 400 and leaves no residue', async () => {
    for (const tag of ['has space', '', 'x'.repeat(51)]) {
      const res = await upload(g, [{ name: 'tags', value: tag }, file('x')]);
      expect(res.status, tag).toBe(400);
      expect(await counts()).toEqual(none);
    }
  });

  it('rejects malformed multipart, missing file, extra fields/files and non-multipart bodies without residue', async () => {
    const bad = await fetch(`${base}${w(wsA)}`, {
      method: 'POST',
      headers: { ...headersFor({}), 'content-type': 'multipart/form-data; boundary=zzz' },
      body: '--zzz\r\nthis is not a valid part\r\n',
    });
    expect(bad.status).toBe(400);
    expect((await upload(g, [{ name: 'tags', value: 'a' }])).status).toBe(400); // no file part
    expect((await upload(g, [file('x'), { ...file('y'), name: 'other' }])).status).toBe(400); // wrong part name
    expect((await upload(g, [file('x'), file('y')])).status).toBe(400); // two files
    expect((await upload(g, [{ name: 'scope', value: 'global' }, file('x')])).status).toBe(400); // unknown field
    const json = await fetch(`${base}${g}`, { method: 'POST', headers: { ...headersFor({}), 'content-type': 'application/json' }, body: '{}' });
    expect(json.status).toBe(400);
    const none400 = await fetch(`${base}${g}`, { method: 'POST', headers: headersFor({}) });
    expect(none400.status).toBe(400);
    expect(await counts()).toEqual(none);
  });

  it('removes the partial object when the client aborts mid-stream', async () => {
    const { body, contentType } = multipart([file(Buffer.alloc(900, 3))]);
    await new Promise<void>((resolve) => {
      const req = httpRequest(`${base}${g}`, { method: 'POST', headers: { ...headersFor({}), 'content-type': contentType, 'content-length': String(body.length) } });
      req.on('error', () => resolve());
      req.write(body.subarray(0, body.length - 200));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 100);
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(await counts()).toEqual(none);
  });

  it('enforces authorization before consuming or storing the body', async () => {
    const data = Buffer.alloc(LIMIT, 1);
    const readOnly = bearer(wsA, ['files:read']);
    const writer = bearer(wsA, ['files:write']);
    const globalReader = bearer(wsA, ['files:read', 'files:write', 'global:read']);
    const noAuth = await upload(w(wsA), [file(data)], { cookie: null });
    expect(noAuth.status).toBe(401);
    expect((await upload(w(wsA), [file(data)], { key: readOnly })).status).toBe(403);
    const foreign = await upload(w(wsB), [file(data)], { key: writer });
    const missing = await upload(w(randomUUID()), [file(data)], { key: writer });
    expect(foreign.status).toBe(404);
    expect(foreign.text).toBe(missing.text);
    const globalNoGrant = await upload(g, [file(data)], { key: writer });
    expect(globalNoGrant.status).toBe(404);
    expect((await upload(g, [file(data)], { key: globalReader })).status).toBe(403); // a key never writes Global
    expect(seen).toEqual([]);
    expect(await counts()).toEqual(none);
    // a key with files:write works in its own Workspace only
    expect((await upload(w(wsA), [file('ok')], { key: writer })).status).toBe(201);
  });

  it('returns 404 for a nonexistent Workspace for the admin without storing anything', async () => {
    const res = await upload(w(randomUUID()), [file('x')]);
    expect(res.status).toBe(404);
    expect(await counts()).toEqual(none);
    expect((await upload('/api/workspaces/not-a-uuid/files', [file('x')])).status).toBe(400);
  });

  it('compensates a storage failure without a row and without leaking the cause', async () => {
    storage.failPut = true;
    const res = await upload(g, [file('x')]);
    expect(res.status).toBe(500);
    expect(res.text).not.toMatch(/fire|secret|path/i);
    expect(await counts()).toEqual(none);
    expect(seen).toEqual([]);
  });

  it('keeps the original error when removing the object during compensation also fails', async () => {
    storage.failDelete = true;
    const res = await upload(g, [{ name: 'collectionId', value: randomUUID() }, file('x')]);
    expect(res.status).toBe(400);
    expect(res.json.message).toBe('Invalid collection');
    storage.failDelete = false;
  });

  it('emits file.uploaded with id and explicit scope only after the commit, never on rollback', async () => {
    const a = await upload(w(wsA), [file('x')]);
    const b = await upload(g, [file('y')]);
    await upload(g, [{ name: 'collectionId', value: randomUUID() }, file('z')]); // rolled back
    await upload(g, [file(Buffer.alloc(LIMIT + 1))]); // 413
    expect(seen).toEqual([
      { event: { id: a.json.id, scope: { kind: 'workspace', workspaceId: wsA } }, rowExisted: true },
      { event: { id: b.json.id, scope: { kind: 'global' } }, rowExisted: true },
    ]);
  });

  it('keeps a committed upload successful when a post-commit listener fails', async () => {
    listenerShouldThrow = true;
    const res = await upload(w(wsA), [file('x')]);
    expect(res.status).toBe(201);
    expect((await counts()).files).toBe(1);
    expect((await counts()).objects).toBe(1);
    expect(seen).toHaveLength(1);
  });
});
