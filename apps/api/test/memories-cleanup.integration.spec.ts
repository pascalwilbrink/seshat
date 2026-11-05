import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Client } from 'pg';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKey } from '../src/api-keys/api-key.entity.js';
import { AuthorizationService } from '../src/auth/authorization.service.js';
import { ADMIN_PRINCIPAL } from '../src/auth/principal.js';
import type { EmbeddingService } from '../src/ingestion/embedding.service.js';
import { MemoriesService } from '../src/memories/memories.service.js';
import { Memory } from '../src/memories/memory.entity.js';
import { MemoryTag } from '../src/memories/memory-tag.entity.js';
import { MemoryEmbeddingCoordinator } from '../src/memories/memory-embedding.coordinator.js';
import { MemoryEmbeddingWorker } from '../src/memories/memory-embedding.worker.js';
import { EMBED_MEMORY_QUEUE } from '../src/queue/queue.constants.js';
import { QueueService } from '../src/queue/queue.service.js';
import { globalScope, workspaceScope } from '../src/scopes/scope-ref.js';
import { WorkspaceDataCleanup } from '../src/storage/workspace-data-cleanup.js';
import { Tag } from '../src/tags/tag.entity.js';
import { TagsService } from '../src/tags/tags.service.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { WorkspacesService } from '../src/workspaces/workspace.service.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

class Embeddings implements EmbeddingService {
  readonly model = 'scripted';
  readonly dimension = 1536;
  hang = false;
  async embed(texts: string[]): Promise<number[][]> {
    if (this.hang) return new Promise(() => undefined);
    return texts.map(() => [1, ...new Array<number>(1535).fill(0)]);
  }
}

