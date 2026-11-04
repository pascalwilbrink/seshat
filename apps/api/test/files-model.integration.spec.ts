import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { ApiKey } from '../src/api-keys/api-key.entity.js';
import { Collection } from '../src/collections/collection.entity.js';
import { Tag } from '../src/tags/tag.entity.js';
import { FileTag } from '../src/tags/file-tag.entity.js';
import { FileRecord } from '../src/files/file.entity.js';
import {
  TEST_DATABASE_URL,
  assertDisposableDatabase,
  createIsolatedSchema,
  describeIntegration,
  type IsolatedSchema,
} from './helpers/integration.js';

/** AC-6 and AC-7 persistence: scope-safe Collections, shared Tags and file_tags, enforced by PostgreSQL itself. */
describeIntegration('Files, Collections and Tags model (real PostgreSQL)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let wsA: string;
  let wsB: string;
  let seq = 0;

  const rejects = async (p: Promise<unknown>, code: string, constraint?: string) => {
    const err = (await p.then(
      () => undefined,
      (e: unknown) => e,
    )) as { driverError?: { code?: string; constraint?: string } } | undefined;
    expect(err, 'expected the statement to be rejected').toBeDefined();
    expect(err?.driverError?.code).toBe(code);
    if (constraint) expect(err?.driverError?.constraint).toBe(constraint);
  };

  const scopeOf = (workspaceId: string | null) => ({ scope: workspaceId ? 'workspace' : 'global', workspaceId });
  const addWorkspace = async (slug: string) =>
    ((await ds.query('INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id', [slug])) as { id: string }[])[0]!.id;
  const addCollection = async (workspaceId: string | null, name: string) =>
    ((await ds.query('INSERT INTO collections (scope, workspace_id, name) VALUES ($1, $2, $3) RETURNING id', [
      scopeOf(workspaceId).scope,
      workspaceId,
      name,
    ])) as { id: string }[])[0]!.id;
  const addTag = async (workspaceId: string | null, name: string) =>
    ((await ds.query('INSERT INTO tags (scope, workspace_id, name) VALUES ($1, $2, $3) RETURNING id', [
      scopeOf(workspaceId).scope,
      workspaceId,
      name,
    ])) as { id: string }[])[0]!.id;
  const addFile = async (workspaceId: string | null, collectionId: string | null = null, extra: Record<string, unknown> = {}) => {
    seq += 1;
    const row = {
      name: 'a.txt',
      extension: 'txt',
      mime_type: 'text/plain',
      size_bytes: 3,
      sha256: 'a'.repeat(64),
      storage_key: `k/${seq}/${Math.random()}`,
      ...extra,
    };
    return ((await ds.query(
      `INSERT INTO files (scope, workspace_id, name, extension, mime_type, size_bytes, sha256, storage_key, collection_id${
        row.ingestion_status ? ', ingestion_status' : ''
      }) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9${row.ingestion_status ? ', $10' : ''}) RETURNING id`,
      [
        scopeOf(workspaceId).scope,
        workspaceId,
        row.name,
        row.extension,
        row.mime_type,
        row.size_bytes,
        row.sha256,
        row.storage_key,
        collectionId,
        ...(row.ingestion_status ? [row.ingestion_status] : []),
      ],
    )) as { id: string }[])[0]!.id;
  };
  const tagFile = (fileId: string, tagId: string, scopeKey: string) =>
    ds.query('INSERT INTO file_tags (file_id, tag_id, scope_key) VALUES ($1, $2, $3)', [fileId, tagId, scopeKey]);

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey, Collection, Tag, FileTag, FileRecord]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    wsA = await addWorkspace('alpha');
    wsB = await addWorkspace('beta');
  });

  afterAll(async () => {
    await iso?.dispose();
  });

  it('creates the four tables with scope columns, the consistency check and restricting Workspace FKs', async () => {
    for (const table of ['collections', 'tags', 'files']) {
      const checks = await iso.query(
        `SELECT conname FROM pg_constraint WHERE conrelid = '"${iso.schema}"."${table}"'::regclass AND contype = 'c' AND conname = 'CK_scope_workspace_consistency'`,
      );
      expect(checks, table).toHaveLength(1);
      const fk = await iso.query(
        `SELECT confdeltype FROM pg_constraint WHERE conrelid = '"${iso.schema}"."${table}"'::regclass AND conname = 'FK_${table}_workspace_id'`,
      );
      expect(fk[0]?.confdeltype, table).toBe('r');
      const idx = await iso.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = '${iso.schema}' AND tablename = '${table}' AND indexdef LIKE '%(scope, workspace_id)%'`,
      );
      expect(idx, table).toHaveLength(1);
    }
    await rejects(
      ds.query(`INSERT INTO collections (scope, workspace_id, name) VALUES ('global', $1, 'x')`, [wsA]),
      '23514',
      'CK_scope_workspace_consistency',
    );
    await rejects(
      ds.query(`INSERT INTO tags (scope, workspace_id, name) VALUES ('workspace', NULL, 'x')`),
      '23514',
      'CK_scope_workspace_consistency',
    );
    await rejects(
      ds.query(`INSERT INTO collections (scope, workspace_id, name) VALUES ('workspace', gen_random_uuid(), 'x')`),
      '23503',
      'FK_collections_workspace_id',
    );
  });

  it('has a column in the migrated tables for every entity column (names and snake_case)', async () => {
    for (const entity of [Collection, Tag, FileTag, FileRecord]) {
      const meta = ds.getMetadata(entity);
      const cols = await iso.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = '${iso.schema}' AND table_name = '${meta.tableName}'`,
      );
      const have = new Set(cols.map((c) => c.column_name));
      for (const column of meta.columns) expect(have.has(column.databaseName), `${meta.tableName}.${column.databaseName}`).toBe(true);
    }
  });

  describe('Collections', () => {
    it('are optional and bounded, with a description and timestamps', async () => {
      const id = await addCollection(wsA, 'Papers');
      const [row] = await iso.query(`SELECT * FROM "${iso.schema}".collections WHERE id = '${id}'`);
      expect(row.description).toBeNull();
      expect(row.created_at).toBeInstanceOf(Date);
      expect(row.updated_at).toBeInstanceOf(Date);
      await rejects(addCollection(wsA, ''), '23514', 'CK_collections_name_length');
      await rejects(addCollection(wsA, '   '), '23514', 'CK_collections_name_not_blank');
      await rejects(addCollection(wsA, 'x'.repeat(101)), '22001');
      await addCollection(wsA, 'y'.repeat(100));
    });

    it('are unique per scope, case-insensitively, including Global (NULL workspace_id)', async () => {
      await addCollection(wsA, 'Reports');
      await rejects(addCollection(wsA, 'reports'), '23505', 'UQ_collections_scope_key_lower_name');
      await rejects(addCollection(wsA, 'REPORTS'), '23505', 'UQ_collections_scope_key_lower_name');
      await addCollection(wsB, 'Reports'); // another Workspace
      await addCollection(null, 'Reports'); // Global
      await rejects(addCollection(null, 'rEpOrTs'), '23505', 'UQ_collections_scope_key_lower_name');
      await rejects(addCollection(null, 'REPORTS'), '23505', 'UQ_collections_scope_key_lower_name');
    });

    it('serializes concurrent creation of the same name into exactly one row', async () => {
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => addCollection(wsB, 'Race')));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      for (const r of rejected) expect((r.reason as { driverError?: { code?: string } }).driverError?.code).toBe('23505');
    });
  });

  describe('files', () => {
    it('default to pending, keep a nullable error and Collection, and store all metadata', async () => {
      const id = await addFile(wsA);
      const [row] = await iso.query(`SELECT * FROM "${iso.schema}".files WHERE id = '${id}'`);
      expect(row).toMatchObject({
        ingestion_status: 'pending',
        ingestion_error: null,
        collection_id: null,
        name: 'a.txt',
        extension: 'txt',
        mime_type: 'text/plain',
        sha256: 'a'.repeat(64),
        scope: 'workspace',
        workspace_id: wsA,
      });
      expect(Number(row.size_bytes)).toBe(3);
      expect(row.created_at).toBeInstanceOf(Date);
      expect(row.updated_at).toBeInstanceOf(Date);
      const globalId = await addFile(null);
      const [g] = await iso.query(`SELECT scope, workspace_id, scope_key FROM "${iso.schema}".files WHERE id = '${globalId}'`);
      expect(g).toEqual({ scope: 'global', workspace_id: null, scope_key: 'global' });
    });

    it('accepts only the four ingestion statuses and well-formed metadata', async () => {
      for (const s of ['pending', 'processing', 'indexed', 'failed']) await addFile(wsA, null, { ingestion_status: s });
      await rejects(addFile(wsA, null, { ingestion_status: 'done' }), '23514', 'CK_files_ingestion_status');
      await rejects(addFile(wsA, null, { sha256: 'A'.repeat(64) }), '23514', 'CK_files_sha256_format');
      await rejects(addFile(wsA, null, { sha256: 'a'.repeat(63) }), '23514', 'CK_files_sha256_format');
      await rejects(addFile(wsA, null, { size_bytes: -1 }), '23514', 'CK_files_size_bytes');
      await rejects(addFile(wsA, null, { extension: 'TXT' }), '23514', 'CK_files_extension_format');
      await rejects(addFile(wsA, null, { name: '' }), '23514', 'CK_files_name_length');
      await addFile(wsA, null, { extension: null });
    });

    it('never share a storage key', async () => {
      await addFile(wsA, null, { storage_key: 'dup/key' });
      await rejects(addFile(wsB, null, { storage_key: 'dup/key' }), '23505', 'UQ_files_storage_key');
    });

    it('join a Collection of their own scope, in a Workspace and in Global', async () => {
      const inA = await addCollection(wsA, 'Own A');
      const inGlobal = await addCollection(null, 'Own Global');
      const fileA = await addFile(wsA, inA);
      const fileG = await addFile(null, inGlobal);
      const rows = await iso.query(`SELECT id, collection_id FROM "${iso.schema}".files WHERE id IN ('${fileA}', '${fileG}')`);
      expect(rows).toHaveLength(2);
    });

    it('cannot join a Collection of another Workspace, of Global, or a Global file of a Workspace Collection', async () => {
      const inB = await addCollection(wsB, 'Foreign B');
      const inGlobal = await addCollection(null, 'Foreign Global');
      const inA = await addCollection(wsA, 'Foreign A');
      await rejects(addFile(wsA, inB), '23503', 'FK_files_collection_scope');
      await rejects(addFile(wsA, inGlobal), '23503', 'FK_files_collection_scope');
      await rejects(addFile(null, inA), '23503', 'FK_files_collection_scope');
      await rejects(addFile(wsB, inA), '23503', 'FK_files_collection_scope');
      const own = await addFile(wsA, inA);
      // Moving an existing file to a foreign Collection is refused too.
      await rejects(ds.query('UPDATE files SET collection_id = $1 WHERE id = $2', [inB, own]), '23503', 'FK_files_collection_scope');
      await rejects(ds.query('UPDATE files SET collection_id = gen_random_uuid() WHERE id = $1', [own]), '23503');
      // A file cannot be re-scoped away from its Collection either.
      await rejects(ds.query(`UPDATE files SET scope = 'workspace', workspace_id = $1 WHERE id = $2`, [wsB, own]), '23503', 'FK_files_collection_scope');
    });

    it('survive the deletion of their Collection, with the membership cleared and nothing else touched', async () => {
      const c = await addCollection(wsA, 'Doomed');
      const keep = await addCollection(wsA, 'Kept');
      const f1 = await addFile(wsA, c);
      const f2 = await addFile(wsA, c);
      const f3 = await addFile(wsA, keep);
      const tag = await addTag(wsA, 'survivor');
      await tagFile(f1, tag, wsA);
      await ds.query('DELETE FROM collections WHERE id = $1', [c]);
      const rows = await iso.query(`SELECT id, collection_id, scope, workspace_id FROM "${iso.schema}".files WHERE id IN ('${f1}', '${f2}', '${f3}')`);
      expect(rows).toHaveLength(3);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[f1]).toMatchObject({ collection_id: null, scope: 'workspace', workspace_id: wsA });
      expect(byId[f2]!.collection_id).toBeNull();
      expect(byId[f3]!.collection_id).toBe(keep);
      expect(await iso.query(`SELECT 1 FROM "${iso.schema}".file_tags WHERE file_id = '${f1}'`)).toHaveLength(1);
      expect(await iso.query(`SELECT 1 FROM "${iso.schema}".tags WHERE id = '${tag}'`)).toHaveLength(1);
    });

    it('survive the deletion of a Global Collection too', async () => {
      const c = await addCollection(null, 'Global doomed');
      const f = await addFile(null, c);
      await ds.query('DELETE FROM collections WHERE id = $1', [c]);
      const [row] = await iso.query(`SELECT collection_id, scope, workspace_id FROM "${iso.schema}".files WHERE id = '${f}'`);
      expect(row).toEqual({ collection_id: null, scope: 'global', workspace_id: null });
    });
  });

  describe('Tags', () => {
    it('are normalized, bounded and flat', async () => {
      for (const ok of ['a', 'work-in_progress', 'v1.2', 'team:alpha', 'a/b/c', '0', 'x'.repeat(50)]) await addTag(wsA, ok);
      for (const bad of ['', 'Upper', ' lead', 'trail ', 'has space', 'semi;colon', 'ünï', 'tab\t', 'new\nline', 'a,b']) {
        await rejects(addTag(wsB, bad), '23514');
      }
      await rejects(addTag(wsB, 'x'.repeat(51)), '22001');
    });

    it('are unique per scope, with the same name allowed in other scopes and Global unique with NULL workspace_id', async () => {
      await addTag(wsA, 'shared');
      await rejects(addTag(wsA, 'shared'), '23505', 'UQ_tags_scope_key_name');
      await addTag(wsB, 'shared');
      await addTag(null, 'shared');
      await rejects(addTag(null, 'shared'), '23505', 'UQ_tags_scope_key_name');
    });

    it('do not reference files, so Memories can reuse them later', async () => {
      const cols = await iso.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = '${iso.schema}' AND table_name = 'tags' ORDER BY column_name`,
      );
      expect(cols.map((c) => c.column_name)).toEqual(['created_at', 'id', 'name', 'scope', 'scope_key', 'updated_at', 'workspace_id']);
      const refs = await iso.query(
        `SELECT conname FROM pg_constraint WHERE conrelid = '"${iso.schema}"."tags"'::regclass AND contype = 'f'`,
      );
      expect(refs.map((r) => r.conname)).toEqual(['FK_tags_workspace_id']);
    });
  });

  describe('file_tags', () => {
    it('join a file and a Tag of the same scope, once', async () => {
      const f = await addFile(wsA);
      const t = await addTag(wsA, 'join-ok');
      await tagFile(f, t, wsA);
      await rejects(tagFile(f, t, wsA), '23505', 'PK_file_tags');
      const g = await addFile(null);
      const gt = await addTag(null, 'join-ok-global');
      await tagFile(g, gt, 'global');
    });

    it('refuse joins across Workspaces, between Global and a Workspace, and with a forged scope key', async () => {
      const fA = await addFile(wsA);
      const fG = await addFile(null);
      const tA = await addTag(wsA, 'cross-a');
      const tB = await addTag(wsB, 'cross-b');
      const tG = await addTag(null, 'cross-g');
      await rejects(tagFile(fA, tB, wsA), '23503', 'FK_file_tags_tag_scope');
      await rejects(tagFile(fA, tB, wsB), '23503', 'FK_file_tags_file_scope');
      await rejects(tagFile(fA, tG, wsA), '23503', 'FK_file_tags_tag_scope');
      await rejects(tagFile(fA, tG, 'global'), '23503', 'FK_file_tags_file_scope');
      await rejects(tagFile(fG, tA, 'global'), '23503', 'FK_file_tags_tag_scope');
      await rejects(tagFile(fG, tA, wsA), '23503', 'FK_file_tags_file_scope');
      await rejects(tagFile(fA, tA, 'global'), '23503');
    });

    it('are removed with their file or Tag and never delete the other side', async () => {
      const f1 = await addFile(wsB);
      const f2 = await addFile(wsB);
      const t1 = await addTag(wsB, 'cascade-1');
      const t2 = await addTag(wsB, 'cascade-2');
      for (const [f, t] of [[f1, t1], [f1, t2], [f2, t1]] as const) await tagFile(f, t, wsB);
      await ds.query('DELETE FROM tags WHERE id = $1', [t1]);
      expect(await iso.query(`SELECT 1 FROM "${iso.schema}".files WHERE id IN ('${f1}', '${f2}')`)).toHaveLength(2);
      expect(await iso.query(`SELECT tag_id FROM "${iso.schema}".file_tags WHERE file_id IN ('${f1}', '${f2}')`)).toEqual([{ tag_id: t2 }]);
      await ds.query('DELETE FROM files WHERE id = $1', [f1]);
      expect(await iso.query(`SELECT 1 FROM "${iso.schema}".tags WHERE id = '${t2}'`)).toHaveLength(1);
      expect(await iso.query(`SELECT 1 FROM "${iso.schema}".file_tags WHERE file_id = '${f1}'`)).toHaveLength(0);
    });

    it('cannot change a Tag or file scope while joined', async () => {
      const f = await addFile(wsA);
      const t = await addTag(wsA, 'locked');
      await tagFile(f, t, wsA);
      await rejects(ds.query(`UPDATE tags SET scope = 'workspace', workspace_id = $1 WHERE id = $2`, [wsB, t]), '23503');
      await rejects(ds.query(`UPDATE files SET scope = 'workspace', workspace_id = $1 WHERE id = $2`, [wsB, f]), '23503');
    });
  });

  describe('Workspace foreign keys', () => {
    it('restrict deleting a Workspace that still owns files, Collections or Tags', async () => {
      const ws = await addWorkspace('restricted');
      const c = await addCollection(ws, 'c');
      await rejects(ds.query('DELETE FROM workspaces WHERE id = $1', [ws]), '23503', 'FK_collections_workspace_id');
      await ds.query('DELETE FROM collections WHERE id = $1', [c]);
      const t = await addTag(ws, 't');
      await rejects(ds.query('DELETE FROM workspaces WHERE id = $1', [ws]), '23503', 'FK_tags_workspace_id');
      await ds.query('DELETE FROM tags WHERE id = $1', [t]);
      const f = await addFile(ws);
      await rejects(ds.query('DELETE FROM workspaces WHERE id = $1', [ws]), '23503', 'FK_files_workspace_id');
      await ds.query('DELETE FROM files WHERE id = $1', [f]);
      await ds.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    });
  });

  describe('TypeORM entities', () => {
    it('read and write the tables, with generated scope keys and numeric sizes', async () => {
      const c = await ds.getRepository(Collection).save({ scope: 'workspace', workspaceId: wsA, name: 'Entity', description: 'd' });
      expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
      const file = await ds.getRepository(FileRecord).save({
        scope: 'workspace',
        workspaceId: wsA,
        name: 'e.txt',
        extension: 'txt',
        mimeType: 'text/plain',
        sizeBytes: 12,
        sha256: 'b'.repeat(64),
        storageKey: 'entity/key',
        collectionId: c.id,
      });
      const loaded = await ds.getRepository(FileRecord).findOneByOrFail({ id: file.id });
      expect(loaded).toMatchObject({ sizeBytes: 12, ingestionStatus: 'pending', ingestionError: null, collectionId: c.id, scopeKey: wsA });
      const tag = await ds.getRepository(Tag).save({ scope: 'global', workspaceId: null, name: 'entity-tag' });
      expect((await ds.getRepository(Tag).findOneByOrFail({ id: tag.id })).scopeKey).toBe('global');
    });
  });

  describe('migration down', () => {
    it('reverts cleanly and applies again', async () => {
      const own = iso.createDataSource([]);
      await own.initialize();
      // A fresh schema: up everything, down the newest, up again.
      const fresh = await createIsolatedSchema();
      try {
        const d = fresh.createDataSource([]);
        await d.initialize();
        await fresh.query('DROP EXTENSION IF EXISTS vector');
        await d.runMigrations({ transaction: 'each' });
        const tables = async () =>
          (await fresh.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${fresh.schema}' ORDER BY table_name`)).map((t) => t.table_name);
        expect(await tables()).toEqual(expect.arrayContaining(['collections', 'file_tags', 'files', 'tags']));
        await d.undoLastMigration({ transaction: 'each' }); // storage cleanup ledger
        await d.undoLastMigration({ transaction: 'each' });
        const after = await tables();
        for (const t of ['collections', 'file_tags', 'files', 'tags']) expect(after).not.toContain(t);
        expect(after).toContain('workspaces');
        expect(await d.runMigrations({ transaction: 'each' })).toHaveLength(2);
      } finally {
        await fresh.dispose();
        await own.destroy();
      }
    });
  });
});
