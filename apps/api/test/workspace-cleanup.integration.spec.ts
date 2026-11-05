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
import { FILE_STORAGE, type FileStorage } from '../src/storage/file-storage.js';
import { LocalVolumeFileStorage } from '../src/storage/local-volume-file-storage.js';
import { StorageCleanupIntent } from '../src/storage/storage-cleanup-intent.entity.js';
import { StorageCleanupListener } from '../src/storage/storage-cleanup.listener.js';
import { StorageCleanupService } from '../src/storage/storage-cleanup.service.js';
import { WorkspaceDataCleanup } from '../src/storage/workspace-data-cleanup.js';
import { Memory } from '../src/memories/memory.entity.js';
import { MemoryTag } from '../src/memories/memory-tag.entity.js';
import { FileTag } from '../src/tags/file-tag.entity.js';
import { Tag } from '../src/tags/tag.entity.js';
import { TagsService } from '../src/tags/tags.service.js';
import { WORKSPACE_CLEANUP } from '../src/workspaces/workspace-cleanup.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { WorkspacesService } from '../src/workspaces/workspace.service.js';
import { WorkspacesController } from '../src/workspaces/workspaces.controller.js';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

class FlakyStorage implements FileStorage {
  failDelete = false;
  /** Resolves when set; lets a test hold an upload between "object stored" and "row inserted". */
  afterPut: (() => Promise<void>) | undefined;
  constructor(readonly inner: LocalVolumeFileStorage) {}
  async put(key: string, stream: Readable) {
    const r = await this.inner.put(key, stream);
    await this.afterPut?.();
    return r;
  }
  get(key: string) {
    return this.inner.get(key);
  }
  exists(key: string) {
    return this.inner.exists(key);
  }
  async delete(key: string) {
    if (this.failDelete) throw new Error('cannot delete /secret/path');
    return this.inner.delete(key);
  }
}