describeIntegration('Memory cleanup, links and queue interplay (real PostgreSQL + pg-boss)', () => {
  vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });
  let iso: IsolatedSchema;
  let ds: DataSource;
  let admin: Client;
  let bossSchema: string;
  let embeddings: Embeddings;
  let queue: QueueService;
  let worker: MemoryEmbeddingWorker;
  let service: MemoriesService;
  let workspaces: WorkspacesService;
  const q = async (sql: string, params: unknown[] = []) => (await ds.query(sql, params)) as any[];
  const until = async (cond: () => Promise<boolean>, ms = 25_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('condition not met in time');
  };
  const addWorkspace = async (slug: string) => (await q('INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id, slug', [slug]))[0] as { id: string; slug: string };
  const mk = (scope: ReturnType<typeof globalScope>, content: string, extra: Record<string, unknown> = {}) => service.create(ADMIN_PRINCIPAL, scope, { type: 'fact', content, ...extra } as any);
  const bossJobs = async () => (await admin.query(`SELECT state, data, output FROM "${bossSchema}".job WHERE name = $1`, [EMBED_MEMORY_QUEUE])).rows;
  const count = async (table: string, where: string, params: unknown[] = []) => Number((await q(`SELECT count(*) c FROM ${table} WHERE ${where}`, params))[0].c);

  async function build(startWorker: boolean) {
    bossSchema = `pgboss_t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    queue = new QueueService({ connectionString: TEST_DATABASE_URL!, schema: bossSchema, ingestionConcurrency: 2, retryDelaySeconds: 1, pollingIntervalSeconds: 0.5, stopTimeoutMs: 5000 });
    const coordinator = new MemoryEmbeddingCoordinator(ds, embeddings, queue, { similarityHint: 0.9, inlineTimeoutMs: 100, reconcileGraceMs: 0 });
    const authorization = new AuthorizationService();
    service = new MemoriesService(ds, authorization, new TagsService(ds, authorization), coordinator);
    const cleanup = new WorkspaceDataCleanup({ deleteScopedFilesWithIntents: async () => undefined } as never);
    workspaces = new WorkspacesService(ds.getRepository(Workspace), ds as never, authorization, new EventEmitter2(), cleanup);
    worker = new MemoryEmbeddingWorker(queue, coordinator);
    if (startWorker) await worker.onModuleInit();
    await queue.onApplicationBootstrap();
    return { coordinator, startWorker: async () => worker.onModuleInit() };
  }

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey, Tag, Memory, MemoryTag]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    admin = new Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
  });
  afterAll(async () => {
    await admin?.end();
    await iso?.dispose();
  });
  beforeEach(async () => {
    embeddings = new Embeddings();
    await q('DELETE FROM memory_tags');
    await q('DELETE FROM memories');
    await q('DELETE FROM tags');
    await q('DELETE FROM workspaces');
  });
  afterEach(async () => {
    worker?.beforeApplicationShutdown();
    await queue?.beforeApplicationShutdown().catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS "${bossSchema}" CASCADE`).catch(() => undefined);
  });

  it('deleting a Workspace with pending and ready Memories and queued jobs leaves no orphans; other scopes still finish their jobs', async () => {
    const { startWorker } = await build(false); // jobs stay queued while we delete
    const doomed = await addWorkspace('doomed');
    const keep = await addWorkspace('keep');
    const dScope = workspaceScope(doomed.id);
    const kScope = workspaceScope(keep.id);

    embeddings.hang = true; // inline times out: pending + queued job
    const pendingDoomed = await mk(dScope, 'pending in doomed', { tags: ['shared', 'doomed-only'] });
    const supersededDoomed = await mk(dScope, 'older in doomed', { tags: ['shared'] });
    await service.supersede(ADMIN_PRINCIPAL, dScope, supersededDoomed.id, { successorId: pendingDoomed.id });
    const pendingKeep = await mk(kScope, 'pending in keep', { tags: ['shared'] });
    const pendingGlobal = await mk(globalScope(), 'pending in global', { tags: ['shared'] });
    await until(async () => (await bossJobs()).length >= 4);
    expect([pendingDoomed, supersededDoomed, pendingKeep, pendingGlobal].every((m) => m.embeddingStatus === 'pending')).toBe(true);

    await workspaces.remove(ADMIN_PRINCIPAL, workspaceScope(doomed.id), doomed.slug);

    expect(await count('workspaces', 'id = $1', [doomed.id])).toBe(0);
    expect(await count('memories', 'scope_key = $1', [doomed.id])).toBe(0);
    expect(await count('memory_tags', 'scope_key = $1', [doomed.id])).toBe(0);
    expect(await count('tags', 'scope_key = $1', [doomed.id])).toBe(0);
    // orphan sweep across the whole schema
    expect(await count('memory_tags', 'NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_id)')).toBe(0);
    expect(await count('memory_tags', 'NOT EXISTS (SELECT 1 FROM tags t WHERE t.id = tag_id)')).toBe(0);
    expect(await count('memories', 'superseded_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memories n WHERE n.id = superseded_by)')).toBe(0);

    // Other scopes are untouched, including their same-named tag.
    expect(await count('memories', 'scope_key = $1', [keep.id])).toBe(1);
    expect(await count('memories', "scope_key = 'global'")).toBe(1);
    expect(await count('tags', "name = 'shared'")).toBe(2);
    expect(await count('memory_tags', 'scope_key = $1', [keep.id])).toBe(1);

    // The stale jobs of the deleted Workspace run now: they end quietly, nothing is recreated, other scopes become ready.
    embeddings.hang = false;
    await startWorker();
    await until(async () => (await q(`SELECT count(*) c FROM memories WHERE embedding_status = 'ready'`))[0].c === '2');
    await until(async () => (await bossJobs()).every((j: { state: string }) => j.state === 'completed'));
    expect(await count('memories', 'scope_key = $1', [doomed.id])).toBe(0);
    expect(await count('memories', 'true')).toBe(2);
    await expect(service.retryEmbedding(ADMIN_PRINCIPAL, dScope, pendingDoomed.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.get(ADMIN_PRINCIPAL, dScope, pendingDoomed.id)).rejects.toMatchObject({ status: 404 });
  });

  it('forgetting in a chain keeps statuses, clears only the incoming link and never touches the other scopes', async () => {
    await build(true);
    embeddings.hang = false;
    const ws = await addWorkspace('chain');
    const other = await addWorkspace('chain-other');
    const S = workspaceScope(ws.id);
    const O = workspaceScope(other.id);
    const a = await mk(S, 'a');
    const b = await mk(S, 'b');
    const c = await mk(S, 'c');
    const gA = await mk(globalScope(), 'a');
    const oA = await mk(O, 'a');
    await service.supersede(ADMIN_PRINCIPAL, S, a.id, { successorId: b.id });
    await service.supersede(ADMIN_PRINCIPAL, S, b.id, { successorId: c.id });

    await service.remove(ADMIN_PRINCIPAL, S, b.id);
    const rowA = (await q('SELECT status, superseded_by, embedding_status FROM memories WHERE id = $1', [a.id]))[0];
    expect(rowA).toMatchObject({ status: 'superseded', superseded_by: null });
    expect((await q('SELECT status, superseded_by FROM memories WHERE id = $1', [c.id]))[0]).toMatchObject({ status: 'active', superseded_by: null });
    expect(await count('memories', 'superseded_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memories n WHERE n.id = superseded_by)')).toBe(0);
    // A stays hidden from the default list, visible with status=superseded, and still cannot be edited (no successor to name).
    expect((await service.list(ADMIN_PRINCIPAL, S, {})).items.map((i) => i.id)).toEqual([c.id]);
    expect((await service.list(ADMIN_PRINCIPAL, S, { status: 'superseded' })).items).toMatchObject([{ id: a.id, status: 'superseded', supersededBy: null }]);
    await expect(
      service.update(ADMIN_PRINCIPAL, S, a.id, { type: 'fact', content: 'x', title: null, metadata: null, confidence: null, source: null, tags: [] }),
    ).rejects.toMatchObject({ status: 409 });
    // Same text in another scope is a different record, unchanged by all of this.
    for (const id of [gA.id, oA.id]) expect((await q('SELECT status, superseded_by FROM memories WHERE id = $1', [id]))[0]).toEqual({ status: 'active', superseded_by: null });
    // Forgetting the last record leaves no tag joins behind either.
    await service.remove(ADMIN_PRINCIPAL, S, c.id);
    await service.remove(ADMIN_PRINCIPAL, S, a.id);
    expect(await count('memories', 'scope_key = $1', [ws.id])).toBe(0);
  });
});
