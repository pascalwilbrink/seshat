import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Client } from 'pg';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { FILE_UPLOADED_EVENT } from '../src/files/file.events.js';
import { FakeEmbeddingService } from '../src/ingestion/fake-embedding.service.js';
import { FileIngestorProvider, provideFileIngestors } from '../src/ingestion/file-ingestor.provider.js';
import { IngestionProcessor } from '../src/ingestion/ingestion.processor.js';
import { IngestionWorker } from '../src/ingestion/ingestion.worker.js';
import { PlainTextIngestor } from '../src/ingestion/plain-text.ingestor.js';
import { EmbeddingError } from '../src/ingestion/embedding.service.js';
import { INGEST_FILE_QUEUE } from '../src/queue/queue.constants.js';
import { QueueService } from '../src/queue/queue.service.js';
import { LocalVolumeFileStorage } from '../src/storage/local-volume-file-storage.js';
import { originalObjectKey, StorageObjectNotFoundError, type FileStorage } from '../src/storage/file-storage.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

const SENTINEL = 'SENTINEL_CONTENT_9f3a';
const KEY_SENTINEL = 'sk-SENTINEL-KEY-1234';

/** Embedding fake with failure injection and a gate to pause "provider" work. */
class ControlledEmbeddings extends FakeEmbeddingService {
  failTimes = 0;
  attempts = 0;
  failAlways = false;
  gate: Promise<void> | undefined;
  entered: (() => void) | undefined;
  override async embed(texts: string[]): Promise<number[][]> {
    this.attempts++;
    this.entered?.();
    if (this.gate) await this.gate;
    if (this.failAlways || this.failTimes-- > 0) {
      // The "provider" error text carries secrets; it must never be stored or logged.
      throw Object.assign(new EmbeddingError('provider_failed', `request failed ${KEY_SENTINEL} ${texts[0]}`), { cause: KEY_SENTINEL });
    }
    return super.embed(texts);
  }
}

