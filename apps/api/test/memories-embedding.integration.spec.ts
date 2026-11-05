import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { Client } from 'pg';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationService } from '../src/auth/authorization.service.js';
import { ADMIN_PRINCIPAL, type Principal } from '../src/auth/principal.js';
import { assertEmbeddingDimension, EmbeddingDimensionError } from '../src/database/embedding-dimension-guard.js';
import { EmbeddingError, type EmbeddingService } from '../src/ingestion/embedding.service.js';
import { FakeEmbeddingService } from '../src/ingestion/fake-embedding.service.js';
import { MemoriesService } from '../src/memories/memories.service.js';
import { Memory } from '../src/memories/memory.entity.js';
import { MemoryTag } from '../src/memories/memory-tag.entity.js';
import { MemoryEmbeddingCoordinator, memoryEmbeddingText } from '../src/memories/memory-embedding.coordinator.js';
import { MemoryEmbeddingWorker } from '../src/memories/memory-embedding.worker.js';
import { EMBED_MEMORY_QUEUE } from '../src/queue/queue.constants.js';
import { QueueService } from '../src/queue/queue.service.js';
import { Tag } from '../src/tags/tag.entity.js';
import { TagsService } from '../src/tags/tags.service.js';
import { ApiKey } from '../src/api-keys/api-key.entity.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { globalScope, workspaceScope } from '../src/scopes/scope-ref.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

/** Embeds by lookup so similarity is exact and deterministic; unknown texts get a far-away vector. */
class ScriptedEmbeddings implements EmbeddingService {
  readonly model = 'scripted';
  readonly dimension = 1536;
  readonly vectors = new Map<string, number[]>();
  behaviour: 'ok' | 'fail' | 'hang' | 'fail-n' = 'ok';
  failures = 0;
  calls = 0;
  /** Vector at cosine similarity `cos` to the unit vector e0. */
  static at(cos: number): number[] {
    const v = new Array<number>(1536).fill(0);
    v[0] = cos;
    v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
    return v;
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    if (this.behaviour === 'hang') return new Promise(() => undefined);
    if (this.behaviour === 'fail' || (this.behaviour === 'fail-n' && this.failures-- > 0)) {
      throw new EmbeddingError('provider_failed', 'SECRET provider detail should never leak');
    }
    return texts.map((t) => this.vectors.get(t) ?? ScriptedEmbeddings.at(0));
  }
}

