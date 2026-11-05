import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { ApiKey } from '../src/api-keys/api-key.entity.js';
import { Memory } from '../src/memories/memory.entity.js';
import { MemoryTag } from '../src/memories/memory-tag.entity.js';
import { memoryContentHash } from '../src/memories/memory-content.js';
import { Tag } from '../src/tags/tag.entity.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

const DIM = 1536;
const vec = (i: number) => `[${Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0)).join(',')}]`;

/** AC-1, AC-2 (uniqueness) and AC-8 persistence: scope-safe Memories, shared tag joins and supersession links in PostgreSQL. */
describeIntegration('Memories model (real PostgreSQL with pgvector)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let wsA: string;
  let wsB: string;
  let n = 0;

  const rejects = async (p: Promise<unknown>, code: string, constraint?: string) => {
    const err = (await p.then(
      () => undefined,
      (e: unknown) => e,
    )) as { driverError?: { code?: string; constraint?: string } } | undefined;
    expect(err, 'expected the statement to be rejected').toBeDefined();
    expect(err?.driverError?.code).toBe(code);
    if (constraint) expect(err?.driverError?.constraint).toBe(constraint);
  };
  const addWorkspace = async (slug: string) =>
    ((await ds.query('INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id', [slug])) as { id: string }[])[0]!.id;
  const addTag = async (ws: string | null, name: string) =>
    ((await ds.query('INSERT INTO tags (scope, workspace_id, name) VALUES ($1, $2, $3) RETURNING id', [ws ? 'workspace' : 'global', ws, name])) as { id: string }[])[0]!.id;

  /** Inserts a Memory with a unique content by default; `o` overrides any column (snake_case). */
  const add = async (ws: string | null, o: Record<string, unknown> = {}) => {
    n += 1;
    const content = (o.content as string | undefined) ?? `memory ${n}`;
    const row: Record<string, unknown> = {
      scope: ws ? 'workspace' : 'global',
      workspace_id: ws,
      type: 'fact',
      content,
      created_by_kind: 'admin',
      content_hash: memoryContentHash(content),
      ...o,
    };
    const cols = Object.keys(row);
    const rows = (await ds.query(
      `INSERT INTO memories (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map((c) => row[c]),
    )) as { id: string }[];
    return rows[0]!.id;
  };
  const link = (memoryId: string, tagId: string, scopeKey: string) =>
    ds.query('INSERT INTO memory_tags (memory_id, tag_id, scope_key) VALUES ($1, $2, $3)', [memoryId, tagId, scopeKey]);
  const supersede = (oldId: string, newId: string) =>
    ds.query(`UPDATE memories SET status = 'superseded', superseded_by = $2 WHERE id = $1`, [oldId, newId]);
  const row = async (id: string) => ((await ds.query('SELECT * FROM memories WHERE id = $1', [id])) as Record<string, unknown>[])[0];

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey, Tag, Memory, MemoryTag]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    wsA = await addWorkspace('alpha');
    wsB = await addWorkspace('beta');
  });

  afterAll(async () => {
    await iso?.dispose();
  });

  it('has the scope columns, the vector(1536) column, indexes and the active-only unique index', async () => {
    const check = await iso.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"${iso.schema}"."memories"'::regclass AND conname = 'CK_scope_workspace_consistency'`,
    );
    expect(check).toHaveLength(1);
    const col = await iso.query(
      `SELECT format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull FROM pg_attribute a
       WHERE a.attrelid = '"${iso.schema}"."memories"'::regclass AND a.attname = 'embedding'`,
    );
    expect(col[0]?.type).toBe('vector(1536)');
    expect(col[0]?.attnotnull).toBe(false);
    const idx = Object.fromEntries(
      (await iso.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = '${iso.schema}' AND tablename = 'memories'`)).map((i) => [i.indexname, i.indexdef as string]),
    );
    expect(idx.UQ_memories_active_scope_key_type_content_hash).toMatch(/UNIQUE.*\(scope_key, type, content_hash\).*WHERE.*status.*active/);
    expect(idx.IDX_memories_scope_key_created_at_id).toMatch(/\(scope_key, created_at DESC, id DESC\)/);
    expect(idx.IDX_memories_embedding_hnsw).toMatch(/USING hnsw \(embedding vector_cosine_ops\)/);
    const mt = await iso.query(`SELECT conname FROM pg_constraint WHERE conrelid = '"${iso.schema}"."memory_tags"'::regclass AND contype = 'f' ORDER BY conname`);
    expect(mt.map((c) => c.conname)).toEqual(['FK_memory_tags_memory_scope', 'FK_memory_tags_tag_scope']);
  });

  it('round-trips all six types with every column and a vector', async () => {
    for (const type of ['fact', 'decision', 'preference', 'experience', 'procedure', 'context']) {
      await add(wsA, { type, content: `round trip ${type}` });
    }
    const id = await add(null, {
      content: 'full record',
      title: 'Title',
      metadata: JSON.stringify({ a: [1, 'é'] }),
      confidence: 0.25,
      source: 'conversation',
      created_by_kind: 'api_key',
      created_by_key_id: '11111111-1111-4111-8111-111111111111',
      created_by_key_name: 'agent key',
      client_name: 'claude',
      client_version: '1.2.3',
      embedding: vec(3),
      embedding_model: 'text-embedding-3-small',
      embedding_status: 'ready',
    });
    const r = (await row(id))!;
    expect(r).toMatchObject({
      scope: 'global',
      workspace_id: null,
      scope_key: 'global',
      title: 'Title',
      metadata: { a: [1, 'é'] },
      confidence: 0.25,
      source: 'conversation',
      status: 'active',
      superseded_by: null,
      created_by_kind: 'api_key',
      created_by_key_name: 'agent key',
      client_name: 'claude',
      client_version: '1.2.3',
      embedding_model: 'text-embedding-3-small',
      embedding_status: 'ready',
    });
    expect(r.content_hash).toBe(memoryContentHash('full record'));
    expect(r.created_at).toBeInstanceOf(Date);
    expect(r.updated_at).toBeInstanceOf(Date);
    const [{ e }] = (await ds.query('SELECT embedding::text AS e FROM memories WHERE id = $1', [id])) as { e: string }[];
    expect((JSON.parse(e) as number[])[3]).toBe(1);
    const types = await ds.query('SELECT DISTINCT type FROM memories WHERE workspace_id = $1', [wsA]);
    expect(types).toHaveLength(6);
  });

  it('defaults to pending embedding with no vector and rejects inconsistent embedding state and wrong dimensions', async () => {
    const id = await add(wsA);
    expect(await row(id)).toMatchObject({ embedding: null, embedding_status: 'pending', embedding_model: null });
    await rejects(add(wsA, { embedding_status: 'ready' }), '23514', 'CK_memories_embedding_ready_consistency');
    await rejects(add(wsA, { embedding: vec(0), embedding_model: 'm', embedding_status: 'pending' }), '23514', 'CK_memories_embedding_ready_consistency');
    await rejects(add(wsA, { embedding_status: 'weird' }), '23514', 'CK_memories_embedding_status');
    await expect(add(wsA, { embedding: '[1,2,3]', embedding_model: 'm', embedding_status: 'ready' })).rejects.toThrow(/dimensions/);
  });

  it('rejects invalid values', async () => {
    await rejects(add(wsA, { type: 'note' }), '23514', 'CK_memories_type');
    await rejects(add(wsA, { content: '' }), '23514', 'CK_memories_content_length');
    await rejects(add(wsA, { content: 'x'.repeat(10001) }), '23514', 'CK_memories_content_length');
    await add(wsA, { content: 'y'.repeat(10000) });
    await rejects(add(wsA, { title: 'x'.repeat(201) }), '22001');
    await rejects(add(wsA, { title: '' }), '23514', 'CK_memories_title_length');
    await rejects(add(wsA, { metadata: JSON.stringify([1]) }), '23514', 'CK_memories_metadata_object');
    await rejects(add(wsA, { metadata: JSON.stringify({ k: 'x'.repeat(8200) }) }), '23514', 'CK_memories_metadata_size');
    await rejects(add(wsA, { confidence: 1.01 }), '23514', 'CK_memories_confidence_range');
    await rejects(add(wsA, { confidence: -0.01 }), '23514', 'CK_memories_confidence_range');
    await add(wsA, { confidence: 0 });
    await add(wsA, { confidence: 1 });
    await rejects(add(wsA, { source: 'x'.repeat(501) }), '22001');
    await rejects(add(wsA, { status: 'deleted' }), '23514', 'CK_memories_status');
    await rejects(add(wsA, { content_hash: 'nothex' }), '23514', 'CK_memories_content_hash_format');
    await rejects(add(wsA, { created_by_kind: 'api_key' }), '23514', 'CK_memories_created_by_consistency');
    await rejects(add(wsA, { created_by_key_id: '11111111-1111-4111-8111-111111111111', created_by_key_name: 'k' }), '23514', 'CK_memories_created_by_consistency');
    await rejects(add(wsA, { client_version: '1.0' }), '23514', 'CK_memories_client_version_length');
    await rejects(add(wsA, { scope: 'global' }), '23514', 'CK_scope_workspace_consistency');
    await rejects(add(null, { scope: 'workspace' }), '23514', 'CK_scope_workspace_consistency');
  });

  it('allows one active memory per scope, type and normalized hash, in Global and in Workspaces', async () => {
    for (const ws of [null, wsA]) {
      await add(ws, { content: 'Dedup  me', content_hash: memoryContentHash('Dedup me') });
      await rejects(add(ws, { content: 'Dedup me again', content_hash: memoryContentHash('Dedup  me') }), '23505', 'UQ_memories_active_scope_key_type_content_hash');
      await add(ws, { content: 'Dedup me', type: 'decision', content_hash: memoryContentHash('Dedup me') }); // other type
    }
    await add(wsB, { content: 'Dedup me', content_hash: memoryContentHash('Dedup me') }); // other scope
    await add(wsA, { content: 'dedup me', content_hash: memoryContentHash('dedup me') }); // distinct case
  });

  it('lets a superseded record share a hash with an active one, and a new active duplicate after supersession', async () => {
    const old = await add(wsA, { content: 'versioned' });
    const next = await add(wsA, { content: 'versioned v2' });
    await supersede(old, next);
    await add(wsA, { content: 'versioned' }); // old is no longer active
    await rejects(add(wsA, { content: 'versioned v2' }), '23505', 'UQ_memories_active_scope_key_type_content_hash');
    await rejects(ds.query(`UPDATE memories SET status = 'active' WHERE id = $1`, [old]), '23505', 'UQ_memories_active_scope_key_type_content_hash');
  });

  it('enforces same-scope successors, no self-links and no link on an active record', async () => {
    const a = await add(wsA);
    const b = await add(wsA);
    const other = await add(wsB);
    const global = await add(null);
    await rejects(supersede(a, other), '23503', 'FK_memories_superseded_by_scope');
    await rejects(supersede(a, global), '23503', 'FK_memories_superseded_by_scope');
    await rejects(supersede(a, a), '23514', 'CK_memories_no_self_supersession');
    await rejects(ds.query('UPDATE memories SET superseded_by = $2 WHERE id = $1', [a, b]), '23514', 'CK_memories_link_requires_superseded');
    await rejects(supersede(a, '22222222-2222-4222-8222-222222222222'), '23503', 'FK_memories_superseded_by_scope');
    await supersede(a, b);
    expect(await row(a)).toMatchObject({ status: 'superseded', superseded_by: b });
  });

  it('clears incoming links on hard delete, keeps predecessors superseded and does not delete an independent successor', async () => {
    const p1 = await add(wsA);
    const p2 = await add(wsA);
    const successor = await add(wsA);
    const independent = await add(wsA);
    await supersede(p1, successor);
    await supersede(p2, successor);
    await supersede(successor, independent); // successor itself superseded another-way round
    await ds.query('DELETE FROM memories WHERE id = $1', [successor]);
    expect(await row(p1)).toMatchObject({ status: 'superseded', superseded_by: null });
    expect(await row(p2)).toMatchObject({ status: 'superseded', superseded_by: null });
    expect(await row(independent)).toMatchObject({ status: 'active' });
    // Forgetting the newest record of a chain leaves its own predecessor superseded and unlinked.
    const x = await add(wsB);
    const y = await add(wsB);
    await supersede(x, y);
    await ds.query('DELETE FROM memories WHERE id = $1', [y]);
    expect(await row(x)).toMatchObject({ status: 'superseded', superseded_by: null });
  });

  it('joins memories to the shared tags table within one scope only and cascades on either side', async () => {
    const m = await add(wsA);
    const sameScope = await addTag(wsA, 'topic');
    const foreign = await addTag(wsB, 'topic');
    const globalTag = await addTag(null, 'topic');
    await link(m, sameScope, wsA);
    await rejects(link(m, foreign, wsA), '23503', 'FK_memory_tags_tag_scope');
    await rejects(link(m, globalTag, wsA), '23503', 'FK_memory_tags_tag_scope');
    await rejects(link(m, foreign, wsB), '23503', 'FK_memory_tags_memory_scope');
    await rejects(link(m, sameScope, wsA), '23505');
    const gm = await add(null);
    await link(gm, globalTag, 'global');
    await rejects(link(gm, sameScope, 'global'), '23503');

    const m2 = await add(wsA);
    await link(m2, sameScope, wsA);
    await ds.query('DELETE FROM memories WHERE id = $1', [m2]);
    expect(await ds.query('SELECT 1 FROM memory_tags WHERE memory_id = $1', [m2])).toHaveLength(0);
    expect(await ds.query('SELECT 1 FROM memory_tags WHERE memory_id = $1', [m])).toHaveLength(1);
    await ds.query('DELETE FROM tags WHERE id = $1', [sameScope]);
    expect(await ds.query('SELECT 1 FROM memory_tags WHERE memory_id = $1', [m])).toHaveLength(0);
    expect(await row(m)).toBeDefined();
  });

  it('a Workspace with memories cannot be removed before them (restricting FK)', async () => {
    const ws = await addWorkspace('restricted');
    await add(ws);
    await rejects(ds.query('DELETE FROM workspaces WHERE id = $1', [ws]), '23503', 'FK_memories_workspace_id');
    await ds.query('DELETE FROM memories WHERE workspace_id = $1', [ws]);
    await ds.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  });
});