function multipart(parts: { name: string; value?: string; filename?: string; data?: Buffer }[]) {
  const b = '----wscleanup';
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${b}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"\r\nContent-Type: text/plain`;
    chunks.push(Buffer.from(`${head}\r\n\r\n`), p.data ?? Buffer.from(p.value ?? ''), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${b}` };
}

describeIntegration('Workspace deletion cleans scoped resources and stored originals (real PostgreSQL and storage)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let cookie: string;
  let root: string;
  let storage: FlakyStorage;
  let cleanup: StorageCleanupService;
  const errors: string[] = [];

  const slugs = new Map<string, string>();
  const addWorkspace = async (slug: string) => {
    const id = ((await ds.query('INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id', [slug])) as { id: string }[])[0]!.id;
    slugs.set(id, slug);
    return id;
  };
  const del = async (id: string, slug = slugs.get(id)!) => {
    const res = await fetch(`${base}/api/workspaces/${id}`, { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ slug }) });
    return { status: res.status, text: await res.text() };
  };
  async function upload(p: string, name: string, extra: { name: string; value: string }[] = [], data = 'bytes') {
    const { body, contentType } = multipart([{ name: 'file', filename: name, data: Buffer.from(data) }, ...extra]);
    const res = await fetch(`${base}${p}`, { method: 'POST', headers: { cookie, 'content-type': contentType }, body });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  }
  const wsFiles = (id: string) => `/api/workspaces/${id}/files`;
  async function objects(dir = root): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await objects(p)));
      else out.push(p);
    }
    return out;
  }
  const count = async (table: string, where = 'true', params: unknown[] = []) =>
    Number(((await ds.query(`SELECT count(*) c FROM ${table} WHERE ${where}`, params)) as { c: string }[])[0]!.c);
  const intents = async () => (await ds.query('SELECT * FROM storage_cleanup_intents')) as { resource_id: string; scope_key: string; attempts: number; last_error: string | null }[];
  const makeDue = () => ds.query('UPDATE storage_cleanup_intents SET next_attempt_at = now()');
  const collection = async (ws: string | null, name: string) =>
    ((await ds.query(`INSERT INTO collections (scope, workspace_id, name) VALUES ($1, $2, $3) RETURNING id`, [ws ? 'workspace' : 'global', ws, name])) as { id: string }[])[0]!.id;
  const populate = async (ws: string) => {
    const col = await collection(ws, 'docs');
    const a = await upload(wsFiles(ws), 'a.txt', [{ name: 'tags', value: 'one' }, { name: 'collectionId', value: col }]);
    const b = await upload(wsFiles(ws), 'b.txt', [{ name: 'tags', value: 'two' }]);
    expect([a.status, b.status]).toEqual([201, 201]);
    return [a.json.id, b.json.id] as string[];
  };

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey, Collection, Tag, FileTag, FileRecord, StorageCleanupIntent, Memory, MemoryTag]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    root = await mkdtemp(path.join(tmpdir(), 'seshat-wscleanup-'));
    storage = new FlakyStorage(await LocalVolumeFileStorage.open(root));
    for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test', MAX_UPLOAD_BYTES: '1024' })) vi.stubEnv(k, v);
    @Module({
      imports: [ConfigModule, EventEmitterModule.forRoot()],
      controllers: [FilesController, WorkspacesController],
      providers: [
        { provide: CLOCK, useValue: systemClock },
        AuthService,
        SessionGuard,
        { provide: APP_GUARD, useExisting: SessionGuard },
        { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
        { provide: ApiKeyStore, useValue: { findByKey: async () => null, touchLastUsed: async () => true } },
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
    cookie = `${SESSION_COOKIE_NAME}=${app.get(AuthService).issueSessionToken()}`;
    cleanup = app.get(StorageCleanupService);
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
  });

  afterAll(async () => {
    await app?.close();
    await iso?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    storage.failDelete = false;
    storage.afterPut = undefined;
    errors.length = 0;
    await ds.query('DELETE FROM storage_cleanup_intents');
    await ds.query('DELETE FROM memories');
    await ds.query('DELETE FROM file_tags');
    await ds.query('DELETE FROM files');
    await ds.query('DELETE FROM tags');
    await ds.query('DELETE FROM collections');
    await ds.query('DELETE FROM workspaces');
    for (const f of await objects()) await rm(f, { force: true });
  });

  it('deletes a populated Workspace with its files, joins, Collections, tags and originals, leaving Global and others intact', async () => {
    const doomed = await addWorkspace('doomed');
    const other = await addWorkspace('other');
    await populate(doomed);
    await populate(other);
    await upload('/api/global/files', 'g.txt', [{ name: 'tags', value: 'one' }]);
    await collection(null, 'global-col');
    await ds.query(`INSERT INTO api_keys (workspace_id, name, prefix, key_hash, permissions) SELECT $1, 'k', 'pfx12345', 'h', '[]' FROM (SELECT 1) s`, [doomed]).catch(() => undefined);
    expect((await objects()).length).toBe(5);

    const res = await del(doomed);
    expect(res.status).toBe(204);
    await vi.waitFor(async () => expect(await intents()).toEqual([]));

    for (const t of ['files', 'collections', 'tags', 'file_tags']) {
      expect(await count(t, `${t === 'file_tags' ? 'scope_key' : 'workspace_id::text'} = $1`, [doomed]), t).toBe(0);
    }
    expect(await count('workspaces', 'id = $1', [doomed])).toBe(0);
    expect(await count('api_keys', 'workspace_id = $1', [doomed])).toBe(0);
    // 2 objects of "other" + 1 global remain
    expect((await objects()).length).toBe(3);
    expect(await count('files', 'workspace_id = $1', [other])).toBe(2);
    expect(await count('files', `scope = 'global'`)).toBe(1);
    expect(await count('collections', `workspace_id = $1`, [other])).toBe(1);
    expect(await count('collections', `scope = 'global'`)).toBe(1);
    expect(await count('tags', `workspace_id = $1`, [other])).toBe(2);
    expect(await count('tags', `scope = 'global'`)).toBe(1);
    expect(await count('file_tags', 'scope_key = $1', [other])).toBe(2);
  });

  const addMemory = async (ws: string | null, content: string, extra: { supersededBy?: string } = {}) => {
    const id = ((await ds.query(
      `INSERT INTO memories (scope, workspace_id, type, content, created_by_kind, content_hash) VALUES ($1, $2, 'fact', $3, 'admin', $4) RETURNING id`,
      [ws ? 'workspace' : 'global', ws, content, createHash('sha256').update(`${ws}${content}`).digest('hex')],
    )) as { id: string }[])[0]!.id;
    if (extra.supersededBy) await ds.query(`UPDATE memories SET status = 'superseded', superseded_by = $2 WHERE id = $1`, [id, extra.supersededBy]);
    return id;
  };
  const tagMemory = async (memoryId: string, ws: string | null, name: string) => {
    const key = ws ?? 'global';
    const tag = ((await ds.query(
      `INSERT INTO tags (scope, workspace_id, name) VALUES ($1, $2, $3) ON CONFLICT (scope_key, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [ws ? 'workspace' : 'global', ws, name],
    )) as { id: string }[])[0]!.id;
    await ds.query('INSERT INTO memory_tags (memory_id, tag_id, scope_key) VALUES ($1, $2, $3)', [memoryId, tag, key]);
  };

  it('deleting a Workspace removes its Memories and tag joins together with files; other scopes and file cleanup survive', async () => {
    const doomed = await addWorkspace('doomed-memories');
    const other = await addWorkspace('other-memories');
    await populate(doomed);
    await populate(other);
    const newer = await addMemory(doomed, 'newer');
    await addMemory(doomed, 'older', { supersededBy: newer });
    await tagMemory(newer, doomed, 'shared');
    const otherMemory = await addMemory(other, 'keep me');
    await tagMemory(otherMemory, other, 'shared');
    const globalMemory = await addMemory(null, 'global keep');
    await tagMemory(globalMemory, null, 'shared');
    expect((await objects()).length).toBe(4);

    expect((await del(doomed)).status).toBe(204);
    await vi.waitFor(async () => expect(await intents()).toEqual([]));

    expect(await count('memories', 'workspace_id = $1', [doomed])).toBe(0);
    expect(await count('memory_tags', 'scope_key = $1', [doomed])).toBe(0);
    expect(await count('tags', 'workspace_id = $1', [doomed])).toBe(0);
    expect(await count('files', 'workspace_id = $1', [doomed])).toBe(0);
    expect((await objects()).length).toBe(2); // only the originals of "other"
    expect(await count('memories', 'workspace_id = $1', [other])).toBe(1);
    expect(await count('memory_tags', 'scope_key = $1', [other])).toBe(1);
    expect(await count('memories', "scope = 'global'")).toBe(1);
    expect(await count('memory_tags', "scope_key = 'global'")).toBe(1);
    expect(await count('files', 'workspace_id = $1', [other])).toBe(2);
  });

  it('a failing Memory cleanup rolls the whole Workspace delete back, files and ledger included', async () => {
    const ws = await addWorkspace('rollback-memories');
    await populate(ws);
    const m = await addMemory(ws, 'stays');
    await ds.query(`CREATE OR REPLACE FUNCTION fn_test_block_memory_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'blocked'; END $$`);
    await ds.query('CREATE TRIGGER tr_test_block_memory_delete BEFORE DELETE ON memories FOR EACH ROW EXECUTE FUNCTION fn_test_block_memory_delete()');
    try {
      expect((await del(ws)).status).toBeGreaterThanOrEqual(500);
    } finally {
      await ds.query('DROP TRIGGER tr_test_block_memory_delete ON memories');
      await ds.query('DROP FUNCTION fn_test_block_memory_delete()');
    }
    expect(await count('memories', 'id = $1', [m])).toBe(1);
    expect(await count('files', 'workspace_id = $1', [ws])).toBe(2);
    expect(await count('workspaces', 'id = $1', [ws])).toBe(1);
    expect(await intents()).toEqual([]);
    expect((await objects()).length).toBe(2);
  });

  const embedChunks = async (fileId: string, scope: 'global' | 'workspace', workspaceId: string | null, n = 2) => {
    for (let i = 0; i < n; i++) {
      const content = `chunk ${i}`;
      const embedding = `[${Array.from({ length: 1536 }, (_, d) => (d === i ? 1 : 0)).join(',')}]`;
      await ds.query(
        `INSERT INTO chunks (scope, workspace_id, file_id, ordinal, content, location, char_count, content_hash, embedding, embedding_model)
         VALUES ($1, $2, $3, $4, $5, '{"startOffset":0,"endOffset":7,"startLine":1,"endLine":1}', $6, repeat('a', 64), $7::vector, 'fake')`,
        [scope, workspaceId, fileId, i, content, content.length, embedding],
      );
    }
  };

  it('deleting a file through the API removes its chunks and vectors only', async () => {
    const ws = await addWorkspace('chunked');
    const [a, b] = await populate(ws);
    await embedChunks(a!, 'workspace', ws);
    await embedChunks(b!, 'workspace', ws);
    const res = await fetch(`${base}${wsFiles(ws)}/${a}`, { method: 'DELETE', headers: { cookie } });
    expect(res.status).toBe(204);
    expect(await count('chunks', 'file_id = $1', [a])).toBe(0);
    expect(await count('chunks', 'file_id = $1', [b])).toBe(2);
  });

  it('deleting a Workspace through the API leaves no chunks or vectors, and other scopes keep theirs', async () => {
    const doomed = await addWorkspace('doomed-chunks');
    const other = await addWorkspace('other-chunks');
    for (const f of await populate(doomed)) await embedChunks(f, 'workspace', doomed);
    for (const f of await populate(other)) await embedChunks(f, 'workspace', other);
    const g = (await upload('/api/global/files', 'g.txt')).json.id as string;
    await embedChunks(g, 'global', null);
    expect(await count('chunks')).toBe(10);

    expect((await del(doomed)).status).toBe(204);
    expect(await count('chunks', 'workspace_id = $1', [doomed])).toBe(0);
    expect(await count('chunks', 'file_id IN (SELECT id FROM files WHERE workspace_id = $1)', [doomed])).toBe(0);
    expect(await count('chunks')).toBe(6);
    expect(await count('chunks', 'workspace_id = $1', [other])).toBe(4);
    expect(await count('chunks', "scope = 'global'")).toBe(2);
  });

  it('keeps the generic missing response and the slug confirmation', async () => {
    const ws = await addWorkspace('keepme');
    await populate(ws);
    expect((await del(ws, 'wrong')).status).toBe(400);
    expect(await count('files', 'workspace_id = $1', [ws])).toBe(2);
    expect((await objects()).length).toBe(2);
    expect(await intents()).toEqual([]);
    expect((await del(randomUUID(), 'x')).status).toBe(404);
  });

  it('rolls back everything (rows, intents, objects) when the transaction fails, then succeeds on retry', async () => {
    const ws = await addWorkspace('rollback');
    await populate(ws);
    const spy = vi.spyOn(WorkspaceDataCleanup.prototype, 'deleteWorkspaceData').mockImplementationOnce(async (manager) => {
      await manager.query(`DELETE FROM "file_tags" WHERE "scope_key" = $1`, [ws]);
      throw new Error('boom');
    });
    expect((await del(ws)).status).toBe(500);
    spy.mockRestore();
    expect(await count('workspaces', 'id = $1', [ws])).toBe(1);
    expect(await count('files', 'workspace_id = $1', [ws])).toBe(2);
    expect(await count('file_tags', 'scope_key = $1', [ws])).toBe(2);
    expect(await intents()).toEqual([]);
    expect((await objects()).length).toBe(2);
    expect((await del(ws)).status).toBe(204);
    await vi.waitFor(async () => expect((await objects()).length).toBe(0));
  });

  it('captures keys durably, logs failed removals by id only, retries after restart, tolerates missing objects and duplicate events', async () => {
    const ws = await addWorkspace('flaky');
    const [f1] = await populate(ws);
    const keys = ((await ds.query('SELECT storage_key FROM files WHERE workspace_id = $1', [ws])) as { storage_key: string }[]).map((r) => r.storage_key);
    storage.failDelete = true;
    expect((await del(ws)).status).toBe(204);
    await vi.waitFor(async () => expect((await intents()).every((i) => i.attempts === 1)).toBe(true));
    expect((await intents()).length).toBe(2);
    expect((await intents())[0]!.scope_key).toBe(ws);
    expect(await count('files', 'workspace_id = $1', [ws])).toBe(0);
    expect((await objects()).length).toBe(2);
    expect(errors.some((e) => e.includes('intent'))).toBe(true);
    for (const e of errors) for (const k of keys) expect(e).not.toContain(k);
    expect(errors.join('\n')).not.toMatch(/secret|\/tmp|seshat-wscleanup/);

    // One object disappears meanwhile; storage recovers; "restart" = a fresh service instance.
    await rm(path.join(root, ...keys[0]!.split('/')), { force: true });
    storage.failDelete = false;
    await makeDue();
    const restarted = new StorageCleanupService(ds, storage);
    restarted.onApplicationBootstrap();
    const events = app.get(EventEmitter2);
    await Promise.all([events.emitAsync('workspace.deleted', { id: ws }), events.emitAsync('workspace.deleted', { id: ws }), restarted.drain()]);
    await vi.waitFor(async () => expect(await intents()).toEqual([]));
    restarted.onApplicationShutdown();
    expect((await objects()).length).toBe(0);
    // Repeated events after everything is gone, and for an unknown Workspace, are harmless.
    await events.emitAsync('workspace.deleted', { id: ws });
    await events.emitAsync('workspace.deleted', { id: randomUUID() });
    expect(f1).toBeTruthy();
  });

  it('does not orphan originals when an upload races Workspace deletion', async () => {
    const ws = await addWorkspace('race');
    const keep = await addWorkspace('bystander');
    await populate(ws);
    // Hold an upload between "object stored" and "row inserted" while the Workspace is deleted.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let stored!: () => void;
    const hasStored = new Promise<void>((r) => (stored = r));
    storage.afterPut = async () => {
      stored();
      await gate;
    };
    const racing = upload(wsFiles(ws), 'late.txt');
    await hasStored;
    storage.afterPut = undefined;
    expect((await del(ws)).status).toBe(204);
    release();
    const late = await racing;
    expect(late.status).toBe(404); // Workspace removed meanwhile: same as missing
    await vi.waitFor(async () => expect(await intents()).toEqual([]));
    expect(await count('files', 'workspace_id = $1', [ws])).toBe(0);
    expect(await count('files', 'workspace_id IS NOT NULL AND workspace_id NOT IN (SELECT id FROM workspaces)')).toBe(0);
    expect(await objects()).toEqual([]);
    expect(await count('workspaces', 'id = $1', [keep])).toBe(1);
  });

  it('captures an upload that commits while the delete is in flight, concurrently with many uploads', async () => {
    for (let round = 0; round < 3; round++) {
      const ws = await addWorkspace(`conc-${round}`);
      await populate(ws);
      const uploads = Array.from({ length: 6 }, (_, i) => upload(wsFiles(ws), `n${i}.txt`));
      const deletion = del(ws);
      const [d, ...ups] = await Promise.all([deletion, ...uploads]);
      expect(d.status).toBe(204);
      for (const u of ups) expect([201, 404]).toContain(u.status);
      await vi.waitFor(async () => expect(await intents()).toEqual([]));
      expect(await count('files', 'workspace_id = $1', [ws])).toBe(0);
      expect(await count('tags', 'workspace_id = $1', [ws])).toBe(0);
      expect(await objects()).toEqual([]);
    }
  });

  it('still refuses (409) to delete a Workspace that has other restricting data, and rolls everything back', async () => {
    const ws = await addWorkspace('restricted');
    await populate(ws);
    await ds.query('CREATE TABLE unrelated_restricting (id serial PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT)');
    await ds.query('INSERT INTO unrelated_restricting (workspace_id) VALUES ($1)', [ws]);
    expect((await del(ws)).status).toBe(409);
    await ds.query('DROP TABLE unrelated_restricting');
    expect(await count('files', 'workspace_id = $1', [ws])).toBe(2);
    expect(await intents()).toEqual([]);
    expect((await objects()).length).toBe(2);
  });
});
