import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { FakeEmbeddingService } from '../src/ingestion/fake-embedding.service.js';
import { RetrievalService, type RetrievalTrace } from '../src/search/retrieval.service.js';
import type { AuthorizedSearchPlan } from '../src/search/search-plan.js';
import type { SearchRequest } from '../src/search/search-request.dto.js';
import type { SearchResponse } from '../src/search/search-result.dto.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

const DIM = 1536;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Unit vector at `angle` radians from the query direction (e0) in the e0/e1 plane: smaller angle = closer to the query. */
const angled = (angle: number): number[] => {
  const v = new Array<number>(DIM).fill(0);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return v;
};
const lit = (v: number[]) => `[${v.join(',')}]`;
const QUERY_VECTOR = angled(0);

/** Query embedding with a fixed direction, so tests control every vector ranking exactly. */
class AxisEmbedding extends FakeEmbeddingService {
  override async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map(() => QUERY_VECTOR);
  }
}

const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({
  query: 'alpha',
  types: ['files', 'memories'],
  tagMatch: 'any',
  includeSuperseded: false,
  limit: 10,
  includeGlobal: false,
  ...over,
});

describeIntegration('hybrid retrieval (real PostgreSQL with pgvector)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let embeddings: AxisEmbedding;
  let service: RetrievalService;
  let wsA: string;
  let wsB: string;
  let extVersion: string | null;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params) as Promise<Record<string, any>[]>;
  const planFor = (scopes: ('A' | 'B' | 'G')[], types: ('files' | 'memories')[] = ['files', 'memories']): AuthorizedSearchPlan => ({
    scopes: scopes.map((s) => (s === 'G' ? { kind: 'global' as const } : { kind: 'workspace' as const, workspaceId: s === 'A' ? wsA : wsB })),
    types,
  });
  const scopeCols = (s: 'A' | 'B' | 'G') => (s === 'G' ? ['global', null] : ['workspace', s === 'A' ? wsA : wsB]);

  let n = 0;
  const addFile = async (s: 'A' | 'B' | 'G', opts: { status?: string; collectionId?: string | null; name?: string } = {}) =>
    (
      await q(
        `INSERT INTO files (scope, workspace_id, name, extension, mime_type, size_bytes, sha256, storage_key, ingestion_status, collection_id)
         VALUES ($1,$2,$3,'md','text/markdown',1,$4,$5,$6,$7) RETURNING id`,
        [...scopeCols(s), opts.name ?? `file-${++n}.md`, sha(`f${n}`), `k/${n}`, opts.status ?? 'indexed', opts.collectionId ?? null],
      )
    )[0]!.id as string;
  const addChunk = async (s: 'A' | 'B' | 'G', fileId: string, content: string, angle: number | null) =>
    (
      await q(
        `INSERT INTO chunks (scope, workspace_id, file_id, ordinal, content, location, char_count, content_hash, embedding, embedding_model)
         VALUES ($1,$2,$3,$4,$5,'{"startOffset":0,"endOffset":1,"startLine":1,"endLine":2,"section":"Intro"}',$6,$7,$8::vector,'fake') RETURNING id`,
        [...scopeCols(s), fileId, ++n, content, content.length, sha(content + n), lit(angle === null ? angled(1.5) : angled(angle))],
      )
    )[0]!.id as string;
  const addMemory = async (
    s: 'A' | 'B' | 'G',
    o: { content: string; title?: string | null; type?: string; status?: string; angle?: number | null },
  ) =>
    (
      await q(
        `INSERT INTO memories (scope, workspace_id, type, content, title, status, created_by_kind, content_hash, embedding, embedding_status, embedding_model)
         VALUES ($1,$2,$3,$4,$5,$6,'admin',$7,$8::vector,$9,'fake') RETURNING id`,
        [
          ...scopeCols(s),
          o.type ?? 'fact',
          o.content,
          o.title ?? null,
          o.status ?? 'active',
          sha(o.content + ++n),
          o.angle === null || o.angle === undefined ? null : lit(angled(o.angle)),
          o.angle === null || o.angle === undefined ? 'pending' : 'ready',
        ],
      )
    )[0]!.id as string;
  const tag = async (s: 'A' | 'B' | 'G', name: string) => {
    const existing = await q(`SELECT id FROM tags WHERE name = $1 AND scope_key = $2`, [name, s === 'G' ? 'global' : s === 'A' ? wsA : wsB]);
    if (existing[0]) return existing[0].id as string;
    return (await q(`INSERT INTO tags (scope, workspace_id, name) VALUES ($1,$2,$3) RETURNING id`, [...scopeCols(s), name]))[0]!.id as string;
  };
  const tagFile = async (s: 'A' | 'B' | 'G', fileId: string, name: string) =>
    q(`INSERT INTO file_tags (file_id, tag_id, scope_key) VALUES ($1,$2,$3)`, [fileId, await tag(s, name), s === 'G' ? 'global' : s === 'A' ? wsA : wsB]);
  const tagMemory = async (s: 'A' | 'B' | 'G', memoryId: string, name: string) =>
    q(`INSERT INTO memory_tags (memory_id, tag_id, scope_key) VALUES ($1,$2,$3)`, [memoryId, await tag(s, name), s === 'G' ? 'global' : s === 'A' ? wsA : wsB]);
  const addCollection = async (s: 'A' | 'B' | 'G', name: string) =>
    (await q(`INSERT INTO collections (scope, workspace_id, name) VALUES ($1,$2,$3) RETURNING id`, [...scopeCols(s), name]))[0]!.id as string;

  const run = async (plan: AuthorizedSearchPlan, request: SearchRequest): Promise<{ response: SearchResponse; trace: RetrievalTrace }> => {
    embeddings.calls.length = 0;
    return service.retrieveWithTrace(plan, request);
  };
  const ids = (r: SearchResponse) => r.results.map((x) => x.id);

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([]);
    // Make the HNSW index the planner's only way to order for the small fixtures, so filtered ANN scans really underfill.
    (ds.options as { extra: { options: string } }).extra.options += ' -c enable_seqscan=off -c enable_sort=off';
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    wsA = (await q(`INSERT INTO workspaces (name, slug) VALUES ('A','ws-a') RETURNING id`))[0]!.id;
    wsB = (await q(`INSERT INTO workspaces (name, slug) VALUES ('B','ws-b') RETURNING id`))[0]!.id;
    embeddings = new AxisEmbedding(DIM);
    service = new RetrievalService(ds, embeddings);
    extVersion = (await q(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`))[0]?.extversion ?? null;
  });
  afterAll(async () => {
    await iso?.dispose();
  });
  afterEach(async () => {
    await q(`DELETE FROM memories`);
    await q(`DELETE FROM files`);
    await q(`DELETE FROM collections`);
    await q(`DELETE FROM tags`);
    vi.restoreAllMocks();
  });

  it('records the verified pgvector version', () => {
    // Local/CI notes: the strategy depends on this; see RetrievalService. 0.8.0+ adds hnsw.iterative_scan.
    expect(extVersion).toMatch(/^\d+\.\d+/);
  });

  describe('scope, type and status predicates apply before ranking', () => {
    it('never returns other Workspaces or ungranted Global, even when they rank best in both rankings', async () => {
      const fa = await addFile('A');
      const fb = await addFile('B');
      const fg = await addFile('G');
      const a = await addChunk('A', fa, 'alpha own', 1.0);
      await addChunk('B', fb, 'alpha alpha alpha foreign', 0);
      await addChunk('G', fg, 'alpha alpha alpha global', 0);
      const ma = await addMemory('A', { content: 'alpha own memory', angle: 1.0 });
      await addMemory('B', { content: 'alpha alpha alpha foreign memory', angle: 0 });
      await addMemory('G', { content: 'alpha alpha alpha global memory', angle: 0 });
      const { response } = await run(planFor(['A']), req());
      expect(new Set(ids(response))).toEqual(new Set([a, ma]));
      expect(response.results.every((r) => r.scope.kind === 'workspace' && r.scope.id === wsA)).toBe(true);
    });

    it('includes Global only when the plan carries it', async () => {
      const fa = await addFile('A');
      const fg = await addFile('G');
      const a = await addChunk('A', fa, 'alpha one', 0.5);
      const g = await addChunk('G', fg, 'alpha two', 0.6);
      const { response } = await run(planFor(['A', 'G']), req());
      expect(new Set(ids(response))).toEqual(new Set([a, g]));
      expect(response.results.find((r) => r.id === g)!.scope).toEqual({ kind: 'global' });
      expect(response.results.find((r) => r.id === a)!.scope).toEqual({ kind: 'workspace', id: wsA, slug: 'ws-a' });
    });

    it('searches only the readable types', async () => {
      const f = await addFile('A');
      const c = await addChunk('A', f, 'alpha chunk', 0.2);
      const m = await addMemory('A', { content: 'alpha memory', angle: 0.2 });
      expect(ids((await run(planFor(['A'], ['files']), req())).response)).toEqual([c]);
      expect(ids((await run(planFor(['A'], ['memories']), req())).response)).toEqual([m]);
      // The request narrows the plan, never widens it.
      expect(ids((await run(planFor(['A'], ['files']), req({ types: ['files', 'memories'] }))).response)).toEqual([c]);
      expect(ids((await run(planFor(['A'], []), req())).response)).toEqual([]);
    });

    it('excludes chunks of files that are not indexed and superseded memories by default', async () => {
      const ok = await addFile('A');
      const c = await addChunk('A', ok, 'alpha ok', 0.9);
      for (const status of ['pending', 'processing', 'failed']) await addChunk('A', await addFile('A', { status }), 'alpha hidden', 0);
      const m = await addMemory('A', { content: 'alpha active', angle: 0.9 });
      const old = await addMemory('A', { content: 'alpha superseded', angle: 0, status: 'superseded' });
      expect(new Set(ids((await run(planFor(['A']), req())).response))).toEqual(new Set([c, m]));
      const withOld = (await run(planFor(['A']), req({ includeSuperseded: true }))).response;
      expect(new Set(ids(withOld))).toEqual(new Set([c, m, old]));
      expect(withOld.results.find((r) => r.id === old)).toMatchObject({ kind: 'memory', status: 'superseded' });
    });
  });

  describe('metadata filters', () => {
    it('applies Collection, file, tag any/all and memory type filters, alone and combined', async () => {
      const colX = await addCollection('A', 'x');
      const colY = await addCollection('A', 'y');
      const f1 = await addFile('A', { collectionId: colX });
      const f2 = await addFile('A', { collectionId: colY });
      const f3 = await addFile('A');
      await tagFile('A', f1, 'red');
      await tagFile('A', f1, 'blue');
      await tagFile('A', f2, 'red');
      const c1 = await addChunk('A', f1, 'alpha one', 0.1);
      const c1b = await addChunk('A', f1, 'alpha one more', 0.15);
      const c2 = await addChunk('A', f2, 'alpha two', 0.2);
      const c3 = await addChunk('A', f3, 'alpha three', 0.3);
      const mFact = await addMemory('A', { content: 'alpha fact', type: 'fact', angle: 0.1 });
      const mDec = await addMemory('A', { content: 'alpha decision', type: 'decision', angle: 0.2 });
      await tagMemory('A', mFact, 'red');
      await tagMemory('A', mFact, 'blue');
      await tagMemory('A', mDec, 'red');
      const files = (r: Partial<SearchRequest>) => run(planFor(['A'], ['files']), req(r)).then((x) => new Set(ids(x.response)));
      const mems = (r: Partial<SearchRequest>) => run(planFor(['A'], ['memories']), req(r)).then((x) => new Set(ids(x.response)));

      expect(await files({ collectionIds: [colX] })).toEqual(new Set([c1, c1b]));
      expect(await files({ fileIds: [f2, f3] })).toEqual(new Set([c2, c3]));
      expect(await files({ tags: ['red'] })).toEqual(new Set([c1, c1b, c2]));
      expect(await files({ tags: ['red', 'blue'], tagMatch: 'any' })).toEqual(new Set([c1, c1b, c2]));
      expect(await files({ tags: ['red', 'blue'], tagMatch: 'all' })).toEqual(new Set([c1, c1b]));
      expect(await files({ tags: ['red', 'blue'], tagMatch: 'all', collectionIds: [colY] })).toEqual(new Set());
      expect(await files({ tags: ['red'], collectionIds: [colY], fileIds: [f2] })).toEqual(new Set([c2]));
      expect(await mems({ memoryTypes: ['decision'] })).toEqual(new Set([mDec]));
      expect(await mems({ tags: ['red', 'blue'], tagMatch: 'all' })).toEqual(new Set([mFact]));
      expect(await mems({ tags: ['red'], memoryTypes: ['fact', 'decision'] })).toEqual(new Set([mFact, mDec]));
      // Collection/file filters never narrow Memories, memory filters never narrow chunks; tags apply to both.
      const both = (await run(planFor(['A']), req({ collectionIds: [colX], memoryTypes: ['decision'] }))).response;
      expect(new Set(ids(both))).toEqual(new Set([c1, c1b, mDec]));
      const tagged = (await run(planFor(['A']), req({ tags: ['blue'] }))).response;
      expect(new Set(ids(tagged))).toEqual(new Set([c1, c1b, mFact]));
    }, 60_000);

    it('does not multiply rows when a file has several matching tags', async () => {
      const f = await addFile('A');
      await tagFile('A', f, 'red');
      await tagFile('A', f, 'blue');
      const c = await addChunk('A', f, 'alpha', 0.1);
      const { response } = await run(planFor(['A'], ['files']), req({ tags: ['red', 'blue'] }));
      expect(ids(response)).toEqual([c]);
    });

    it('treats inaccessible Collection and file ids exactly like random ids', async () => {
      const fa = await addFile('A');
      await addChunk('A', fa, 'alpha own', 0.5);
      const colB = await addCollection('B', 'bcol');
      const fb = await addFile('B', { collectionId: colB });
      await addChunk('B', fb, 'alpha alpha foreign', 0);
      const random = '99999999-9999-4999-8999-999999999999';
      const call = async (r: Partial<SearchRequest>) => JSON.stringify((await run(planFor(['A'], ['files']), req(r))).response);
      expect(await call({ collectionIds: [colB] })).toBe(await call({ collectionIds: [random] }));
      expect(await call({ fileIds: [fb] })).toBe(await call({ fileIds: [random] }));
      expect(JSON.parse(await call({ fileIds: [fb] }))).toEqual({ results: [] });
    });
  });

  describe('ranking and fusion', () => {
    it('finds an exact identifier by keyword where the vector ranking misses it', async () => {
      const f = await addFile('A');
      for (let i = 0; i < 12; i++) await addChunk('A', f, `unrelated text number ${i}`, 0.01 * (i + 1));
      const target = await addChunk('A', f, 'incident ZX-4411-QR was closed', 1.4);
      const { response } = await run(planFor(['A'], ['files']), req({ query: 'ZX-4411-QR', limit: 2 }));
      expect(ids(response)).toContain(target);
      const hit = response.results.find((r) => r.id === target)!;
      expect(hit.vectorRank).toBeNull();
      expect(hit.keywordRank).toBe(1);
    });

    it('fuses vector and keyword ranks with k = 60 into one deduplicated list of chunks and memories', async () => {
      const f = await addFile('A');
      const c = await addChunk('A', f, 'alpha chunk', 0.1);
      const m = await addMemory('A', { content: 'alpha memory', angle: 0.2, title: 'Alpha' });
      const { response } = await run(planFor(['A']), req());
      expect(ids(response).sort()).toEqual([c, m].sort());
      for (const r of response.results) {
        expect(r.vectorRank).toBe(1);
        expect(r.keywordRank).toBe(1);
        expect(r.score).toBeCloseTo(2 / 61, 12);
      }
      // Equal fused scores: chunk before memory.
      expect(response.results.map((r) => r.kind)).toEqual(['chunk', 'memory']);
    });

    it('uses keyword only for Memories without an embedding', async () => {
      const m = await addMemory('A', { content: 'alpha without vector', angle: null });
      const { response } = await run(planFor(['A'], ['memories']), req());
      expect(ids(response)).toEqual([m]);
      expect(response.results[0]).toMatchObject({ vectorRank: null, keywordRank: 1 });
      // Not reachable by vector alone: a query without keyword overlap does not return it.
      expect(ids((await run(planFor(['A'], ['memories']), req({ query: 'zzzz' }))).response)).toEqual([]);
    });

    it('applies minScore to fused scores before the cut', async () => {
      const f = await addFile('A');
      const both = await addChunk('A', f, 'alpha both', 0.1);
      const vectorOnly = await addChunk('A', f, 'unrelated', 0.2);
      expect(ids((await run(planFor(['A'], ['files']), req())).response)).toEqual([both, vectorOnly]);
      expect(ids((await run(planFor(['A'], ['files']), req({ minScore: 0.02 }))).response)).toEqual([both]);
      expect(ids((await run(planFor(['A'], ['files']), req({ minScore: 0.5 }))).response)).toEqual([]);
    });

    it('returns equal-score ties in a stable order', async () => {
      const f = await addFile('A');
      for (let i = 0; i < 5; i++) await addChunk('A', f, `tie ${i}`, 0.3); // identical vectors, no keyword match
      const first = ids((await run(planFor(['A'], ['files']), req({ query: 'nomatchhere' }))).response);
      const second = ids((await run(planFor(['A'], ['files']), req({ query: 'nomatchhere' }))).response);
      expect(first).toHaveLength(5);
      expect(first).toEqual(second);
      expect(first).toEqual([...first].sort());
    });

    it('embeds the query exactly once for both types', async () => {
      const f = await addFile('A');
      await addChunk('A', f, 'alpha', 0.1);
      await addMemory('A', { content: 'alpha', angle: 0.1 });
      const { trace } = await run(planFor(['A']), req());
      expect(embeddings.calls).toEqual([['alpha']]);
      expect(trace.embeddingCalls).toBe(1);
    });
  });

  describe('result projection', () => {
    it('carries scope, source and provenance details and nothing else', async () => {
      const col = await addCollection('A', 'docs');
      const f = await addFile('A', { collectionId: col, name: 'guide.md' });
      const c = await addChunk('A', f, 'alpha chunk', 0.1);
      const m = await addMemory('A', { content: 'alpha memory', title: 'T', type: 'decision', angle: 0.1 });
      await tagMemory('A', m, 'red');
      await tagMemory('A', m, 'blue');
      const { response } = await run(planFor(['A']), req());
      const chunk = response.results.find((r) => r.id === c)!;
      const memory = response.results.find((r) => r.id === m)!;
      expect(chunk).toMatchObject({
        kind: 'chunk',
        file: { id: f, name: 'guide.md' },
        collectionId: col,
        ordinal: expect.any(Number),
        location: { startLine: 1, endLine: 2, section: 'Intro' },
        scope: { kind: 'workspace', id: wsA, slug: 'ws-a' },
      });
      expect(memory).toMatchObject({
        kind: 'memory',
        memoryType: 'decision',
        title: 'T',
        tags: ['blue', 'red'],
        status: 'active',
        provenance: { createdBy: { kind: 'admin', keyId: null, keyName: null }, client: null },
      });
      expect(Object.keys(response).sort()).toEqual(['results']);
      const json = JSON.stringify(response);
      for (const forbidden of ['embedding', 'total', 'count', 'excluded', 'storage', 'sha256', 'content_hash']) expect(json).not.toContain(forbidden);
    });
  });

  describe('provider failure', () => {
    it('degrades to keyword-only, including Memories without vectors, and leaks nothing', async () => {
      const f = await addFile('A');
      const c = await addChunk('A', f, 'alpha chunk', 0.1);
      const m = await addMemory('A', { content: 'alpha without vector', angle: null });
      const secret = 'provider-secret-error-text';
      const failing = new RetrievalService(ds, { dimension: DIM, model: 'x', embed: async () => Promise.reject(new Error(secret)) });
      const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
      const out = await failing.retrieveWithTrace(planFor(['A']), req({ query: 'alpha' }));
      expect(out.response.degraded).toBe('keyword_only');
      expect(new Set(ids(out.response))).toEqual(new Set([c, m]));
      expect(out.response.results.every((r) => r.vectorRank === null && r.keywordRank !== null)).toBe(true);
      expect(JSON.stringify(out)).not.toContain(secret);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    });

    it('does not mask database failures', async () => {
      await q(`ALTER TABLE chunks RENAME TO chunks_gone`);
      try {
        await expect(service.retrieve(planFor(['A'], ['files']), req())).rejects.toThrow();
        const failing = new RetrievalService(ds, { dimension: DIM, model: 'x', embed: async () => Promise.reject(new Error('x')) });
        await expect(failing.retrieve(planFor(['A'], ['files']), req())).rejects.toThrow();
      } finally {
        await q(`ALTER TABLE chunks_gone RENAME TO chunks`);
      }
    });
  });

  describe('selective filters fill the limit (AC-5)', () => {
    const EXCLUDED = 1300; // more than hnsw.ef_search can ever see (max 1000), all closer than every match
    const MATCHING = 15; // more than `limit`, fewer than 4 x limit candidates
    async function seed(table: 'chunks' | 'memories') {
      const f = table === 'chunks' ? await addFile('A') : null;
      const tagged = table === 'chunks' ? await addFile('A') : null;
      if (tagged) await tagFile('A', tagged, 'rare');
      const rows: { id?: string }[] = [];
      const insertBatch = async (count: number, angleFor: (i: number) => number, fileId: string | null, rare: boolean) => {
        for (let start = 0; start < count; start += 100) {
          const size = Math.min(100, count - start);
          const values: string[] = [];
          const params: unknown[] = [];
          for (let i = 0; i < size; i++) {
            const idx = start + i;
            const base = params.length;
            const content = `${rare ? 'rare' : 'common'} row ${idx} ${++n}`;
            if (table === 'chunks') {
              params.push(fileId, ++n, content, content.length, sha(content), lit(angled(angleFor(idx))));
              values.push(`('workspace','${wsA}',$${base + 1},$${base + 2},$${base + 3},'{"startOffset":0,"endOffset":1,"startLine":1,"endLine":1}',$${base + 4},$${base + 5},$${base + 6}::vector,'fake')`);
            } else {
              params.push(content, sha(content), lit(angled(angleFor(idx))));
              values.push(`('workspace','${wsA}','fact',$${base + 1},'admin',$${base + 2},$${base + 3}::vector,'ready','fake')`);
            }
          }
          await q(
            table === 'chunks'
              ? `INSERT INTO chunks (scope, workspace_id, file_id, ordinal, content, location, char_count, content_hash, embedding, embedding_model) VALUES ${values.join(',')}`
              : `INSERT INTO memories (scope, workspace_id, type, content, created_by_kind, content_hash, embedding, embedding_status, embedding_model) VALUES ${values.join(',')}`,
            params,
          );
        }
      };
      await insertBatch(EXCLUDED, (i) => 0.001 + i * 0.0001, f, false);
      await insertBatch(MATCHING, (i) => 1.0 + i * 0.01, tagged, true);
      void rows;
      if (table === 'memories') {
        const matching = await q(`SELECT id FROM memories WHERE content LIKE 'rare%'`);
        for (const r of matching) await tagMemory('A', r.id, 'rare');
      }
    }

    it.each(['chunks', 'memories'] as const)('returns `limit` %s although far closer rows are excluded by the filter', async (table) => {
      await seed(table);
      const type = table === 'chunks' ? 'files' : 'memories';
      if (table === 'chunks' && !/^(?:0\.[8-9]|0\.\d\d|[1-9])/.test(extVersion ?? '')) {
        // Control: without iterative scans a plain filtered HNSW query (what a naive implementation runs) underfills.
        const naive = await ds.transaction(async (m) => {
          await m.query(`SELECT set_config('hnsw.ef_search', '1000', true)`);
          return m.query(
            `SELECT c.id FROM chunks c JOIN files f ON f.id = c.file_id
              WHERE c.scope_key = $2 AND EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id AND t.name = 'rare')
              ORDER BY c.embedding <=> $1::vector LIMIT 10`,
            [lit(QUERY_VECTOR), wsA],
          );
        });
        expect(naive.length).toBeLessThan(10);
      }
      const { response, trace } = await run(planFor(['A'], [type]), req({ query: 'unmatchedterm', tags: ['rare'], limit: 10 }));
      expect(response.results).toHaveLength(10);
      expect(response.results.every((r) => r.content.startsWith('rare'))).toBe(true);
      // Nearest matching rows first.
      expect(response.results.map((r) => r.vectorRank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(trace.annStrategy).toBe(/^0\.(?:[0-7])\./.test(`${extVersion}.`) ? 'ef_search_then_exact' : 'iterative_scan');
      // 15 qualifying rows < 40 wanted candidates: the ANN branch underfills and the scoped exact scan runs.
      expect(trace.exactFallbacks).toBeGreaterThanOrEqual(1);
    }, 60_000);

    it('keeps scan settings local to the query transaction', async () => {
      const f = await addFile('A');
      await addChunk('A', f, 'alpha', 0.1);
      const before = (await q(`SELECT current_setting('hnsw.ef_search', true) AS v`))[0]!.v;
      for (let i = 0; i < 3; i++) {
        await run(planFor(['A']), req());
        const after = (await q(`SELECT current_setting('hnsw.ef_search', true) AS v, current_setting('hnsw.iterative_scan', true) AS it`))[0]!;
        expect(after.v).toBe(before);
        expect(['off', null, '']).toContain(after.it);
      }
      expect(before === null || Number(before) < 200).toBe(true);
    });
  });
});