describeIntegration('ingestion worker (real PostgreSQL + pg-boss)', () => {
  vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });
  let iso: IsolatedSchema;
  let ds: DataSource;
  let dir: string;
  let storage: LocalVolumeFileStorage;
  let boss: Client;
  let bossSchema: string;
  let queues: QueueService[];
  let logs: string[];
  let spies: ReturnType<typeof vi.spyOn>[];

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params) as Promise<Record<string, any>[]>;
  const until = async (cond: () => Promise<boolean> | boolean, ms = 25_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('condition not met in time');
  };
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');

  async function addWorkspace(slug = `w${randomUUID().slice(0, 6)}`): Promise<string> {
    return (await q(`INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id`, [slug]))[0]!.id;
  }
  async function addFile(opts: { name?: string; bytes?: Buffer | string; workspaceId?: string | null; store?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    const workspaceId = opts.workspaceId ?? null;
    const scope = workspaceId ? ({ kind: 'workspace', workspaceId } as const) : ({ kind: 'global' } as const);
    const key = originalObjectKey(scope, id);
    const bytes = Buffer.from(opts.bytes ?? '# Title\n\nhello world\n');
    if (opts.store !== false) await storage.put(key, Readable.from([bytes]));
    const name = opts.name ?? 'doc.md';
    await q(
      `INSERT INTO files (id, scope, workspace_id, name, extension, mime_type, size_bytes, sha256, storage_key)
       VALUES ($1, $2, $3, $4, $5, 'text/plain', $6, $7, $8)`,
      [id, workspaceId ? 'workspace' : 'global', workspaceId, name, name.includes('.') ? name.split('.').pop()!.toLowerCase() : null, bytes.length, sha(String(id)), key],
    );
    return id;
  }
  const file = async (id: string) => (await q(`SELECT ingestion_status, ingestion_error, indexed_at, chunk_count FROM files WHERE id = $1`, [id]))[0];
  const chunks = (id: string) => q(`SELECT id, ordinal, content, content_hash, location, embedding::text AS embedding, embedding_model FROM chunks WHERE file_id = $1 ORDER BY ordinal`, [id]);
  const jobs = async (id: string) => (await boss.query(`SELECT state, retry_count, output FROM "${bossSchema}".job WHERE name = $1 AND singleton_key = $2 ORDER BY created_on`, [INGEST_FILE_QUEUE, id])).rows;
  const allText = () => logs.join('\n');

  function build(embeddings: FakeEmbeddingService, store: FileStorage = storage) {
    const ingestors = new FileIngestorProvider([new PlainTextIngestor()]);
    return new IngestionProcessor(ds, store, ingestors, embeddings, { chunkSizeChars: 40, chunkOverlapChars: 5 });
  }
  async function boot(embeddings: FakeEmbeddingService) {
    const queue = new QueueService({ connectionString: TEST_DATABASE_URL!, schema: bossSchema, ingestionConcurrency: 2, retryDelaySeconds: 1, pollingIntervalSeconds: 0.5, stopTimeoutMs: 5000 });
    queues.push(queue);
    const worker = new IngestionWorker(queue, build(embeddings));
    await worker.onModuleInit();
    await queue.onApplicationBootstrap();
    const emitter = new EventEmitter2();
    emitter.on(FILE_UPLOADED_EVENT, (e) => worker.onFileUploaded(e));
    return { queue, worker, emitter };
  }
  const ctx = (fileId: string, attempt = 1) => ({ fileId, attempt, maxAttempts: 3, isFinalAttempt: attempt >= 3 });

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource();
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    dir = await mkdtemp(path.join(tmpdir(), 'seshat-ingest-'));
    storage = await LocalVolumeFileStorage.open(dir);
  });
  afterAll(async () => {
    await iso?.dispose();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await q('DELETE FROM files');
    await q('DELETE FROM workspaces');
    bossSchema = `pgboss_t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    boss = new Client({ connectionString: TEST_DATABASE_URL });
    await boss.connect();
    queues = [];
    logs = [];
    const capture = (...a: unknown[]) => void logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) => vi.spyOn(Logger.prototype, m).mockImplementation(capture));
  });
  afterEach(async () => {
    for (const s of spies) s.mockRestore();
    for (const queue of queues) await queue.beforeApplicationShutdown().catch(() => undefined);
    await boss.query(`DROP SCHEMA IF EXISTS "${bossSchema}" CASCADE`).catch(() => undefined);
    await boss.end();
  });

  it('a committed file.uploaded event enqueues exactly one job and the registered worker indexes the file', async () => {
    const emb = new ControlledEmbeddings();
    let release!: () => void;
    emb.gate = new Promise((r) => (release = r));
    const entered = new Promise<void>((r) => (emb.entered = r));
    const { emitter } = await boot(emb);
    const id = await addFile({ bytes: `# A\n\n${SENTINEL} line one\n\n# B\n\nsecond section text here\n` });
    expect((await file(id))!.ingestion_status).toBe('pending');
    await emitter.emitAsync(FILE_UPLOADED_EVENT, { id, scope: { kind: 'global' } });
    await emitter.emitAsync(FILE_UPLOADED_EVENT, { id, scope: { kind: 'global' } });
    await entered;
    expect((await file(id))!.ingestion_status).toBe('processing');
    expect(await jobs(id)).toHaveLength(1);
    release();
    await until(async () => (await file(id))!.ingestion_status === 'indexed');
    const f = (await file(id))!;
    const rows = await chunks(id);
    expect(f.chunk_count).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(1);
    expect(f.indexed_at).not.toBeNull();
    expect(f.ingestion_error).toBeNull();
    expect(rows.map((r) => r.ordinal)).toEqual(rows.map((_, i) => i));
    expect(rows.some((r) => r.location.section === 'B')).toBe(true);
    await until(async () => (await jobs(id))[0]?.state === 'completed');
    expect(await jobs(id)).toHaveLength(1);
  });

  it('recovers from transient provider errors within three attempts', async () => {
    const emb = new ControlledEmbeddings();
    emb.failTimes = 2;
    const { emitter } = await boot(emb);
    const id = await addFile();
    await emitter.emitAsync(FILE_UPLOADED_EVENT, { id, scope: { kind: 'global' } });
    await until(async () => (await file(id))!.ingestion_status === 'indexed');
    expect(emb.attempts).toBe(3);
    expect((await file(id))!.ingestion_error).toBeNull();
    const job = (await jobs(id))[0];
    expect(job.retry_count).toBe(2);
  });

  it('exhausts after three attempts with a safe allowlisted error and sanitized pg-boss metadata', async () => {
    const emb = new ControlledEmbeddings();
    emb.failAlways = true;
    const { emitter } = await boot(emb);
    const id = await addFile({ bytes: `${SENTINEL} body` });
    await emitter.emitAsync(FILE_UPLOADED_EVENT, { id, scope: { kind: 'global' } });
    await until(async () => (await jobs(id))[0]?.state === 'failed');
    const f = (await file(id))!;
    expect(f.ingestion_status).toBe('failed');
    expect(f.ingestion_error).toBe('Embedding provider request failed');
    expect(emb.attempts).toBe(3);
    const output = JSON.stringify((await jobs(id))[0].output);
    for (const text of [output, f.ingestion_error, allText()]) {
      expect(text).not.toContain(KEY_SENTINEL);
      expect(text).not.toContain(SENTINEL);
    }
    expect(output).toContain('provider_failed');
  });

  it('shows pending between retries (observable state) and never failed before the last attempt', async () => {
    const emb = new ControlledEmbeddings();
    emb.failTimes = 1;
    const p = build(emb);
    const id = await addFile();
    await expect(p.process(ctx(id, 1))).rejects.toMatchObject({ code: 'provider_failed' });
    expect((await file(id))!.ingestion_status).toBe('pending');
    await p.process(ctx(id, 2));
    expect((await file(id))!.ingestion_status).toBe('indexed');
  });

  it('fails unsupported types and invalid UTF-8 permanently, without retry', async () => {
    const emb = new ControlledEmbeddings();
    const { emitter } = await boot(emb);
    const unsupported = await addFile({ name: 'data.xyz', bytes: SENTINEL });
    const invalid = await addFile({ name: 'bad.txt', bytes: Buffer.from([0x66, 0xff, 0xfe, 0x6f]) });
    for (const id of [unsupported, invalid]) await emitter.emitAsync(FILE_UPLOADED_EVENT, { id, scope: { kind: 'global' } });
    for (const id of [unsupported, invalid]) await until(async () => (await jobs(id))[0]?.state === 'completed');
    expect(await file(unsupported)).toMatchObject({ ingestion_status: 'failed', ingestion_error: 'No ingestor for .xyz' });
    expect(await file(invalid)).toMatchObject({ ingestion_status: 'failed', ingestion_error: 'File is not valid UTF-8 text' });
    expect(emb.calls).toHaveLength(0);
    for (const id of [unsupported, invalid]) {
      expect((await jobs(id))[0].retry_count).toBe(0);
      expect(await chunks(id)).toHaveLength(0);
    }
    expect(allText()).not.toContain(SENTINEL);
  });

  it('empty files succeed with zero chunks and clear previous chunks and errors', async () => {
    const emb = new ControlledEmbeddings();
    const p = build(emb);
    const id = await addFile({ bytes: 'some previous content that is long enough to chunk twice over' });
    await p.process(ctx(id));
    expect((await chunks(id)).length).toBeGreaterThan(0);
    await q(`UPDATE files SET ingestion_status = 'failed', ingestion_error = 'old error' WHERE id = $1`, [id]);
    await storage.put(originalObjectKey({ kind: 'global' }, id), Readable.from([Buffer.alloc(0)]));
    const calls = emb.calls.length;
    await p.process(ctx(id));
    expect(await chunks(id)).toHaveLength(0);
    expect(await file(id)).toMatchObject({ ingestion_status: 'indexed', chunk_count: 0, ingestion_error: null });
    expect(emb.calls).toHaveLength(calls);
  });

  it('rolls the replacement back as a whole when the insert fails', async () => {
    const good = new ControlledEmbeddings();
    const id = await addFile({ bytes: 'first generation content, long enough for several chunks of forty' });
    await build(good).process(ctx(id));
    const before = await chunks(id);
    const metaBefore = await file(id);
    const bad = new ControlledEmbeddings(1536, 'm'.repeat(300)); // violates CK_chunks_embedding_model_length at insert
    await expect(build(bad).process(ctx(id))).rejects.toMatchObject({ code: 'job_failed' });
    expect(await chunks(id)).toEqual(before);
    expect((await file(id))!.indexed_at).toEqual(metaBefore!.indexed_at);
    expect((await file(id))!.ingestion_status).toBe('pending');
  });

  it('repeated and concurrent runs yield identical logical chunks without duplicates', async () => {
    const id = await addFile({ bytes: '# T\n\nalpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi\n' });
    await build(new ControlledEmbeddings()).process(ctx(id));
    const first = await chunks(id);
    await Promise.all([build(new ControlledEmbeddings()).process(ctx(id)), build(new ControlledEmbeddings()).process(ctx(id)), build(new ControlledEmbeddings()).process(ctx(id))]);
    const again = await chunks(id);
    expect(again).toEqual(first);
    expect(first.length).toBeGreaterThan(1);
    expect(new Set(again.map((r) => r.ordinal)).size).toBe(again.length);
    expect((await file(id))!.chunk_count).toBe(first.length);
  });

  it('ends quietly when the file is deleted before, during embedding, or during reading', async () => {
    // before
    const gone = randomUUID();
    await expect(build(new ControlledEmbeddings()).process(ctx(gone))).resolves.toBeUndefined();
    // during embedding
    const emb = new ControlledEmbeddings();
    let release!: () => void;
    emb.gate = new Promise((r) => (release = r));
    const entered = new Promise<void>((r) => (emb.entered = r));
    const id = await addFile();
    const run = build(emb).process(ctx(id));
    await entered;
    await q('DELETE FROM files WHERE id = $1', [id]);
    release();
    await expect(run).resolves.toBeUndefined();
    expect(await file(id)).toBeUndefined();
    expect(await chunks(id)).toHaveLength(0);
    // during reading: the row disappears and the object is gone
    const id2 = await addFile();
    const racing: FileStorage = {
      put: (k, s) => storage.put(k, s),
      exists: (k) => storage.exists(k),
      delete: (k) => storage.delete(k),
      get: async () => {
        await q('DELETE FROM files WHERE id = $1', [id2]);
        throw new StorageObjectNotFoundError();
      },
    };
    await expect(build(new ControlledEmbeddings(), racing).process(ctx(id2, 3))).resolves.toBeUndefined();
    expect(await file(id2)).toBeUndefined();
    expect(await q('SELECT 1 FROM chunks')).toHaveLength(0);
  });

  it('a missing original of an existing file is a permanent safe failure', async () => {
    const id = await addFile({ store: false });
    await build(new ControlledEmbeddings()).process(ctx(id));
    expect(await file(id)).toMatchObject({ ingestion_status: 'failed', ingestion_error: 'Original file is missing from storage' });
  });

  it('Workspace deletion during embedding recreates nothing', async () => {
    const ws = await addWorkspace();
    const id = await addFile({ workspaceId: ws });
    const emb = new ControlledEmbeddings();
    let release!: () => void;
    emb.gate = new Promise((r) => (release = r));
    const entered = new Promise<void>((r) => (emb.entered = r));
    const run = build(emb).process(ctx(id));
    await entered;
    await ds.transaction(async (m) => {
      await m.query('DELETE FROM files WHERE workspace_id = $1', [ws]);
      await m.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    });
    release();
    await expect(run).resolves.toBeUndefined();
    expect(await q('SELECT 1 FROM files')).toHaveLength(0);
    expect(await q('SELECT 1 FROM chunks')).toHaveLength(0);
  });

  it('deleting an indexed file or Workspace cascades to chunks', async () => {
    const ws = await addWorkspace();
    const a = await addFile({ workspaceId: ws });
    const b = await addFile();
    for (const id of [a, b]) await build(new ControlledEmbeddings()).process(ctx(id));
    expect((await chunks(a)).length).toBeGreaterThan(0);
    await q('DELETE FROM files WHERE id = $1', [b]);
    expect(await chunks(b)).toHaveLength(0);
    await q('DELETE FROM files WHERE workspace_id = $1', [ws]);
    expect(await q('SELECT 1 FROM chunks')).toHaveLength(0);
  });

  it('never logs or stores content, vectors, keys or raw provider text', async () => {
    const emb = new ControlledEmbeddings();
    emb.failTimes = 1;
    const id = await addFile({ bytes: `# ${SENTINEL}\n\n${SENTINEL} body` });
    const p = build(emb);
    await p.process(ctx(id, 1)).catch(() => undefined);
    await p.process(ctx(id, 2));
    emb.failAlways = true;
    await p.process(ctx(id, 3)).catch(() => undefined);
    const vectorSentinel = String(emb.vectorFor(`# ${SENTINEL}`)[0]);
    const f = (await file(id))!;
    for (const text of [allText(), String(f.ingestion_error ?? '')]) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(KEY_SENTINEL);
      expect(text).not.toContain(vectorSentinel);
    }
    expect(allText()).toContain(id);
  });
});
