import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Permission } from '@seshat/domain';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorizationService } from '../src/auth/authorization.service.js';
import { ADMIN_PRINCIPAL, type Principal } from '../src/auth/principal.js';
import { Collection } from '../src/collections/collection.entity.js';
import { FileRecord } from '../src/files/file.entity.js';
import { globalScope, workspaceScope, type ScopeRef } from '../src/scopes/scope-ref.js';
import { FileTag } from '../src/tags/file-tag.entity.js';
import { Tag } from '../src/tags/tag.entity.js';
import { TagsService } from '../src/tags/tags.service.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import {
  TEST_DATABASE_URL,
  assertDisposableDatabase,
  createIsolatedSchema,
  describeIntegration,
  type IsolatedSchema,
} from './helpers/integration.js';

/** AC-7/AC-8 for Tags on real PostgreSQL: normalization, per-scope uniqueness, races, replacement, deletion, OR permissions. */
describeIntegration('Scoped Tags (real PostgreSQL)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let service: TagsService;
  let wsA: string;
  let wsB: string;
  let seq = 0;

  const ws = (id: string) => workspaceScope(id);
  const key = (workspaceId: string, ...permissions: Permission[]): Principal => ({ kind: 'apiKey', keyId: 'k', workspaceId, permissions });
  const addWorkspace = async (slug: string) =>
    ((await ds.query('INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id', [slug])) as { id: string }[])[0]!.id;
  const addFile = async (workspaceId: string | null) => {
    seq += 1;
    return ((await ds.query(
      `INSERT INTO files (scope, workspace_id, name, mime_type, size_bytes, sha256, storage_key)
       VALUES ($1, $2, 'a.txt', 'text/plain', 1, $3, $4) RETURNING id`,
      [workspaceId ? 'workspace' : 'global', workspaceId, 'a'.repeat(64), `k/${seq}/${Math.random()}`],
    )) as { id: string }[])[0]!.id;
  };
  const assign = (scope: ScopeRef, fileId: string, names: unknown) => ds.transaction((m) => service.replaceFileTags(m, scope, fileId, names));
  const fileTagNames = async (fileId: string) =>
    ((await ds.query('SELECT t.name FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = $1 ORDER BY t.name', [fileId])) as { name: string }[]).map((r) => r.name);
  const tagRows = async (scopeKey: string) =>
    (await ds.query('SELECT id, name FROM tags WHERE scope_key = $1 ORDER BY name', [scopeKey])) as { id: string; name: string }[];

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, Collection, FileRecord, Tag, FileTag]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    service = new TagsService(ds, new AuthorizationService());
    wsA = await addWorkspace('tags-a');
    wsB = await addWorkspace('tags-b');
  });

  afterAll(async () => {
    await iso?.dispose();
  });

  describe('assignment', () => {
    it('normalizes, deduplicates and creates missing names only in the file scope', async () => {
      const f = await addFile(wsA);
      const names = await assign(ws(wsA), f, ['  Alpha ', 'alpha', 'Beta:One/two', 'x_y.z-1']);
      expect(names).toEqual(['alpha', 'beta:one/two', 'x_y.z-1']);
      expect(await fileTagNames(f)).toEqual(['alpha', 'beta:one/two', 'x_y.z-1']);
      expect((await tagRows(wsA)).map((t) => t.name)).toEqual(['alpha', 'beta:one/two', 'x_y.z-1']);
      expect(await tagRows(wsB)).toEqual([]);
      expect(await tagRows('global')).toEqual([]);
    });

    it('allows the same name in Global and in two Workspaces, each its own row', async () => {
      const fa = await addFile(wsA);
      const fb = await addFile(wsB);
      const fg = await addFile(null);
      await assign(ws(wsA), fa, ['shared']);
      await assign(ws(wsB), fb, ['shared']);
      await assign(globalScope(), fg, ['shared']);
      const ids = new Set([...(await tagRows(wsA)), ...(await tagRows(wsB)), ...(await tagRows('global'))].filter((t) => t.name === 'shared').map((t) => t.id));
      expect(ids.size).toBe(3);
      await expect(ds.query(`INSERT INTO tags (scope, workspace_id, name) VALUES ('workspace', $1, 'shared')`, [wsA])).rejects.toMatchObject({ driverError: { code: '23505' } });
      await expect(ds.query(`INSERT INTO tags (scope, workspace_id, name) VALUES ('global', NULL, 'shared')`)).rejects.toMatchObject({ driverError: { code: '23505' } });
    });

    it('replaces the set: removes dropped tags from the file only, keeps the Tag rows, and empty clears', async () => {
      const f = await addFile(wsA);
      const other = await addFile(wsA);
      await assign(ws(wsA), f, ['r1', 'r2', 'r3']);
      await assign(ws(wsA), other, ['r2']);
      await assign(ws(wsA), f, ['r3', 'r4']);
      expect(await fileTagNames(f)).toEqual(['r3', 'r4']);
      expect(await fileTagNames(other)).toEqual(['r2']);
      expect((await tagRows(wsA)).map((t) => t.name)).toEqual(expect.arrayContaining(['r1', 'r2', 'r3', 'r4']));
      await assign(ws(wsA), f, []);
      expect(await fileTagNames(f)).toEqual([]);
    });

    it('is transactional: a failure after assignment restores the previous tags and creates no Tag rows', async () => {
      const f = await addFile(wsA);
      await assign(ws(wsA), f, ['keep']);
      await expect(
        ds.transaction(async (m) => {
          await service.replaceFileTags(m, ws(wsA), f, ['rolled-back-new', 'other-new']);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await fileTagNames(f)).toEqual(['keep']);
      expect((await tagRows(wsA)).map((t) => t.name)).not.toContain('rolled-back-new');
    });

    it('rejects invalid names atomically (400) without touching anything', async () => {
      const f = await addFile(wsA);
      await assign(ws(wsA), f, ['stay']);
      for (const bad of [['ok', 'bad name'], ['x'.repeat(51)], [''], 'nope']) {
        await expect(assign(ws(wsA), f, bad)).rejects.toMatchObject({ status: 400 });
      }
      expect(await fileTagNames(f)).toEqual(['stay']);
      expect((await tagRows(wsA)).map((t) => t.name)).not.toContain('ok');
    });

    it('never joins across scopes: a file of another scope cannot be tagged through this scope', async () => {
      const fa = await addFile(wsA);
      await expect(assign(ws(wsB), fa, ['cross'])).rejects.toMatchObject({ driverError: { code: '23503' } });
      await expect(assign(globalScope(), fa, ['cross'])).rejects.toMatchObject({ driverError: { code: '23503' } });
      expect(await fileTagNames(fa)).toEqual([]);
      expect((await tagRows(wsB)).map((t) => t.name)).not.toContain('cross');
      const [{ count }] = (await ds.query('SELECT count(*)::int AS count FROM file_tags WHERE file_id = $1', [fa])) as { count: number }[];
      expect(count).toBe(0);
    });

    it('is race-safe: concurrent assignments of the same new names produce one row each and all succeed', async () => {
      const files = await Promise.all(Array.from({ length: 12 }, () => addFile(wsA)));
      await Promise.all(files.map((f, i) => assign(ws(wsA), f, i % 2 ? ['race-1', 'race-2', 'race-3'] : ['race-3', 'RACE-2', 'race-1', 'race-4'])));
      const rows = (await tagRows(wsA)).filter((t) => t.name.startsWith('race-'));
      expect(rows.map((t) => t.name)).toEqual(['race-1', 'race-2', 'race-3', 'race-4']);
      for (const [i, f] of files.entries()) {
        expect(await fileTagNames(f)).toEqual(i % 2 ? ['race-1', 'race-2', 'race-3'] : ['race-1', 'race-2', 'race-3', 'race-4']);
      }
    });

    it('waits for a concurrent Tag delete instead of writing a dangling join', async () => {
      const f = await addFile(wsA);
      await assign(ws(wsA), f, ['ephemeral']);
      const [tag] = await tagRows(wsA).then((r) => r.filter((t) => t.name === 'ephemeral'));
      const results = await Promise.allSettled([assign(ws(wsA), f, ['ephemeral', 'sidekick']), service.remove(ADMIN_PRINCIPAL, ws(wsA), tag!.id)]);
      expect(results[1]!.status).toBe('fulfilled');
      // Whichever order won, no join points at a missing tag and the file's joins are consistent.
      const [{ dangling }] = (await ds.query('SELECT count(*)::int AS dangling FROM file_tags ft LEFT JOIN tags t ON t.id = ft.tag_id WHERE t.id IS NULL')) as { dangling: number }[];
      expect(dangling).toBe(0);
    });
  });

  describe('management', () => {
    it('lists only the scope with file counts, ordered by name', async () => {
      const w = await addWorkspace('tags-list');
      const [f1, f2] = [await addFile(w), await addFile(w)];
      await assign(ws(w), f1, ['zeta', 'alpha']);
      await assign(ws(w), f2, ['alpha']);
      const list = await service.list(ADMIN_PRINCIPAL, ws(w));
      expect(list.map((t) => [t.name, t.fileCount, t.scope, t.workspaceId])).toEqual([
        ['alpha', 2, 'workspace', w],
        ['zeta', 1, 'workspace', w],
      ]);
      expect(await service.list(ADMIN_PRINCIPAL, ws(await addWorkspace('tags-empty')))).toEqual([]);
    });

    it('renames with normalization, keeps joins, and reports collisions as a sanitized 409', async () => {
      const w = await addWorkspace('tags-rename');
      const f = await addFile(w);
      await assign(ws(w), f, ['old', 'taken']);
      const [old] = (await tagRows(w)).filter((t) => t.name === 'old');
      const renamed = await service.rename(ADMIN_PRINCIPAL, ws(w), old!.id, { name: 'new-name' });
      expect(renamed).toMatchObject({ id: old!.id, name: 'new-name', fileCount: 1 });
      expect(await fileTagNames(f)).toEqual(['new-name', 'taken']);
      const err = await service.rename(ADMIN_PRINCIPAL, ws(w), old!.id, { name: 'taken' }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(JSON.stringify(err.getResponse())).not.toMatch(/UQ_tags|duplicate|tags_scope/);
      // Same name as itself is a no-op, and the same name is free in another scope.
      await expect(service.rename(ADMIN_PRINCIPAL, ws(w), old!.id, { name: 'new-name' })).resolves.toMatchObject({ name: 'new-name' });
      await expect(service.rename(ADMIN_PRINCIPAL, ws(wsB), (await tagRows(wsB))[0]!.id, { name: 'taken' })).resolves.toMatchObject({ name: 'taken' });
    });

    it('settles a rename collision race with exactly one winner', async () => {
      const w = await addWorkspace('tags-race');
      const f = await addFile(w);
      await assign(ws(w), f, ['one', 'two']);
      const [one, two] = await tagRows(w);
      const results = await Promise.allSettled([
        service.rename(ADMIN_PRINCIPAL, ws(w), one!.id, { name: 'same' }),
        service.rename(ADMIN_PRINCIPAL, ws(w), two!.id, { name: 'same' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(loser.reason).toBeInstanceOf(ConflictException);
      expect((await tagRows(w)).map((t) => t.name).sort()).toEqual(expect.arrayContaining(['same']));
    });

    it('deletes a Tag from every file at once and keeps the files', async () => {
      const w = await addWorkspace('tags-delete');
      const files = await Promise.all([addFile(w), addFile(w), addFile(w)]);
      for (const f of files) await assign(ws(w), f, ['gone', 'stays']);
      const [gone] = (await tagRows(w)).filter((t) => t.name === 'gone');
      await service.remove(ADMIN_PRINCIPAL, ws(w), gone!.id);
      for (const f of files) expect(await fileTagNames(f)).toEqual(['stays']);
      const [{ count }] = (await ds.query('SELECT count(*)::int AS count FROM files WHERE workspace_id = $1', [w])) as { count: number }[];
      expect(count).toBe(3);
      await expect(service.remove(ADMIN_PRINCIPAL, ws(w), gone!.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('treats ids of other scopes exactly like missing ids, in every scope direction', async () => {
      const [a] = await tagRows(wsA);
      const fg = await addFile(null);
      await assign(globalScope(), fg, ['g-only']);
      const [g] = (await tagRows('global')).filter((t) => t.name === 'g-only');
      const missing = '00000000-0000-4000-8000-000000000000';
      const attempts: Array<[ScopeRef, string]> = [[ws(wsB), a!.id], [globalScope(), a!.id], [ws(wsA), g!.id]];
      for (const [scope, id] of attempts) {
        const r = await service.rename(ADMIN_PRINCIPAL, scope, id, { name: 'hijack' }).catch((e) => e);
        const m = await service.rename(ADMIN_PRINCIPAL, scope, missing, { name: 'hijack' }).catch((e) => e);
        expect(r).toBeInstanceOf(NotFoundException);
        expect(r.getResponse()).toEqual(m.getResponse());
        const d = await service.remove(ADMIN_PRINCIPAL, scope, id).catch((e) => e);
        expect(d).toBeInstanceOf(NotFoundException);
      }
      expect((await tagRows(wsA)).map((t) => t.id)).toContain(a!.id);
      expect((await tagRows('global')).map((t) => t.id)).toContain(g!.id);
    });
  });

  describe('OR permissions on real data', () => {
    it('lists with files:read or memories:read alone, never with other permissions', async () => {
      for (const p of ['files:read', 'memories:read'] as const) await expect(service.list(key(wsA, p), ws(wsA))).resolves.toBeInstanceOf(Array);
      await expect(service.list(key(wsA, 'collections:read', 'files:write'), ws(wsA))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.list(key(wsA), ws(wsA))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('renames and deletes with files:write or memories:write alone, not with read or delete permissions', async () => {
      const w = await addWorkspace('tags-or');
      const f = await addFile(w);
      await assign(ws(w), f, ['t1', 't2', 't3']);
      const [t1, t2, t3] = await tagRows(w);
      await expect(service.rename(key(w, 'files:write'), ws(w), t1!.id, { name: 't1-files' })).resolves.toMatchObject({ name: 't1-files' });
      await expect(service.rename(key(w, 'memories:write'), ws(w), t2!.id, { name: 't2-mem' })).resolves.toMatchObject({ name: 't2-mem' });
      for (const p of [key(w, 'files:read', 'memories:read', 'files:delete', 'memories:delete'), key(w)]) {
        await expect(service.rename(p, ws(w), t3!.id, { name: 'nope' })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.remove(p, ws(w), t3!.id)).rejects.toBeInstanceOf(ForbiddenException);
      }
      await expect(service.remove(key(w, 'memories:write'), ws(w), t1!.id)).resolves.toBeUndefined();
      await expect(service.remove(key(w, 'files:write'), ws(w), t2!.id)).resolves.toBeUndefined();
      expect((await tagRows(w)).map((t) => t.name)).toEqual(['t3']);
    });

    it('conceals foreign Workspaces and ungranted Global; Global reads need the grant; keys never mutate Global', async () => {
      const [a] = await tagRows(wsA);
      const fg = await addFile(null);
      await assign(globalScope(), fg, ['pub']);
      const [g] = (await tagRows('global')).filter((t) => t.name === 'pub');
      const generic = (await service.list(key(wsB, 'files:read'), ws(wsA)).catch((e) => e)).getResponse();
      const missingWs = (await service.list(key(wsB, 'files:read'), ws('00000000-0000-4000-8000-000000000001')).catch((e) => e)).getResponse();
      expect(generic).toEqual(missingWs);
      const noGrant = await service.list(key(wsA, 'files:read', 'memories:read'), globalScope()).catch((e) => e);
      expect(noGrant).toBeInstanceOf(NotFoundException);
      const globalKey = key(wsA, 'files:read', 'global:read');
      expect((await service.list(globalKey, globalScope())).map((t) => t.name)).toContain('pub');
      expect(await service.list(key(wsA, 'memories:read', 'global:read'), globalScope())).toHaveLength((await tagRows('global')).length);
      const full = key(wsA, 'files:read', 'memories:read', 'files:write', 'memories:write', 'global:read');
      await expect(service.rename(full, globalScope(), g!.id, { name: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.remove(full, globalScope(), g!.id)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.remove(key(wsA, 'files:write'), globalScope(), g!.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.remove(key(wsB, 'files:write'), ws(wsA), a!.id)).rejects.toBeInstanceOf(NotFoundException);
      expect((await tagRows('global')).map((t) => t.id)).toContain(g!.id);
      expect((await tagRows(wsA)).map((t) => t.id)).toContain(a!.id);
    });
  });
});
