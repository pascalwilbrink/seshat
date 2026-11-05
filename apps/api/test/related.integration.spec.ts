import { createHash, randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthorizationService } from '../src/auth/authorization.service.js';
import type { Principal } from '../src/auth/principal.js';
import { FakeEmbeddingService } from '../src/ingestion/fake-embedding.service.js';
import { RelatedMemoriesService } from '../src/search/related.service.js';
import { RetrievalService } from '../src/search/retrieval.service.js';
import { globalRelatedQuerySchema, workspaceRelatedQuerySchema } from '../src/search/related-request.dto.js';
import { globalScope, type ScopeRef } from '../src/scopes/scope-ref.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

const DIM = 1536;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Unit vector at `angle` radians from e0: the cosine distance to angle 0 is 1 - cos(angle). */
const angled = (angle: number): number[] => {
  const v = new Array<number>(DIM).fill(0);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return v;
};
const lit = (v: number[]) => `[${v.join(',')}]`;

const ADMIN = { kind: 'admin' } as unknown as Principal;
const keyOf = (workspaceId: string, permissions: string[]) => ({ kind: 'apiKey', keyId: randomUUID(), workspaceId, permissions }) as unknown as Principal;

describeIntegration('related Memories (real PostgreSQL with pgvector)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let embeddings: FakeEmbeddingService;
  let service: RelatedMemoriesService;
  let wsA: string;
  let wsB: string;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params) as Promise<Record<string, any>[]>;
  const scopeCols = (s: 'A' | 'B' | 'G') => (s === 'G' ? ['global', null] : ['workspace', s === 'A' ? wsA : wsB]);
  const route = (s: 'A' | 'B' | 'G'): ScopeRef => (s === 'G' ? globalScope() : { kind: 'workspace', workspaceId: s === 'A' ? wsA : wsB });

  let n = 0;
  const add = async (s: 'A' | 'B' | 'G', o: { angle: number | null; type?: string; status?: string; title?: string }) =>
    (
      await q(
        `INSERT INTO memories (scope, workspace_id, type, content, title, status, created_by_kind, content_hash, embedding, embedding_status, embedding_model)
         VALUES ($1,$2,$3,$4,$5,$6,'admin',$7,$8::vector,$9,'fake') RETURNING id`,
        [
          ...scopeCols(s),
          o.type ?? 'fact',
          `content ${++n}`,
          o.title ?? null,
          o.status ?? 'active',
          sha(`m${n}`),
          o.angle === null ? null : lit(angled(o.angle)),
          o.angle === null ? 'pending' : 'ready',
        ],
      )
    )[0]!.id as string;

  const related = (principal: Principal, s: 'A' | 'B' | 'G', seed: string, query: Record<string, unknown> = {}) =>
    // Parse like the controller's ZodValidationPipe does, so the service sees exactly what HTTP delivers.
    service.related(principal, route(s), seed, (s === 'G' ? globalRelatedQuerySchema : workspaceRelatedQuerySchema).parse(query));
  const ids = (r: { results: { id: string }[] }) => r.results.map((x) => x.id);

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([]);
    // Make HNSW the planner's only ordering path for the small fixtures, so filtered scans really underfill.
    (ds.options as { extra: { options: string } }).extra.options += ' -c enable_seqscan=off -c enable_sort=off';
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    wsA = (await q(`INSERT INTO workspaces (name, slug) VALUES ('A','ws-a') RETURNING id`))[0]!.id;
    wsB = (await q(`INSERT INTO workspaces (name, slug) VALUES ('B','ws-b') RETURNING id`))[0]!.id;
    embeddings = new FakeEmbeddingService(DIM);
    const retrieval = new RetrievalService(ds, embeddings);
    service = new RelatedMemoriesService(new AuthorizationService(), ds, retrieval);
  });
  afterAll(async () => {
    await iso?.dispose();
  });
  afterEach(async () => {
    await q(`DELETE FROM memories`);
    await q(`DELETE FROM tags`);
    vi.restoreAllMocks();
  });

  it('orders by cosine distance, excludes the seed, honours limit and the type filter, and never embeds a query', async () => {
    const seed = await add('A', { angle: 0 });
    const far = await add('A', { angle: 1.2 });
    const near = await add('A', { angle: 0.1, type: 'decision' });
    const mid = await add('A', { angle: 0.5 });
    const res = await related(ADMIN, 'A', seed);
    expect(ids(res)).toEqual([near, mid, far]);
    expect(res.results.map((r) => r.distance)).toEqual([...res.results.map((r) => r.distance)].sort((a, b) => a - b));
    expect(res.results[0]!.distance).toBeCloseTo(1 - Math.cos(0.1), 6);
    expect(ids(await related(ADMIN, 'A', seed, { limit: '2' }))).toEqual([near, mid]);
    expect(ids(await related(ADMIN, 'A', seed, { type: ['decision'] }))).toEqual([near]);
    expect(ids(await related(ADMIN, 'A', seed, { type: ['decision', 'fact'] }))).toEqual([near, mid, far]);
    expect(embeddings.calls).toHaveLength(0);
  });

  it('breaks distance ties by id, deterministically', async () => {
    const seed = await add('A', { angle: 0 });
    const tied = [await add('A', { angle: 0.3 }), await add('A', { angle: 0.3 }), await add('A', { angle: 0.3 })].sort();
    expect(ids(await related(ADMIN, 'A', seed))).toEqual(tied);
    expect(ids(await related(ADMIN, 'A', seed))).toEqual(tied);
  });

  it('excludes superseded and null-vector candidates and ignores a superseded or unembedded seed status', async () => {
    const seed = await add('A', { angle: 0 });
    await add('A', { angle: 0.01, status: 'superseded' });
    await add('A', { angle: null });
    const ok = await add('A', { angle: 0.9 });
    expect(ids(await related(ADMIN, 'A', seed))).toEqual([ok]);
  });

  it('a seed without a vector gives an empty, provider-free result; a missing seed is a 404', async () => {
    const seed = await add('A', { angle: null });
    await add('A', { angle: 0.1 });
    const res = await related(ADMIN, 'A', seed);
    expect(res).toEqual({ results: [] });
    expect(embeddings.calls).toHaveLength(0);
    await expect(related(ADMIN, 'A', randomUUID())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('stays inside the route Workspace even when other Workspaces and Global rank closest', async () => {
    const seed = await add('A', { angle: 0 });
    await add('B', { angle: 0 });
    await add('G', { angle: 0 });
    const own = await add('A', { angle: 1.0 });
    expect(ids(await related(ADMIN, 'A', seed))).toEqual([own]);
    expect(ids(await related(ADMIN, 'A', seed, { includeGlobal: 'false' }))).toEqual([own]);
  });

  it('includeGlobal adds Global candidates only with the explicit request AND the grant', async () => {
    const seed = await add('A', { angle: 0 });
    const g = await add('G', { angle: 0.05 });
    await add('B', { angle: 0.01 });
    const own = await add('A', { angle: 0.6 });
    expect(ids(await related(ADMIN, 'A', seed, { includeGlobal: 'true' }))).toEqual([g, own]);

    const granted = keyOf(wsA, ['search', 'memories:read', 'global:read']);
    expect(ids(await related(granted, 'A', seed))).toEqual([own]); // granted but not requested
    expect(ids(await related(granted, 'A', seed, { includeGlobal: 'true' }))).toEqual([g, own]);
    const ungranted = keyOf(wsA, ['search', 'memories:read']);
    await expect(related(ungranted, 'A', seed, { includeGlobal: 'true' })).rejects.toMatchObject({ status: 403 });
  });

  it('requires search AND memories:read, and a Global seed is never reachable through a Workspace route or vice versa', async () => {
    const seed = await add('A', { angle: 0 });
    const gSeed = await add('G', { angle: 0 });
    await add('A', { angle: 0.2 });
    await expect(related(keyOf(wsA, ['memories:read']), 'A', seed)).rejects.toMatchObject({ status: 403 });
    await expect(related(keyOf(wsA, ['search']), 'A', seed)).rejects.toMatchObject({ status: 403 });
    expect(ids(await related(keyOf(wsA, ['search', 'memories:read']), 'A', seed))).toHaveLength(1);
    // Foreign Workspace seed, Global seed on a Workspace route, Workspace seed on the Global route: all plain 404s.
    await expect(related(ADMIN, 'B', seed)).rejects.toBeInstanceOf(NotFoundException);
    await expect(related(ADMIN, 'A', gSeed, { includeGlobal: 'true' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(related(ADMIN, 'G', seed)).rejects.toBeInstanceOf(NotFoundException);
    await expect(related(keyOf(wsB, ['search', 'memories:read', 'global:read']), 'B', seed, { includeGlobal: 'true' })).rejects.toBeInstanceOf(NotFoundException);
    const foreign = await related(ADMIN, 'B', seed).catch((e: NotFoundException) => e.getResponse());
    const missing = await related(ADMIN, 'B', randomUUID()).catch((e: NotFoundException) => e.getResponse());
    expect(foreign).toEqual(missing);
  });

  it('returns safe source details only: no vectors, totals or storage fields', async () => {
    const seed = await add('A', { angle: 0 });
    await add('A', { angle: 0.2, title: 'T' });
    const res = await related(ADMIN, 'A', seed);
    expect(Object.keys(res)).toEqual(['results']);
    const text = JSON.stringify(res);
    expect(text).not.toMatch(/embedding|vector|total|content_hash|scope_key/i);
    expect(res.results[0]).toMatchObject({ kind: 'memory', title: 'T', status: 'active', memoryType: 'fact', scope: { kind: 'workspace', id: wsA, slug: 'ws-a' } });
  });

  it('fills the limit under a selective type filter and leaves no scan settings on the connection', async () => {
    const seed = await add('A', { angle: 0 });
    // 60 closer decoys of another type, then the 5 candidates of the requested type far away.
    for (let i = 0; i < 60; i++) await add('A', { angle: 0.001 * (i + 1), type: 'context' });
    const wanted: string[] = [];
    for (let i = 0; i < 5; i++) wanted.push(await add('A', { angle: 1.0 + 0.01 * i, type: 'procedure' }));
    expect(ids(await related(ADMIN, 'A', seed, { type: 'procedure', limit: '5' }))).toEqual(wanted);
    const [{ v }] = (await q(`SELECT current_setting('hnsw.ef_search', true) AS v`)) as { v: string | null }[];
    expect(v === null || v === '' || v === '40').toBe(true);
  });
});