describeIntegration('Memory embeddings (real PostgreSQL + pgvector + pg-boss)', () => {
  vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });
  let iso: IsolatedSchema;
  let ds: DataSource;
  let admin: Client;
  let bossSchema: string;
  let wsA: string;
  let wsB: string;
  let embeddings: ScriptedEmbeddings;
  let queue: QueueService;
  let coordinator: MemoryEmbeddingCoordinator;
  let service: MemoriesService;
  let worker: MemoryEmbeddingWorker;
  const logs: string[] = [];

  const A = () => workspaceScope(wsA);
  const q = async (sql: string, params: unknown[] = []) => (await ds.query(sql, params)) as any[];
  const row = async (id: string) => (await q('SELECT * FROM memories WHERE id = $1', [id]))[0];
  const until = async (cond: () => Promise<boolean>, ms = 25_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('condition not met in time');
  };
  const create = (content: string, extra: Record<string, unknown> = {}, scope = A()) => service.create(ADMIN_PRINCIPAL, scope, { type: 'fact', content, ...extra } as any);
  const bossJobs = async () =>
    (await admin.query(`SELECT state, data, output, retry_count FROM "${bossSchema}".job WHERE name = $1 ORDER BY created_on`, [EMBED_MEMORY_QUEUE])).rows;

  async function build(options: { inlineTimeoutMs?: number; reconcileGraceMs?: number; start?: boolean } = {}) {
    queue = new QueueService({ connectionString: TEST_DATABASE_URL!, schema: bossSchema, ingestionConcurrency: 2, retryDelaySeconds: 1, pollingIntervalSeconds: 0.5, stopTimeoutMs: 5000 });
    coordinator = new MemoryEmbeddingCoordinator(ds, embeddings, queue, { similarityHint: 0.9, inlineTimeoutMs: options.inlineTimeoutMs ?? 1500, reconcileGraceMs: options.reconcileGraceMs ?? 0 });
    const authorization = new AuthorizationService();
    service = new MemoriesService(ds, authorization, new TagsService(ds, authorization), coordinator);
    worker = new MemoryEmbeddingWorker(queue, coordinator);
    await worker.onModuleInit();
    if (options.start !== false) await queue.onApplicationBootstrap();
  }

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey, Tag, Memory, MemoryTag]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    wsA = (await q(`INSERT INTO workspaces (name, slug) VALUES ('a', 'a') RETURNING id`))[0].id;
    wsB = (await q(`INSERT INTO workspaces (name, slug) VALUES ('b', 'b') RETURNING id`))[0].id;
    admin = new Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
  });
  afterAll(async () => {
    await admin?.end();
    await iso?.dispose();
  });

  beforeEach(async () => {
    embeddings = new ScriptedEmbeddings();
    bossSchema = `pgboss_t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    logs.length = 0;
    const capture = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    vi.spyOn(ConsoleLogger.prototype, 'log').mockImplementation(capture);
    vi.spyOn(ConsoleLogger.prototype, 'warn').mockImplementation(capture);
    vi.spyOn(ConsoleLogger.prototype, 'error').mockImplementation(capture);
    await q('DELETE FROM memory_tags');
    await q('DELETE FROM memories');
  });
  afterEach(async () => {
    worker?.beforeApplicationShutdown();
    await queue?.beforeApplicationShutdown().catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS "${bossSchema}" CASCADE`).catch(() => undefined);
    vi.restoreAllMocks();
  });

  describe('inline embedding', () => {
    it('stores a ready vector with model and dimension and returns no hints for the first Memory', async () => {
      await build();
      const m = await create('first fact');
      expect(m).toMatchObject({ embeddingStatus: 'ready', embeddingModel: 'scripted', deduplicated: false, hints: [] });
      const r = await row(m.id);
      expect(r.embedding_status).toBe('ready');
      expect((await q('SELECT vector_dims(embedding) d FROM memories WHERE id = $1', [m.id]))[0].d).toBe(1536);
      expect(await bossJobs()).toEqual([]);
    });

    it('embeds title and content together and re-embeds on a title-only change, but not on other edits', async () => {
      await build();
      const m = await create('same content', { title: 'one' });
      expect(embeddings.calls).toBe(1);
      const put = (extra: Record<string, unknown>) =>
        service.update(ADMIN_PRINCIPAL, A(), m.id, { type: 'fact', content: 'same content', title: 'one', metadata: null, confidence: null, source: null, tags: [], ...extra } as any);
      await put({ confidence: 0.5 });
      expect(embeddings.calls).toBe(1);
      await put({ title: 'two' });
      expect(embeddings.calls).toBe(2);
      expect(memoryEmbeddingText('two', 'same content')).toBe('two\n\nsame content');
      expect((await row(m.id)).embedding_generation).toBe(1);
    });

    it('does not embed again for a deduplicated create and returns no hints', async () => {
      await build();
      await create('dup');
      const again = await create('dup');
      expect(again).toMatchObject({ deduplicated: true, hints: [] });
      expect(embeddings.calls).toBe(1);
    });

    it('on timeout saves pending, queues a job and a worker makes it ready', async () => {
      await build({ inlineTimeoutMs: 100 });
      embeddings.behaviour = 'hang';
      const m = await create('slow one');
      expect(m.embeddingStatus).toBe('pending');
      expect(m.hints).toEqual([]);
      expect((await row(m.id)).embedding).toBeNull();
      await until(async () => (await bossJobs()).length === 1);
      embeddings.behaviour = 'ok';
      await until(async () => (await row(m.id)).embedding_status === 'ready');
    });

    it('on provider failure saves pending and retries until ready, within bounded attempts', async () => {
      await build();
      embeddings.behaviour = 'fail-n';
      embeddings.failures = 2; // inline + first job attempt fail, second job attempt succeeds
      const m = await create('flaky');
      expect(m.embeddingStatus).toBe('pending');
      await until(async () => (await row(m.id)).embedding_status === 'ready');
    });

    it('marks failed after the final attempt and stores only a safe code in the job output', async () => {
      await build();
      embeddings.behaviour = 'fail';
      const m = await create('doomed sentinel-content', { title: 'sentinel-title', metadata: { k: 'sentinel-meta' } });
      await until(async () => (await row(m.id)).embedding_status === 'failed');
      await until(async () => (await bossJobs()).some((j) => j.state === 'failed'));
      const jobs = await bossJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].retry_count).toBe(2);
      const dump = JSON.stringify(jobs) + logs.join('\n');
      for (const s of ['sentinel-content', 'sentinel-title', 'sentinel-meta', 'SECRET provider detail']) expect(dump).not.toContain(s);
      expect(Object.keys(jobs[0].data).sort()).toEqual(['generation', 'memoryId', 'scope']);
    });
  });

  describe('explicit retry', () => {
    it('is admin only, 404 for other scopes, 409 unless failed, and recovers failed records', async () => {
      await build();
      embeddings.behaviour = 'fail';
      const m = await create('to retry');
      await until(async () => (await row(m.id)).embedding_status === 'failed');
      embeddings.behaviour = 'ok';
      const key: Principal = { kind: 'apiKey', keyId: randomUUID(), keyName: 'k', workspaceId: wsA, permissions: ['memories:read', 'memories:write', 'memories:delete'] };
      await expect(service.retryEmbedding(key, A(), m.id)).rejects.toMatchObject({ status: 403 });
      await expect(service.retryEmbedding(key, workspaceScope(wsB), m.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.retryEmbedding(ADMIN_PRINCIPAL, workspaceScope(wsB), m.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.retryEmbedding(ADMIN_PRINCIPAL, globalScope(), m.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.retryEmbedding(ADMIN_PRINCIPAL, A(), randomUUID())).rejects.toMatchObject({ status: 404 });
      const res = await service.retryEmbedding(ADMIN_PRINCIPAL, A(), m.id);
      expect(res.embeddingStatus).toBe('pending');
      await until(async () => (await row(m.id)).embedding_status === 'ready');
      await expect(service.retryEmbedding(ADMIN_PRINCIPAL, A(), m.id)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('durability and races', () => {
    it('recovers a pending record whose enqueue was lost (queue down), after a restart', async () => {
      await build({ start: false });
      embeddings.behaviour = 'fail';
      const m = await create('lost enqueue');
      expect(m.embeddingStatus).toBe('pending');
      expect((await row(m.id)).embedding_scheduled_at).toBeNull();
      // "Restart": a fresh queue and coordinator against the same database.
      await queue.beforeApplicationShutdown();
      embeddings.behaviour = 'ok';
      await build();
      expect(await coordinator.reconcile()).toBe(1);
      await until(async () => (await row(m.id)).embedding_status === 'ready');
      expect((await row(m.id)).embedding_scheduled_at).toBeNull();
    });

    it('a stale generation cannot overwrite a newer title or content', async () => {
      await build({ start: false });
      embeddings.behaviour = 'fail';
      const m = await create('gen zero', { title: 'old' });
      const staleGeneration = (await row(m.id)).embedding_generation;
      await service.update(ADMIN_PRINCIPAL, A(), m.id, { type: 'fact', content: 'gen zero', title: 'new', metadata: null, confidence: null, source: null, tags: [] } as any);
      const current = (await row(m.id)).embedding_generation;
      expect(current).toBe(staleGeneration + 1);
      embeddings.behaviour = 'ok';
      embeddings.vectors.set('old\n\ngen zero', ScriptedEmbeddings.at(0.2));
      // Late inline result and stale job for the old generation: both are no-ops.
      expect(await coordinator.embedAfterCommit({ scopeKey: wsA, id: m.id, generation: staleGeneration, title: 'old', content: 'gen zero' })).toBeNull();
      await coordinator.process({ scope: wsA, memoryId: m.id, generation: staleGeneration, attempt: 1, maxAttempts: 3, isFinalAttempt: true });
      let r = await row(m.id);
      expect(r.embedding).toBeNull();
      expect(r.embedding_status).toBe('pending');
      await coordinator.process({ scope: wsA, memoryId: m.id, generation: current, attempt: 1, maxAttempts: 3, isFinalAttempt: false });
      r = await row(m.id);
      expect(r.embedding_status).toBe('ready');
    });

    it('a stale final failure cannot mark a newer generation failed', async () => {
      await build({ start: false });
      embeddings.behaviour = 'fail';
      const m = await create('x1');
      const g0 = (await row(m.id)).embedding_generation;
      await service.update(ADMIN_PRINCIPAL, A(), m.id, { type: 'fact', content: 'x1 changed', title: null, metadata: null, confidence: null, source: null, tags: [] } as any);
      await coordinator.process({ scope: wsA, memoryId: m.id, generation: g0, attempt: 3, maxAttempts: 3, isFinalAttempt: true });
      expect((await row(m.id)).embedding_status).toBe('pending');
    });

    it('never recreates a forgotten Memory, and a job for a deleted Workspace is a no-op', async () => {
      await build({ start: false });
      embeddings.behaviour = 'fail';
      const m = await create('forget me');
      await service.remove(ADMIN_PRINCIPAL, A(), m.id);
      embeddings.behaviour = 'ok';
      await coordinator.process({ scope: wsA, memoryId: m.id, generation: 0, attempt: 1, maxAttempts: 3, isFinalAttempt: false });
      expect(await q('SELECT 1 FROM memories WHERE id = $1', [m.id])).toEqual([]);
      const ghost = randomUUID();
      await coordinator.process({ scope: randomUUID(), memoryId: ghost, generation: 0, attempt: 1, maxAttempts: 3, isFinalAttempt: true });
      expect((await q('SELECT count(*)::int c FROM memories'))[0].c).toBe(0);
    });

    it('a late inline result after the record was forgotten writes nothing', async () => {
      await build();
      embeddings.behaviour = 'ok';
      const m = await create('gone soon');
      await q('DELETE FROM memories WHERE id = $1', [m.id]);
      expect(await coordinator.embedAfterCommit({ scopeKey: wsA, id: m.id, generation: 0, title: null, content: 'gone soon' })).toBeNull();
      expect((await q('SELECT count(*)::int c FROM memories'))[0].c).toBe(0);
    });

    it('a superseded record keeps its own generation and is not restored by stale work', async () => {
      await build({ start: false });
      embeddings.behaviour = 'fail';
      const old = await create('old thing');
      const next = await create('new thing');
      await service.supersede(ADMIN_PRINCIPAL, A(), old.id, { successorId: next.id });
      embeddings.behaviour = 'ok';
      await coordinator.process({ scope: wsA, memoryId: old.id, generation: 0, attempt: 1, maxAttempts: 3, isFinalAttempt: false });
      const r = await row(old.id);
      expect(r.status).toBe('superseded');
      expect(r.superseded_by).toBe(next.id);
    });
  });

  describe('similarity hints', () => {
    it('lists at most three, same-scope, active, ready candidates at or above the threshold, most similar first', async () => {
      await build();
      const base = ScriptedEmbeddings.at(1);
      embeddings.vectors.set('c1', ScriptedEmbeddings.at(0.99));
      embeddings.vectors.set('c2', ScriptedEmbeddings.at(0.95));
      embeddings.vectors.set('c3', ScriptedEmbeddings.at(0.92));
      embeddings.vectors.set('c4', ScriptedEmbeddings.at(0.9)); // exactly at the threshold is included, but the limit cuts it
      embeddings.vectors.set('low', ScriptedEmbeddings.at(0.5));
      embeddings.vectors.set('other-ws', ScriptedEmbeddings.at(0.999));
      embeddings.vectors.set('superseded', ScriptedEmbeddings.at(0.998));
      embeddings.vectors.set('NEW', base);
      const ids: Record<string, string> = {};
      for (const c of ['c3', 'c1', 'c4', 'c2', 'low', 'superseded']) ids[c] = (await create(c)).id;
      await create('other-ws', {}, workspaceScope(wsB));
      await create('other-global', {}, globalScope());
      await service.supersede(ADMIN_PRINCIPAL, A(), ids.superseded!, { successorId: ids.c1! });
      embeddings.behaviour = 'fail';
      const pending = await create('pending-one'); // not ready: never a hint
      expect(pending.embeddingStatus).toBe('pending');
      embeddings.behaviour = 'ok';
      const created = await create('NEW');
      expect(created.hints.map((h) => h.id)).toEqual([ids.c1, ids.c2, ids.c3]);
      expect(created.hints[0]).toEqual({ id: ids.c1, type: 'fact', preview: 'c1' });
      expect(created.hints.map((h) => h.id)).not.toContain(created.id);
      // Nothing was merged or changed.
      expect((await row(ids.c1!)).status).toBe('active');
      expect((await row(ids.c4!)).status).toBe('active');
      expect((await q('SELECT count(*)::int c FROM memories WHERE status = $1', ['superseded']))[0].c).toBe(1);
    });

    it('excludes a predecessor superseded by this very create, and respects the threshold', async () => {
      await build();
      embeddings.vectors.set('pred', ScriptedEmbeddings.at(0.97));
      embeddings.vectors.set('succ', ScriptedEmbeddings.at(1));
      const pred = await create('pred');
      const succ = await create('succ', { supersedes: pred.id });
      expect(succ.hints).toEqual([]);
      embeddings.vectors.set('barely', ScriptedEmbeddings.at(0.8999));
      await create('barely');
      embeddings.vectors.set('probe', ScriptedEmbeddings.at(1));
      expect((await create('probe')).hints.map((h) => h.preview)).toEqual(['succ']);
    });

    it('truncates previews', async () => {
      await build();
      const long = 'z'.repeat(500);
      embeddings.vectors.set(long, ScriptedEmbeddings.at(1));
      await create(long);
      embeddings.vectors.set('probe2', ScriptedEmbeddings.at(1));
      const r = await create('probe2');
      expect(r.hints[0]!.preview).toHaveLength(120);
    });
  });

  describe('dimension guard', () => {
    it('accepts the physical memories column and refuses a configured mismatch', async () => {
      await expect(assertEmbeddingDimension(ds, 1536, 'memories')).resolves.toBeUndefined();
      await expect(assertEmbeddingDimension(ds, 3072, 'memories')).rejects.toBeInstanceOf(EmbeddingDimensionError);
      await expect(assertEmbeddingDimension(ds, 3072, 'memories')).rejects.toThrow(/memories\.embedding column is vector\(1536\)/);
    });

    it('refuses a provider whose dimension differs from the column', async () => {
      await build();
      const small = new FakeEmbeddingService(8);
      const c = new MemoryEmbeddingCoordinator(ds, small, queue, { similarityHint: 0.9 });
      const m = await create('dim');
      await q(`UPDATE memories SET embedding = NULL, embedding_model = NULL, embedding_status = 'pending' WHERE id = $1`, [m.id]);
      await expect(c.process({ scope: wsA, memoryId: m.id, generation: 0, attempt: 1, maxAttempts: 3, isFinalAttempt: false })).rejects.toMatchObject({ code: 'invalid_output' });
      expect((await row(m.id)).embedding_status).toBe('pending');
    });
  });
});

void Logger;
