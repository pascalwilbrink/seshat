import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { assertEmbeddingDimension, EmbeddingDimensionError } from '../src/database/embedding-dimension-guard.js';
import { initializeDatabase } from '../src/database/bootstrap.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

const DIM = 1536;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const vec = (seed: number) => `[${Array.from({ length: DIM }, (_, i) => (i === seed ? 1 : 0)).join(',')}]`;

describeIntegration('chunks schema and startup dimension guard (real PostgreSQL + pgvector)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let wsA: string;
  let wsB: string;

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params) as Promise<Record<string, any>[]>;
  const addFile = async (workspaceId: string | null, name = 'f.md') =>
    (await q(
      `INSERT INTO files (scope, workspace_id, name, extension, mime_type, size_bytes, sha256, storage_key)
       VALUES ($1, $2, $3, 'md', 'text/markdown', 1, $4, $5) RETURNING id`,
      [workspaceId ? 'workspace' : 'global', workspaceId, name, sha(name), `k/${Math.random()}`],
    ))[0]!.id as string;
  const addChunk = (fileId: string, ordinal: number, over: { scope?: string; workspaceId?: string | null; content?: string; embedding?: string; hash?: string; charCount?: number } = {}) => {
    const content = over.content ?? `chunk ${ordinal}`;
    return q(
      `INSERT INTO chunks (scope, workspace_id, file_id, ordinal, content, location, char_count, content_hash, embedding, embedding_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, 'fake-model') RETURNING id`,
      [
        over.scope ?? 'global', over.workspaceId ?? null, fileId, ordinal, content,
        JSON.stringify({ section: 'S', headingPath: ['S'], startOffset: 0, endOffset: content.length, startLine: 1, endLine: 1 }),
        over.charCount ?? content.length, over.hash ?? sha(content), over.embedding ?? vec(ordinal),
      ],
    );
  };
  const count = async (where = 'true', params: unknown[] = []) => Number((await q(`SELECT count(*) c FROM chunks WHERE ${where}`, params))[0]!.c);

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource();
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
  });
  afterAll(async () => {
    await iso?.dispose();
  });
  beforeEach(async () => {
    await q('DELETE FROM files');
    await q('DELETE FROM workspaces');
    wsA = (await q(`INSERT INTO workspaces (name, slug) VALUES ('a', 'a') RETURNING id`))[0]!.id;
    wsB = (await q(`INSERT INTO workspaces (name, slug) VALUES ('b', 'b') RETURNING id`))[0]!.id;
  });

  it('has a vector(1536) embedding and the required metadata and scope columns', async () => {
    const cols = await q(
      `SELECT column_name, is_nullable, format_type(a.atttypid, a.atttypmod) AS type
         FROM information_schema.columns c JOIN pg_attribute a ON a.attrelid = to_regclass('chunks') AND a.attname = c.column_name
        WHERE table_schema = $1 AND table_name = 'chunks'`,
      [iso.schema],
    );
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    for (const c of ['id', 'file_id', 'scope', 'scope_key', 'ordinal', 'content', 'location', 'char_count', 'content_hash', 'embedding', 'embedding_model', 'created_at']) {
      expect(by[c], c).toBeDefined();
      expect(by[c].is_nullable, c).toBe('NO');
    }
    expect(by.workspace_id.is_nullable).toBe('YES');
    expect(by.workspace_id).toBeDefined();
    expect(by.embedding.type).toBe('vector(1536)');
    expect(by.location.type).toBe('jsonb');
    const fileCols = await q(`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'files' AND column_name IN ('indexed_at','chunk_count','ingestion_status','ingestion_error')`, [iso.schema]);
    expect(fileCols.map((c) => c.column_name).sort()).toEqual(['chunk_count', 'indexed_at', 'ingestion_error', 'ingestion_status']);
  });

  it('declares a cascading file foreign key, an HNSW cosine index, btree scope and file indexes and a unique ordinal', async () => {
    const fk = await q(`SELECT confdeltype, confupdtype FROM pg_constraint WHERE conname = 'FK_chunks_file_scope' AND conrelid = to_regclass('chunks')`);
    expect(fk).toEqual([{ confdeltype: 'c', confupdtype: 'r' }]);
    const idx = Object.fromEntries((await q(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'chunks'`, [iso.schema])).map((i) => [i.indexname, i.indexdef as string]));
    expect(idx.IDX_chunks_embedding_hnsw).toMatch(/USING hnsw \(embedding vector_cosine_ops\)/);
    expect(idx.IDX_chunks_scope_workspace_id).toMatch(/USING btree \(scope, workspace_id\)/);
    expect(idx.IDX_chunks_file_id).toMatch(/USING btree \(file_id\)/);
    expect(idx.UQ_chunks_file_id_ordinal).toMatch(/UNIQUE.*\(file_id, ordinal\)/);
  });

  it('round-trips a vector and answers a cosine nearest-neighbour query', async () => {
    const f = await addFile(null);
    await addChunk(f, 0);
    await addChunk(f, 1);
    const rows = await q(`SELECT ordinal, embedding::text AS e FROM chunks ORDER BY embedding <=> $1::vector LIMIT 1`, [vec(1)]);
    expect(rows[0]!.ordinal).toBe(1);
    const parsed = JSON.parse(rows[0]!.e as string) as number[];
    expect(parsed).toHaveLength(DIM);
    expect(parsed[1]).toBe(1);
  });

  it('rejects wrong dimensions, duplicate ordinals and malformed hash/count', async () => {
    const f = await addFile(null);
    await expect(addChunk(f, 0, { embedding: '[1,2,3]' })).rejects.toThrow(/dimensions/);
    await addChunk(f, 0);
    await expect(addChunk(f, 0)).rejects.toThrow(/UQ_chunks_file_id_ordinal/);
    await expect(addChunk(f, 1, { hash: 'nothex' })).rejects.toThrow(/CK_chunks_content_hash_format/);
    await expect(addChunk(f, 2, { charCount: 999 })).rejects.toThrow(/CK_chunks_char_count/);
    await expect(addChunk(f, -1)).rejects.toThrow(/CK_chunks_ordinal/);
  });

  it('rejects an invalid scope shape and a chunk whose scope disagrees with its file', async () => {
    const global = await addFile(null);
    const inA = await addFile(wsA);
    await expect(addChunk(global, 0, { scope: 'global', workspaceId: wsA })).rejects.toThrow(/CK_scope_workspace_consistency/);
    await expect(addChunk(inA, 0, { scope: 'workspace', workspaceId: null })).rejects.toThrow(/CK_scope_workspace_consistency/);
    await expect(addChunk(inA, 0, { scope: 'workspace', workspaceId: wsB })).rejects.toThrow(/FK_chunks_file_scope/);
    await expect(addChunk(inA, 0, { scope: 'global', workspaceId: null })).rejects.toThrow(/FK_chunks_file_scope/);
    await expect(addChunk(global, 0, { scope: 'workspace', workspaceId: wsA })).rejects.toThrow(/FK_chunks_file_scope/);
    await addChunk(inA, 0, { scope: 'workspace', workspaceId: wsA });
    expect(await count()).toBe(1);
  });

  it('deletes the chunks and vectors of a deleted file only', async () => {
    const a = await addFile(wsA, 'a.md');
    const b = await addFile(wsB, 'b.md');
    const g = await addFile(null, 'g.md');
    for (const [f, scope, workspaceId] of [[a, 'workspace', wsA], [b, 'workspace', wsB], [g, 'global', null]] as const) {
      await addChunk(f, 0, { scope, workspaceId });
      await addChunk(f, 1, { scope, workspaceId });
    }
    await q('DELETE FROM files WHERE id = $1', [a]);
    expect(await count('file_id = $1', [a])).toBe(0);
    expect(await count()).toBe(4);
    await q('DELETE FROM files WHERE workspace_id = $1', [wsB]);
    await q('DELETE FROM workspaces WHERE id = $1', [wsB]);
    expect(await count()).toBe(2);
    expect(await count('scope = $1', ['global'])).toBe(2);
  });

  it('a Workspace with chunks cannot be removed before its files (restricting FK)', async () => {
    const f = await addFile(wsA);
    await addChunk(f, 0, { scope: 'workspace', workspaceId: wsA });
    await expect(q('DELETE FROM workspaces WHERE id = $1', [wsA])).rejects.toThrow(/violates foreign key/);
  });

  describe('startup dimension guard against the physical column', () => {
    it('accepts the matching dimension', async () => {
      await expect(assertEmbeddingDimension(ds, DIM)).resolves.toBeUndefined();
      await expect(initializeDatabase(ds, { migrateOnStart: false, embeddingDimension: DIM })).resolves.toBe(ds);
    });

    it('refuses a mismatching configured dimension with a numeric, secret-free message', async () => {
      const err = await assertEmbeddingDimension(ds, 3072).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmbeddingDimensionError);
      expect((err as Error).message).toContain('EMBEDDING_DIMENSION is 3072');
      expect((err as Error).message).toContain('vector(1536)');
      await expect(initializeDatabase(ds, { migrateOnStart: false, embeddingDimension: 3072 })).rejects.toBeInstanceOf(EmbeddingDimensionError);
    });

    it('refuses a missing schema and, when the physical column differs from the entity, trusts the column', async () => {
      const other = createIsolatedSchema();
      const empty = await other;
      try {
        const eds = empty.createDataSource();
        await eds.initialize();
        await expect(assertEmbeddingDimension(eds, DIM)).rejects.toThrow(/does not exist.*migration:run/);
        await eds.query(`CREATE TABLE chunks (embedding "${iso.schema}".vector(8))`);
        await expect(assertEmbeddingDimension(eds, DIM)).rejects.toThrow(/vector\(8\)/);
        await eds.query('DROP TABLE chunks');
        await eds.query('CREATE TABLE chunks (embedding text)');
        await expect(assertEmbeddingDimension(eds, DIM)).rejects.toThrow(/not a vector/);
      } finally {
        await empty.dispose();
      }
    });
  });

  it('down removes chunks and the new file columns; up recreates them', async () => {
    await ds.undoLastMigration({ transaction: 'each' }); // file provenance
    await ds.undoLastMigration({ transaction: 'each' }); // keyword vectors
    await ds.undoLastMigration({ transaction: 'each' }); // memory embedding generation
    await ds.undoLastMigration({ transaction: 'each' }); // memories
    await ds.undoLastMigration({ transaction: 'each' });
    expect((await q(`SELECT to_regclass('chunks') AS t`))[0]!.t).toBeNull();
    expect(await q(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'files' AND column_name IN ('indexed_at','chunk_count')`, [iso.schema])).toEqual([]);
    expect((await ds.runMigrations({ transaction: 'each' })).map((m) => m.name)).toEqual(['CreateChunks1762800000000', 'CreateMemories1762900000000', 'AddMemoryEmbeddingGeneration1763000000000', 'AddKeywordSearchVectors1763100000000', 'AddFileProvenance1763200000000']);
    await expect(assertEmbeddingDimension(ds, DIM)).resolves.toBeUndefined();
  });
});
