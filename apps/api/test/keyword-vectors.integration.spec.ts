import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { ApiKey } from '../src/api-keys/api-key.entity.js';
import { Collection } from '../src/collections/collection.entity.js';
import { FileRecord } from '../src/files/file.entity.js';
import { FileTag } from '../src/tags/file-tag.entity.js';
import { MemoryTag } from '../src/memories/memory-tag.entity.js';
import { Tag } from '../src/tags/tag.entity.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { Chunk } from '../src/ingestion/chunk.entity.js';
import { Memory } from '../src/memories/memory.entity.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const DIM = 1536;
const vec = (i: number) => `[${Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0)).join(',')}]`;

/** AC-1: generated `simple` tsvector columns and GIN indexes for chunk content and Memory title + content. */
describeIntegration('keyword search vectors (real PostgreSQL with pgvector)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params) as Promise<Record<string, any>[]>;
  const migrationNames = () => ds.migrations.map((m) => m.constructor.name);

  const addFile = async () =>
    (await q(
      `INSERT INTO files (scope, workspace_id, name, extension, mime_type, size_bytes, sha256, storage_key)
       VALUES ('global', NULL, 'f.md', 'md', 'text/markdown', 1, $1, $2) RETURNING id`,
      [sha('f'), `k/${Math.random()}`],
    ))[0]!.id as string;
  let ordinal = 0;
  const addChunk = async (fileId: string, content: string) => {
    ordinal += 1;
    return (await q(
      `INSERT INTO chunks (scope, workspace_id, file_id, ordinal, content, location, char_count, content_hash, embedding, embedding_model)
       VALUES ('global', NULL, $1, $2, $3, '{"startOffset":0,"endOffset":1,"startLine":1,"endLine":1}', $4, $5, $6::vector, 'fake')
       RETURNING id`,
      [fileId, ordinal, content, content.length, sha(content), vec(ordinal)],
    ))[0]!.id as string;
  };
  const addMemory = async (title: string | null, content: string) =>
    (await q(
      `INSERT INTO memories (scope, workspace_id, type, content, title, created_by_kind, content_hash)
       VALUES ('global', NULL, 'fact', $1, $2, 'admin', $3) RETURNING id`,
      [content, title, sha(content + (title ?? ''))],
    ))[0]!.id as string;
  const chunkHits = async (query: string) =>
    (await q(`SELECT id FROM chunks WHERE content_tsv @@ websearch_to_tsquery('simple', $1)`, [query])).map((r) => r.id as string);
  const memoryHits = async (query: string) =>
    (await q(`SELECT id FROM memories WHERE search_tsv @@ websearch_to_tsquery('simple', $1)`, [query])).map((r) => r.id as string);

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey, Collection, Tag, FileTag, FileRecord, Chunk, Memory, MemoryTag]);
    await ds.initialize();
    // Everything before the keyword migration, so existing rows can be backfilled by it.
    await ds.runMigrations({ transaction: 'each' });
    await ds.undoLastMigration({ transaction: 'each' }); // usage
    await ds.undoLastMigration({ transaction: 'each' }); // file provenance
    await ds.undoLastMigration({ transaction: 'each' }); // keyword vectors
  });
  afterAll(async () => {
    await iso?.dispose();
  });

  it('is discovered as the third to last migration', () => {
    expect(migrationNames().at(-3)).toBe('AddKeywordSearchVectors1763100000000');
  });

  it('indexes rows that existed before the migration', async () => {
    const f = await addFile();
    const oldChunk = await addChunk(f, 'Legacy chunk about ZX-4411-QR');
    const oldMemory = await addMemory(null, 'Legacy memory without title');
    await ds.runMigrations({ transaction: 'each' });
    expect(await chunkHits('legacy')).toContain(oldChunk);
    expect(await memoryHits('legacy')).toContain(oldMemory);
  });

  it('has stored generated tsvector columns with an explicit simple configuration', async () => {
    const cols = await q(
      `SELECT c.relname AS tbl, a.attname AS col, a.attgenerated AS gen, format_type(a.atttypid, a.atttypmod) AS type,
              pg_get_expr(d.adbin, d.adrelid) AS expr
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = $1
         JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attname IN ('content_tsv', 'search_tsv') ORDER BY c.relname`,
      [iso.schema],
    );
    expect(cols.map((c) => [c.tbl, c.col, c.gen, c.type])).toEqual([
      ['chunks', 'content_tsv', 's', 'tsvector'],
      ['memories', 'search_tsv', 's', 'tsvector'],
    ]);
    expect(cols[0]!.expr).toMatch(/to_tsvector\('simple'::regconfig, content\)/);
    expect(cols[1]!.expr).toMatch(/^to_tsvector\('simple'::regconfig, .*COALESCE\(title, ''::character varying\).*\|\| content/);
  });

  it('has GIN indexes on exactly those columns, next to the untouched HNSW indexes', async () => {
    const idx = await q(
      `SELECT indexname, am.amname AS method, indexdef FROM pg_indexes i
         JOIN pg_class c ON c.relname = i.indexname JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
         JOIN pg_am am ON am.oid = c.relam
        WHERE i.schemaname = $1 AND i.indexname IN ('IDX_chunks_content_tsv_gin','IDX_memories_search_tsv_gin','IDX_chunks_embedding_hnsw') ORDER BY i.indexname`,
      [iso.schema],
    );
    expect(idx.map((i) => [i.indexname, i.method])).toEqual([
      ['IDX_chunks_content_tsv_gin', 'gin'],
      ['IDX_chunks_embedding_hnsw', 'hnsw'],
      ['IDX_memories_search_tsv_gin', 'gin'],
    ]);
    expect(idx[0]!.indexdef).toContain('(content_tsv)');
    expect(idx[2]!.indexdef).toContain('(search_tsv)');
  });

  it('finds mixed Dutch/English text and identifiers in chunks, without stemming', async () => {
    const f = await addFile();
    const id = await addChunk(f, 'De deployment van ORDER-2024-0042 faalde; the rollback werkte wel. Mail naar ops@example.nl');
    expect(await chunkHits('deployment rollback')).toContain(id);
    expect(await chunkHits('ORDER-2024-0042')).toContain(id);
    expect(await chunkHits('order-2024-0042')).toContain(id);
    expect(await chunkHits('faalde werkte')).toContain(id);
    expect(await chunkHits('"the rollback"')).toContain(id);
    expect(await chunkHits('deploy')).not.toContain(id); // simple: no stemming
    expect(await chunkHits('ORDER-2024-9999')).not.toContain(id);
  });

  it('indexes Memory title and content, and treats a null title as empty', async () => {
    const withTitle = await addMemory('Vaste regel: Release-Freeze', 'Geen deploys on friday');
    const noTitle = await addMemory(null, 'Alleen content met INC-7781');
    expect(await memoryHits('freeze')).toEqual([withTitle]);
    expect(await memoryHits('friday')).toContain(withTitle);
    expect(await memoryHits('"release-freeze" friday')).toEqual([withTitle]);
    expect(await memoryHits('INC-7781')).toEqual([noTitle]);
    const [row] = await q(`SELECT search_tsv::text AS t FROM memories WHERE id = $1`, [noTitle]);
    expect(row!.t).not.toContain('null');
  });

  it('recomputes on content and title updates, and a title can be cleared to null', async () => {
    const f = await addFile();
    const c = await addChunk(f, 'oorspronkelijk alpha');
    await q(`UPDATE chunks SET content = 'bravo vervangen', char_count = 15, content_hash = $2 WHERE id = $1`, [c, sha('bravo')]);
    expect(await chunkHits('alpha')).not.toContain(c);
    expect(await chunkHits('bravo')).toContain(c);

    const m = await addMemory('Charlie titel', 'delta inhoud');
    expect(await memoryHits('charlie')).toContain(m);
    await q(`UPDATE memories SET title = 'Echo titel' WHERE id = $1`, [m]);
    expect(await memoryHits('charlie')).not.toContain(m);
    expect(await memoryHits('echo')).toContain(m);
    await q(`UPDATE memories SET title = NULL WHERE id = $1`, [m]);
    expect(await memoryHits('echo')).not.toContain(m);
    expect(await memoryHits('delta')).toContain(m);
    await q(`UPDATE memories SET content = 'foxtrot' WHERE id = $1`, [m]);
    expect(await memoryHits('delta')).not.toContain(m);
    expect(await memoryHits('foxtrot')).toContain(m);
  });

  it('rejects application writes to the generated columns', async () => {
    const f = await addFile();
    const c = await addChunk(f, 'golf');
    const m = await addMemory(null, 'hotel');
    await expect(q(`UPDATE chunks SET content_tsv = to_tsvector('simple', 'x') WHERE id = $1`, [c])).rejects.toMatchObject({ driverError: { code: '428C9' } });
    await expect(q(`UPDATE memories SET search_tsv = to_tsvector('simple', 'x') WHERE id = $1`, [m])).rejects.toMatchObject({ driverError: { code: '428C9' } });
  });

  it('uses the GIN indexes for keyword queries', async () => {
    await q('SET enable_seqscan = off');
    try {
      const plan = (await q(`EXPLAIN SELECT id FROM chunks WHERE content_tsv @@ websearch_to_tsquery('simple', 'rollback')`)).map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toContain('IDX_chunks_content_tsv_gin');
    } finally {
      await q('RESET enable_seqscan');
    }
  });

  it('entities map the generated columns as read-only and unselected, so ORM writes never include them', async () => {
    const repo = ds.getRepository(Chunk);
    const col = repo.metadata.findColumnWithPropertyName('contentTsv')!;
    expect(col.databaseName).toBe('content_tsv');
    expect([col.isInsert, col.isUpdate, col.isSelect]).toEqual([false, false, false]);
    const mcol = ds.getRepository(Memory).metadata.findColumnWithPropertyName('searchTsv')!;
    expect(mcol.databaseName).toBe('search_tsv');
    expect([mcol.isInsert, mcol.isUpdate, mcol.isSelect]).toEqual([false, false, false]);
    const f = await addFile();
    const id = await addChunk(f, 'india');
    const loaded = await repo.findOneByOrFail({ id });
    expect(loaded.content).toBe('india');
    await repo.save({ ...loaded, content: 'juliet', charCount: 6, contentHash: sha('juliet') });
    expect(await chunkHits('juliet')).toContain(id);
  });

  it('keeps scope, ownership and vector constraints intact', async () => {
    const f = await addFile();
    await expect(
      q(`INSERT INTO chunks (scope, workspace_id, file_id, ordinal, content, location, char_count, content_hash, embedding, embedding_model)
         VALUES ('workspace', gen_random_uuid(), $1, 999, 'x', '{}', 1, $2, $3::vector, 'fake')`, [f, sha('x'), vec(1)]),
    ).rejects.toBeDefined();
    const names = (await q(`SELECT conname FROM pg_constraint WHERE conrelid = to_regclass('chunks') AND conname IN ('CK_scope_workspace_consistency','FK_chunks_file_scope')`)).map((r) => r.conname).sort();
    expect(names).toEqual(['CK_scope_workspace_consistency', 'FK_chunks_file_scope']);
  });

  it('down removes the columns and indexes only; up restores them and reindexes existing rows', async () => {
    const f = await addFile();
    const c = await addChunk(f, 'kilo roundtrip');
    await ds.undoLastMigration({ transaction: 'each' }); // file provenance
    await ds.undoLastMigration({ transaction: 'each' }); // keyword vectors
    expect(await q(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND column_name IN ('content_tsv','search_tsv')`, [iso.schema])).toEqual([]);
    expect(await q(`SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname LIKE '%tsv_gin'`, [iso.schema])).toEqual([]);
    expect(await q(`SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'IDX_chunks_embedding_hnsw'`, [iso.schema])).toHaveLength(1);
    expect((await q(`SELECT content FROM chunks WHERE id = $1`, [c]))[0]!.content).toBe('kilo roundtrip');
    expect((await ds.runMigrations({ transaction: 'each' })).map((m) => m.name)).toEqual(['AddKeywordSearchVectors1763100000000', 'AddFileProvenance1763200000000', 'CreateUsage1763300000000']);
    expect(await chunkHits('roundtrip')).toContain(c);
  });
});
