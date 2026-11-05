import { createHash, randomUUID } from 'node:crypto';
import { ForbiddenException, NotFoundException, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import type { Permission } from '@seshat/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { AuthorizationService } from '../src/auth/authorization.service.js';
import { ADMIN_PRINCIPAL, type Principal } from '../src/auth/principal.js';
import { FilesService } from '../src/files/files.service.js';
import { ChunksService } from '../src/ingestion/chunks.service.js';
import { REINDEX_BATCH_SIZE, ReindexService } from '../src/ingestion/reindex.service.js';
import { QueueUnavailableError, type EnqueueResult, type QueueService } from '../src/queue/index.js';
import { globalScope, workspaceScope } from '../src/scopes/scope-ref.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

const DIM = 1536;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const vec = (seed: number) => `[${Array.from({ length: DIM }, (_, i) => (i === seed % DIM ? 1 : 0)).join(',')}]`;

describeIntegration('re-index and chunk preview services (real PostgreSQL + pgvector)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let wsA: string;
  let wsB: string;
  let reindex: ReindexService;
  let chunks: ChunksService;
  const enqueued: string[] = [];
  const queueState: { fail: (n: number) => boolean; result: EnqueueResult } = { fail: () => false, result: 'queued' };
  const queue = {
    enqueue: async (id: string): Promise<EnqueueResult> => {
      if (queueState.fail(enqueued.length)) throw new QueueUnavailableError('enqueue_failed');
      enqueued.push(id);
      return queueState.result;
    },
  } as unknown as QueueService;

  const key = (workspaceId: string, permissions: Permission[]): Principal => ({ kind: 'apiKey', keyId: 'k', workspaceId, permissions });
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params) as Promise<Record<string, any>[]>;
  const addFile = async (ws: string | null, status = 'indexed', error: string | null = null) =>
    (await q(
      `INSERT INTO files (scope, workspace_id, name, extension, mime_type, size_bytes, sha256, storage_key, ingestion_status, ingestion_error)
       VALUES ($1, $2, 'f.md', 'md', 'text/markdown', 1, $3, $4, $5, $6) RETURNING id`,
      [ws ? 'workspace' : 'global', ws, sha('x'), `k/${randomUUID()}`, status, error],
    ))[0]!.id as string;
  const addChunk = (fileId: string, ws: string | null, ordinal: number) =>
    q(
      `INSERT INTO chunks (scope, workspace_id, file_id, ordinal, content, location, char_count, content_hash, embedding, embedding_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, 'fake-model')`,
      [
        ws ? 'workspace' : 'global', ws, fileId, ordinal, `chunk ${ordinal}`,
        JSON.stringify({ section: 'S', headingPath: ['S'], startOffset: ordinal * 10, endOffset: ordinal * 10 + 7, startLine: ordinal + 1, endLine: ordinal + 1, junk: 'x' }),
        `chunk ${ordinal}`.length, sha(`chunk ${ordinal}`), vec(ordinal),
      ],
    );
  const statusOf = async (id: string) => (await q('SELECT ingestion_status s, ingestion_error e FROM files WHERE id = $1', [id]))[0]!;
  const denied = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as Error | null;

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource();
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    const authorization = new AuthorizationService();
    const files = new FilesService(ds, authorization, undefined as never, undefined as never, undefined as never, undefined as never, undefined as never, undefined as never);
    reindex = new ReindexService(ds, authorization, queue, files);
    chunks = new ChunksService(ds, authorization);
  });
  afterAll(async () => {
    await iso?.dispose();
  });
  beforeEach(async () => {
    await q('DELETE FROM files');
    await q('DELETE FROM workspaces');
    wsA = (await q(`INSERT INTO workspaces (name, slug) VALUES ('a', 'a') RETURNING id`))[0]!.id;
    wsB = (await q(`INSERT INTO workspaces (name, slug) VALUES ('b', 'b') RETURNING id`))[0]!.id;
    enqueued.length = 0;
    queueState.fail = () => false;
    queueState.result = 'queued';
  });

  describe('single-file re-index', () => {
    it('sets a failed file pending, clears the error, queues it once and returns safe metadata', async () => {
      const id = await addFile(wsA, 'failed', 'Ingestion failed');
      const dto = await reindex.reindexFile(key(wsA, ['files:write']), workspaceScope(wsA), id);
      expect(enqueued).toEqual([id]);
      expect(dto).toMatchObject({ id, ingestionStatus: 'pending', ingestionError: null, chunkCount: 0, indexedAt: null });
      expect(await statusOf(id)).toEqual({ s: 'pending', e: null });
      expect(JSON.stringify(dto)).not.toMatch(/storage|k\//);
    });

    it('allows the admin in Global, but no key (not even with every permission) writes to Global', async () => {
      const g = await addFile(null, 'failed', 'Ingestion failed');
      await reindex.reindexFile(ADMIN_PRINCIPAL, globalScope(), g);
      expect(enqueued).toEqual([g]);
      enqueued.length = 0;
      const all = key(wsA, ['files:read', 'files:write', 'files:delete', 'global:read', 'collections:read', 'collections:write', 'memories:read', 'memories:write', 'memories:delete', 'search']);
      expect(await denied(reindex.reindexFile(all, globalScope(), g))).toBeInstanceOf(ForbiddenException);
      expect(enqueued).toEqual([]);
    });

    it('needs files:write in the own Workspace and gives other Workspaces, missing and malformed ids the same 404', async () => {
      const a = await addFile(wsA, 'failed', 'Ingestion failed');
      const b = await addFile(wsB, 'failed', 'Ingestion failed');
      expect(await denied(reindex.reindexFile(key(wsA, ['files:read', 'files:delete']), workspaceScope(wsA), a))).toBeInstanceOf(ForbiddenException);
      const missing = await denied(reindex.reindexFile(key(wsA, ['files:write']), workspaceScope(wsA), randomUUID()));
      const foreign = await denied(reindex.reindexFile(key(wsA, ['files:write']), workspaceScope(wsA), b));
      const other = await denied(reindex.reindexFile(key(wsA, ['files:write']), workspaceScope(wsB), b));
      const malformed = await denied(reindex.reindexFile(key(wsA, ['files:write']), workspaceScope(wsA), 'not-a-uuid'));
      for (const e of [missing, foreign, other, malformed]) {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(new NotFoundException('Not Found').getResponse());
      }
      expect(enqueued).toEqual([]);
      expect((await statusOf(b)).s).toBe('failed');
    });

    it('leaves a processing file alone: the active job covers it, so a failing job cannot strand a pending file', async () => {
      const id = await addFile(wsA, 'processing');
      const dto = await reindex.reindexFile(ADMIN_PRINCIPAL, workspaceScope(wsA), id);
      expect(dto.ingestionStatus).toBe('processing');
      expect(enqueued).toEqual([]);
    });

    it('tolerates repeat requests: pending stays pending with exactly one waiting job, and a stranded pending file is recovered', async () => {
      const id = await addFile(wsA, 'indexed');
      await reindex.reindexFile(ADMIN_PRINCIPAL, workspaceScope(wsA), id);
      queueState.result = 'already_queued';
      const again = await reindex.reindexFile(ADMIN_PRINCIPAL, workspaceScope(wsA), id);
      expect(again.ingestionStatus).toBe('pending');
      expect(enqueued).toEqual([id, id]); // the queue itself suppresses the second job (singleton)
      // A pending file whose job was lost is queued again by simply asking again.
      queueState.result = 'queued';
      const stranded = await addFile(wsA, 'pending');
      await reindex.reindexFile(ADMIN_PRINCIPAL, workspaceScope(wsA), stranded);
      expect(enqueued.at(-1)).toBe(stranded);
    });

    it('fails with 503 and restores the previous state when the queue refuses the job', async () => {
      const id = await addFile(wsA, 'failed', 'Embedding provider request failed');
      queueState.fail = () => true;
      const err = await denied(reindex.reindexFile(key(wsA, ['files:write']), workspaceScope(wsA), id));
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(await statusOf(id)).toEqual({ s: 'failed', e: 'Embedding provider request failed' });
    });
  });

  describe('scope re-index', () => {
    it('is admin only: no key, not even with all permissions, and other Workspaces are a plain 404', async () => {
      await addFile(wsA);
      const all: Permission[] = ['files:read', 'files:write', 'files:delete', 'global:read'];
      expect(await denied(reindex.reindexScope(key(wsA, all), workspaceScope(wsA)))).toBeInstanceOf(ForbiddenException);
      expect(await denied(reindex.reindexScope(key(wsA, all), globalScope()))).toBeInstanceOf(ForbiddenException);
      expect(await denied(reindex.reindexScope(key(wsA, all), workspaceScope(wsB)))).toBeInstanceOf(NotFoundException);
      expect(await denied(reindex.reindexScope(ADMIN_PRINCIPAL, workspaceScope(randomUUID())))).toBeInstanceOf(NotFoundException);
      expect(enqueued).toEqual([]);
    });

    it('covers every file across several batches, only in the requested scope, and skips processing files', async () => {
      const total = REINDEX_BATCH_SIZE * 2 + 37;
      await q(
        `INSERT INTO files (scope, workspace_id, name, extension, mime_type, size_bytes, sha256, storage_key, ingestion_status)
         SELECT 'workspace', $1, 'f.md', 'md', 'text/markdown', 1, $2, 'a/' || g, CASE WHEN g <= 3 THEN 'processing' WHEN g % 2 = 0 THEN 'indexed' ELSE 'failed' END
         FROM generate_series(1, $3) g`,
        [wsA, sha('x'), total],
      );
      const otherWs = await addFile(wsB, 'failed');
      const global = await addFile(null, 'failed');
      const result = await reindex.reindexScope(ADMIN_PRINCIPAL, workspaceScope(wsA));
      expect(result).toEqual({ matched: total, enqueued: total - 3, alreadyQueued: 0, skippedProcessing: 3 });
      expect(new Set(enqueued).size).toBe(total - 3);
      const pending = (await q(`SELECT id FROM files WHERE workspace_id = $1 AND ingestion_status = 'pending'`, [wsA])).map((r) => r.id);
      expect([...pending].sort()).toEqual([...enqueued].sort());
      expect(enqueued).not.toContain(otherWs);
      expect(enqueued).not.toContain(global);
      expect((await statusOf(otherWs)).s).toBe('failed');
      expect((await statusOf(global)).s).toBe('failed');
      // Repeating while jobs are waiting counts them as already queued and does not move anything.
      queueState.result = 'already_queued';
      const again = await reindex.reindexScope(ADMIN_PRINCIPAL, workspaceScope(wsA));
      expect(again).toEqual({ matched: total, enqueued: 0, alreadyQueued: total - 3, skippedProcessing: 3 });
    });

    it('reindexes Global for the admin only inside Global', async () => {
      const g = await addFile(null, 'indexed');
      const a = await addFile(wsA, 'indexed');
      expect(await reindex.reindexScope(ADMIN_PRINCIPAL, globalScope())).toMatchObject({ matched: 1, enqueued: 1 });
      expect(enqueued).toEqual([g]);
      expect((await statusOf(a)).s).toBe('indexed');
    });

    it('reports failure instead of success and restores files that never got a job', async () => {
      const total = REINDEX_BATCH_SIZE + 50;
      await q(
        `INSERT INTO files (scope, workspace_id, name, extension, mime_type, size_bytes, sha256, storage_key, ingestion_status, ingestion_error)
         SELECT 'workspace', $1, 'f.md', 'md', 'text/markdown', 1, $2, 'a/' || g, 'failed', 'Ingestion failed' FROM generate_series(1, $3) g`,
        [wsA, sha('x'), total],
      );
      queueState.fail = (n) => n >= 225; // the second batch fails after 25 successful sends
      expect(await denied(reindex.reindexScope(ADMIN_PRINCIPAL, workspaceScope(wsA)))).toBeInstanceOf(ServiceUnavailableException);
      expect(enqueued).toHaveLength(225);
      const rows = await q(`SELECT id, ingestion_status s, ingestion_error e FROM files WHERE workspace_id = $1`, [wsA]);
      const queuedIds = new Set(enqueued);
      for (const r of rows) {
        if (queuedIds.has(r.id)) expect(r.s).toBe('pending');
        else expect({ s: r.s, e: r.e }).toEqual({ s: 'failed', e: 'Ingestion failed' });
      }
    });
  });

  describe('chunk previews', () => {
    it('pages chunks in ordinal order with content and location, never embeddings or storage details', async () => {
      const id = await addFile(wsA);
      for (const o of [4, 0, 6, 2, 1, 5, 3]) await addChunk(id, wsA, o);
      const reader = key(wsA, ['files:read']);
      const seen: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Awaited<ReturnType<ChunksService['list']>> = await chunks.list(reader, workspaceScope(wsA), id, cursor ? { limit: '3', cursor } : { limit: '3' });
        pages++;
        expect(page.limit).toBe(3);
        seen.push(...page.items.map((c) => c.ordinal));
        for (const c of page.items) {
          expect(Object.keys(c).sort()).toEqual(['charCount', 'content', 'fileId', 'id', 'location', 'ordinal']);
          expect(c.content).toBe(`chunk ${c.ordinal}`);
          expect(c.location).toEqual({ section: 'S', headingPath: ['S'], startOffset: c.ordinal * 10, endOffset: c.ordinal * 10 + 7, startLine: c.ordinal + 1, endLine: c.ordinal + 1 });
        }
        expect(JSON.stringify(page)).not.toMatch(/embedding|fake-model|content_hash|storage|junk/);
        cursor = page.nextCursor;
        expect(page.hasMore).toBe(cursor !== null);
      } while (cursor);
      expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(pages).toBe(3);
      expect((await chunks.list(reader, workspaceScope(wsA), id, {})).items).toHaveLength(7);
    });

    it('rejects invalid bounds with one generic 400 and an unindexed file has an empty page', async () => {
      const id = await addFile(wsA, 'pending');
      const admin = ADMIN_PRINCIPAL;
      for (const bad of [{ limit: '0' }, { limit: '101' }, { limit: '-1' }, { limit: 'abc' }, { limit: '1.5' }, { cursor: '-1' }, { cursor: 'x' }, { cursor: '99999999999' }, { cursor: '2147483648' }, { bogus: '1' }, { limit: ['1', '2'] }]) {
        const err = await denied(chunks.list(admin, workspaceScope(wsA), id, bad));
        expect(err, JSON.stringify(bad)).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).message).toBe('Invalid query');
      }
      expect(await chunks.list(admin, workspaceScope(wsA), id, { limit: '100', cursor: '2147483647' })).toMatchObject({ items: [], nextCursor: null, hasMore: false });
    });

    it('enforces files:read and the explicit Global grant, and hides foreign, ungranted and missing files identically', async () => {
      const a = await addFile(wsA);
      const b = await addFile(wsB);
      const g = await addFile(null);
      await addChunk(a, wsA, 0);
      await addChunk(b, wsB, 0);
      await addChunk(g, null, 0);
      const same = (e: Error | null) => {
        expect(e).toBeInstanceOf(NotFoundException);
        expect((e as NotFoundException).getResponse()).toEqual(new NotFoundException('Not Found').getResponse());
      };
      expect(await denied(chunks.list(key(wsA, ['files:write']), workspaceScope(wsA), a, {}))).toBeInstanceOf(ForbiddenException);
      same(await denied(chunks.list(key(wsA, ['files:read']), workspaceScope(wsA), b, {})));
      same(await denied(chunks.list(key(wsA, ['files:read']), workspaceScope(wsB), b, {})));
      same(await denied(chunks.list(key(wsA, ['files:read']), workspaceScope(wsA), randomUUID(), {})));
      same(await denied(chunks.list(key(wsA, ['files:read']), workspaceScope(wsA), 'nope', {})));
      // Global: concealed without the grant, readable with it, both for the file and for a missing id.
      same(await denied(chunks.list(key(wsA, ['files:read']), globalScope(), g, {})));
      same(await denied(chunks.list(key(wsA, ['global:read']), globalScope(), g, {})));
      expect((await chunks.list(key(wsA, ['files:read', 'global:read']), globalScope(), g, {})).items).toHaveLength(1);
      // A Workspace file addressed through Global, and the other way round, is just missing.
      same(await denied(chunks.list(ADMIN_PRINCIPAL, globalScope(), a, {})));
      same(await denied(chunks.list(ADMIN_PRINCIPAL, workspaceScope(wsA), g, {})));
    });
  });

  describe('Files DTO ingestion metadata', () => {
    it('exposes error, indexed time and chunk count consistently through loadDto', async () => {
      const id = await addFile(wsA, 'failed', 'Ingestion failed');
      await q(`UPDATE files SET chunk_count = 4, indexed_at = '2026-01-02T03:04:05Z' WHERE id = $1`, [id]);
      const files = new FilesService(ds, new AuthorizationService(), undefined as never, undefined as never, undefined as never, undefined as never, undefined as never, undefined as never);
      expect(await files.loadDto(workspaceScope(wsA), id)).toMatchObject({ ingestionStatus: 'failed', ingestionError: 'Ingestion failed', chunkCount: 4, indexedAt: '2026-01-02T03:04:05.000Z' });
    });
  });
});
