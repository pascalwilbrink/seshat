import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { Principal } from '../auth/principal.js';
import { type ScopeRef, isUuid, scopeColumns } from '../scopes/scope-ref.js';
import type { RenameTagInput, TagDto } from './tag.dto.js';
import { normalizeTagNames } from './tag-name.js';

const TAG_CONFLICT = 'A Tag with this name already exists';

/** The generated `scope_key` value of a scope: 'global' or the Workspace uuid (lowercase). */
export function scopeKeyOf(scope: ScopeRef): string {
  return scope.kind === 'global' ? 'global' : scope.workspaceId.toLowerCase();
}

function pgCode(err: unknown): string | undefined {
  return (err as { driverError?: { code?: string } } | null)?.driverError?.code;
}

interface TagRow {
  id: string;
  name: string;
  scope: 'global' | 'workspace';
  workspace_id: string | null;
  file_count: number;
  created_at: Date;
  updated_at: Date;
}

const toDto = (r: TagRow): TagDto => ({
  id: r.id,
  name: r.name,
  scope: r.scope,
  workspaceId: r.workspace_id,
  fileCount: Number(r.file_count),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const SELECT_TAG = `SELECT t.id, t.name, t.scope, t.workspace_id, t.created_at, t.updated_at,
  (SELECT count(*) FROM file_tags ft WHERE ft.tag_id = t.id)::int AS file_count
  FROM tags t`;

/**
 * Scoped, flat, reusable Tags. Management (list, rename, delete) authorizes through AuthorizationService before any
 * lookup, and every statement filters on the scope key, so an id from another scope behaves like a missing one.
 * Tags carry no access semantics.
 *
 * Deleting a Tag removes its joins through the `file_tags` FK cascade (a later `memory_tags` join cascades the same
 * way) and never touches files.
 */
@Injectable()
export class TagsService {
  constructor(
    @Inject(getDataSourceToken()) private readonly dataSource: Pick<DataSource, 'query' | 'transaction'>,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  async list(principal: Principal, scope: ScopeRef): Promise<TagDto[]> {
    this.authorization.assertCan(principal, 'tag.list', scope);
    const rows = (await this.dataSource.query(`${SELECT_TAG} WHERE t.scope_key = $1 ORDER BY t.name ASC, t.id ASC`, [
      scopeKeyOf(scope),
    ])) as TagRow[];
    return rows.map(toDto);
  }

  async rename(principal: Principal, scope: ScopeRef, tagId: string, input: RenameTagInput): Promise<TagDto> {
    this.authorization.assertCan(principal, 'tag.rename', scope);
    if (!isUuid(tagId)) throw new NotFoundException('Not Found');
    try {
      const updated = (await this.dataSource.query(
        `UPDATE tags SET name = $3, updated_at = now() WHERE id = $1 AND scope_key = $2 RETURNING id`,
        [tagId, scopeKeyOf(scope), input.name],
      )) as unknown;
      // pg returns [rows, rowCount] for UPDATE ... RETURNING through TypeORM.
      const rows = (Array.isArray(updated) && Array.isArray(updated[0]) ? updated[0] : updated) as unknown[];
      if (rows.length === 0) throw new NotFoundException('Not Found');
    } catch (err) {
      if (pgCode(err) === '23505') throw new ConflictException(TAG_CONFLICT);
      throw err;
    }
    const [row] = (await this.dataSource.query(`${SELECT_TAG} WHERE t.id = $1 AND t.scope_key = $2`, [
      tagId,
      scopeKeyOf(scope),
    ])) as TagRow[];
    if (!row) throw new NotFoundException('Not Found'); // deleted between the update and the read
    return toDto(row);
  }

  async remove(principal: Principal, scope: ScopeRef, tagId: string): Promise<void> {
    this.authorization.assertCan(principal, 'tag.delete', scope);
    if (!isUuid(tagId)) throw new NotFoundException('Not Found');
    const result = (await this.dataSource.query(`DELETE FROM tags WHERE id = $1 AND scope_key = $2 RETURNING id`, [
      tagId,
      scopeKeyOf(scope),
    ])) as unknown;
    const rows = (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as unknown[];
    if (rows.length === 0) throw new NotFoundException('Not Found');
  }

  /**
   * INTERNAL. Replaces the Tags of a file with the given names inside the caller's transaction (`manager`).
   * No authorization here: the caller is a file operation that already passed `file.upload` / `file.update`, and
   * file operations must not need any memories permission. Names are normalized and deduplicated; missing names are
   * created in the file's own scope only; the join rows are replaced atomically with the caller's transaction, so a
   * failure anywhere rolls the whole file change back. Returns the resulting Tag names, sorted.
   *
   * Race safety: creation is `INSERT ... ON CONFLICT DO NOTHING` on the per-scope unique name, so concurrent
   * assignments of the same new name both succeed with one row; the ids are then read with `FOR SHARE`, which keeps a
   * concurrent delete or rename of those Tags from slipping in before the joins are written. `scope_key` is part of
   * both composite FKs, so a join can never connect a file and a Tag of different scopes.
   */
  async replaceFileTags(manager: EntityManager, scope: ScopeRef, fileId: string, rawNames: unknown): Promise<string[]> {
    const names = normalizeTagNames(rawNames).sort();
    const scopeKey = scopeKeyOf(scope);
    const ids = await this.ensureTagIds(manager, scope, names);
    await manager.query(`DELETE FROM file_tags WHERE file_id = $1 AND scope_key = $2 AND NOT (tag_id = ANY($3::uuid[]))`, [
      fileId,
      scopeKey,
      ids,
    ]);
    if (ids.length > 0) {
      await manager.query(
        `INSERT INTO file_tags (file_id, tag_id, scope_key) SELECT $1::uuid, t, $2 FROM unnest($3::uuid[]) AS t
         ON CONFLICT ("file_id", "tag_id") DO NOTHING`,
        [fileId, scopeKey, ids],
      );
    }
    return names;
  }

  /**
   * INTERNAL. Replaces the Tags of a Memory inside the caller's transaction, exactly like `replaceFileTags` (same
   * normalization and race-safe shared creation). No authorization here: the Memories service has already authorized.
   * Returns the resulting Tag names, sorted.
   */
  async replaceMemoryTags(manager: EntityManager, scope: ScopeRef, memoryId: string, rawNames: unknown): Promise<string[]> {
    const names = normalizeTagNames(rawNames).sort();
    const scopeKey = scopeKeyOf(scope);
    const ids = await this.ensureTagIds(manager, scope, names);
    await manager.query(`DELETE FROM memory_tags WHERE memory_id = $1 AND scope_key = $2 AND NOT (tag_id = ANY($3::uuid[]))`, [
      memoryId,
      scopeKey,
      ids,
    ]);
    await this.linkMemoryTags(manager, scopeKey, memoryId, ids);
    return names;
  }

  /**
   * INTERNAL. Adds the given Tag names to a Memory without removing existing ones (used when a duplicate create reuses
   * an existing Memory). Returns the Memory's resulting Tag names, sorted.
   */
  async unionMemoryTags(manager: EntityManager, scope: ScopeRef, memoryId: string, rawNames: unknown): Promise<string[]> {
    const names = normalizeTagNames(rawNames);
    const scopeKey = scopeKeyOf(scope);
    const ids = await this.ensureTagIds(manager, scope, names);
    await this.linkMemoryTags(manager, scopeKey, memoryId, ids);
    const rows = (await manager.query(
      `SELECT t.name FROM memory_tags mt JOIN tags t ON t.id = mt.tag_id AND t.scope_key = mt.scope_key
       WHERE mt.memory_id = $1 AND mt.scope_key = $2 ORDER BY t.name`,
      [memoryId, scopeKey],
    )) as { name: string }[];
    return rows.map((r) => r.name);
  }

  private async linkMemoryTags(manager: EntityManager, scopeKey: string, memoryId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await manager.query(
      `INSERT INTO memory_tags (memory_id, tag_id, scope_key) SELECT $1::uuid, t, $2 FROM unnest($3::uuid[]) AS t
       ON CONFLICT ("memory_id", "tag_id") DO NOTHING`,
      [memoryId, scopeKey, ids],
    );
  }

  /**
   * Race safety: creation is `INSERT ... ON CONFLICT DO NOTHING` on the per-scope unique name, so concurrent
   * assignments of the same new name both succeed with one row; the ids are then read with `FOR SHARE`, which keeps a
   * concurrent delete or rename of those Tags from slipping in before the joins are written.
   */
  private async ensureTagIds(manager: EntityManager, scope: ScopeRef, names: string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const { scope: scopeValue, workspaceId } = scopeColumns(scope);
    await manager.query(
      `INSERT INTO tags (scope, workspace_id, name) SELECT $1, $2::uuid, n FROM unnest($3::text[]) AS n
       ON CONFLICT ON CONSTRAINT "UQ_tags_scope_key_name" DO NOTHING`,
      [scopeValue, workspaceId, names],
    );
    const found = (await manager.query(
      `SELECT id FROM tags WHERE scope_key = $1 AND name = ANY($2::text[]) ORDER BY id FOR SHARE`,
      [scopeKeyOf(scope), names],
    )) as { id: string }[];
    return found.map((r) => r.id);
  }
}
