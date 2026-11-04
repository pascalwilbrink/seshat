import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { Principal } from '../auth/principal.js';
import { CollectionsService } from '../collections/collection.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { type ScopeRef, isUuid, scopeColumns } from '../scopes/scope-ref.js';
import { FILE_STORAGE, type FileStorage, StorageObjectNotFoundError, originalObjectKey } from '../storage/file-storage.js';
import { StorageCleanupService } from '../storage/storage-cleanup.service.js';
import { TagsService, scopeKeyOf } from '../tags/tags.service.js';
import { type FileDto, type FileRow, type UpdateFileInput, toFileDto } from './file.dto.js';
import { FILE_DELETED_EVENT, FILE_UPLOADED_EVENT, type FileUploadedEvent } from './file.events.js';
import { extensionOf, sanitizeFileName, sanitizeMimeType } from './file-name.js';
import { type FileListPage, encodeCursor, parseFileListQuery } from './file-list-query.js';
import { receiveUpload } from './upload-reader.js';

const FILE_COLUMNS_F = ['id', 'scope', 'workspace_id', 'name', 'extension', 'mime_type', 'size_bytes', 'sha256', 'collection_id', 'ingestion_status', 'created_at', 'updated_at']
  .map((c) => `f."${c}"`)
  .join(', ');

function pgCode(err: unknown): string | undefined {
  return (err as { driverError?: { code?: string } } | null)?.driverError?.code;
}

/**
 * Scoped Files. `upload` authorizes (`file.upload`, `files:write`) before the request body is read, streams the
 * original into FileStorage under a generated key, then commits the row, the optional same-scope Collection and the
 * tag assignments in one transaction. Only after the commit is `file.uploaded` emitted. If anything fails, the stored
 * object is removed (a failing removal is logged by file id and never replaces the original error).
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger('Files');

  constructor(
    @Inject(getDataSourceToken()) private readonly dataSource: DataSource,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(CollectionsService) private readonly collections: CollectionsService,
    @Inject(TagsService) private readonly tags: TagsService,
    @Inject(StorageCleanupService) private readonly cleanup: StorageCleanupService,
    @Inject(EventEmitter2) private readonly events: EventEmitter2,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'maxUploadBytes'>,
  ) {}

  async upload(principal: Principal, scope: ScopeRef, req: IncomingMessage): Promise<FileDto> {
    // Before the body is touched, stored or even looked at.
    this.authorization.assertCan(principal, 'file.upload', scope);
    await this.assertScopeExists(scope);

    const id = randomUUID();
    const key = originalObjectKey(scope, id);
    try {
      const received = await receiveUpload(req, {
        maxBytes: this.config.maxUploadBytes,
        store: (stream) => this.storage.put(key, stream),
      });
      const name = sanitizeFileName(received.filename);
      const dto = await this.dataSource.transaction(async (manager) => {
        const collectionId = await this.collections.resolveMembership(manager, scope, received.collectionId || null);
        const cols = scopeColumns(scope);
        await manager.query(
          `INSERT INTO "files" ("id", "scope", "workspace_id", "name", "extension", "mime_type", "size_bytes", "sha256", "storage_key", "collection_id")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, cols.scope, cols.workspaceId, name, extensionOf(name), sanitizeMimeType(received.mimeType), received.size, received.sha256, key, collectionId],
        );
        const tagNames = await this.tags.replaceFileTags(manager, scope, id, received.tags);
        return this.load(manager, scope, id, tagNames);
      });
      await this.emitUploaded({ id, scope });
      return dto;
    } catch (err) {
      await this.discard(id, key, scope);
      if (pgCode(err) === '23503') throw new NotFoundException('Not Found'); // Workspace removed meanwhile
      throw err;
    }
  }

  /**
   * `file.update` (`files:write`). Renames (sanitized display name), sets or clears the same-scope Collection and/or
   * replaces the tag names, all in one transaction under a row lock; any failure leaves the file unchanged. Bytes,
   * hash, size, MIME type and storage key are never touched.
   */
  async update(principal: Principal, scope: ScopeRef, fileId: string, input: UpdateFileInput): Promise<FileDto> {
    this.authorization.assertCan(principal, 'file.update', scope);
    if (!isUuid(fileId)) throw new NotFoundException('Not Found');
    const id = fileId.toLowerCase();
    return this.dataSource.transaction(async (manager) => {
      const locked = (await manager.query(`SELECT "id", "name", "collection_id" FROM "files" WHERE "id" = $1 AND "scope_key" = $2 FOR UPDATE`, [
        id,
        scopeKeyOf(scope),
      ])) as { name: string; collection_id: string | null }[];
      if (locked.length === 0) throw new NotFoundException('Not Found');
      const current = locked[0]!;

      let name = current.name;
      if (input.name !== undefined) {
        name = sanitizeFileName(input.name);
      }
      let collectionId = current.collection_id;
      if (input.collectionId !== undefined) {
        // null clears; a malformed, unknown or other-scope id gives the same 400.
        collectionId = await this.collections.resolveMembership(manager, scope, input.collectionId);
      }
      await manager.query(`UPDATE "files" SET "name" = $2, "extension" = $3, "collection_id" = $4, "updated_at" = now() WHERE "id" = $1`, [
        id,
        name,
        extensionOf(name),
        collectionId,
      ]);
      let tagNames: string[];
      if (input.tags !== undefined) tagNames = await this.tags.replaceFileTags(manager, scope, id, input.tags);
      else tagNames = await this.tagNames(manager, scope, id);
      return this.load(manager, scope, id, tagNames);
    });
  }

  /**
   * `file.delete` (`files:delete`). In one transaction: records the cleanup intent for the stored original, removes the
   * join rows and the row. Only after the commit `file.deleted` is emitted; its listener (and the startup recovery)
   * removes the object. A failing listener or storage never turns the committed deletion into an error.
   */
  async remove(principal: Principal, scope: ScopeRef, fileId: string): Promise<void> {
    this.authorization.assertCan(principal, 'file.delete', scope);
    if (!isUuid(fileId)) throw new NotFoundException('Not Found');
    const id = fileId.toLowerCase();
    await this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(`SELECT "storage_key" FROM "files" WHERE "id" = $1 AND "scope_key" = $2 FOR UPDATE`, [id, scopeKeyOf(scope)])) as {
        storage_key: string;
      }[];
      if (rows.length === 0) throw new NotFoundException('Not Found');
      await this.cleanup.record(manager, [{ storageKey: rows[0]!.storage_key, resourceType: 'file', resourceId: id, scopeKey: scopeKeyOf(scope) }]);
      await manager.query(`DELETE FROM "file_tags" WHERE "file_id" = $1 AND "scope_key" = $2`, [id, scopeKeyOf(scope)]);
      await manager.query(`DELETE FROM "files" WHERE "id" = $1 AND "scope_key" = $2`, [id, scopeKeyOf(scope)]);
    });
    try {
      await this.events.emitAsync(FILE_DELETED_EVENT, { id, scope });
    } catch (err) {
      this.logger.error(`file.deleted listener failed for file ${id} (${err instanceof Error ? err.name : 'unknown'})`);
    }
  }

  private async tagNames(manager: EntityManager, scope: ScopeRef, id: string): Promise<string[]> {
    const rows = (await manager.query(
      `SELECT t."name" FROM "file_tags" ft JOIN "tags" t ON t."id" = ft."tag_id" WHERE ft."file_id" = $1 AND ft."scope_key" = $2 ORDER BY t."name"`,
      [id, scopeKeyOf(scope)],
    )) as { name: string }[];
    return rows.map((r) => r.name);
  }

  /**
   * Newest first with a stable (created_at, id) order. The cursor carries the last row's microsecond timestamp text and
   * id, so rows that share a timestamp are neither repeated nor skipped. Every predicate, join and subquery is bound to
   * this scope's key: a Collection or tag from another scope simply matches nothing, like a missing one.
   */
  async list(principal: Principal, scope: ScopeRef, rawQuery: unknown): Promise<FileListPage<FileDto>> {
    this.authorization.assertCan(principal, 'file.list', scope);
    const q = parseFileListQuery(rawQuery);
    await this.assertScopeExists(scope);

    const scopeKey = scopeKeyOf(scope);
    const params: unknown[] = [scopeKey];
    const where = [`f."scope_key" = $1`];
    const bind = (value: unknown) => `$${params.push(value)}`;
    if (q.collectionId) where.push(`f."collection_id" = ${bind(q.collectionId)}::uuid`);
    if (q.status) where.push(`f."ingestion_status" = ${bind(q.status)}`);
    if (q.name) where.push(`position(lower(${bind(q.name)}::text) in lower(f."name")) > 0`);
    if (q.tag) {
      where.push(
        `EXISTS (SELECT 1 FROM "file_tags" ft JOIN "tags" t ON t."id" = ft."tag_id" AND t."scope_key" = ft."scope_key"
           WHERE ft."file_id" = f."id" AND ft."scope_key" = f."scope_key" AND t."name" = ${bind(q.tag)})`,
      );
    }
    if (q.cursor) {
      where.push(`(f."created_at", f."id") < (${bind(q.cursor.createdAt)}::timestamptz, ${bind(q.cursor.id)}::uuid)`);
    }
    const rows = (await this.dataSource.query(
      `SELECT ${FILE_COLUMNS_F}, to_char(f."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursor_ts"
       FROM "files" f WHERE ${where.join(' AND ')}
       ORDER BY f."created_at" DESC, f."id" DESC LIMIT ${bind(q.limit + 1)}`,
      params,
    )) as (FileRow & { cursor_ts: string })[];

    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const tagsByFile = await this.tagNamesFor(scopeKey, page.map((r) => r.id));
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toFileDto(r, tagsByFile.get(r.id) ?? [])),
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.cursor_ts, id: last.id }) : null,
      hasMore,
      limit: q.limit,
    };
  }

  async get(principal: Principal, scope: ScopeRef, fileId: string): Promise<FileDto> {
    this.authorization.assertCan(principal, 'file.get', scope);
    const row = await this.findRow(scope, fileId);
    const tags = await this.tagNamesFor(scopeKeyOf(scope), [row.id]);
    return toFileDto(row, tags.get(row.id) ?? []);
  }

  /**
   * Authorizes, finds the row inside the scope, then opens the original. The stream is opened before any response
   * header is written, so a missing object is a plain 404 that names no key or path.
   */
  async openDownload(
    principal: Principal,
    scope: ScopeRef,
    fileId: string,
  ): Promise<{ stream: Readable; name: string; mimeType: string; sizeBytes: number }> {
    this.authorization.assertCan(principal, 'file.download', scope);
    const row = await this.findRow(scope, fileId, true);
    let stream: Readable;
    try {
      stream = await this.storage.get(row.storage_key!);
    } catch (err) {
      if (!(err instanceof StorageObjectNotFoundError)) {
        this.logger.error(`Could not open original for file ${row.id} (${err instanceof Error ? err.name : 'unknown'})`);
      }
      throw new NotFoundException('Not Found');
    }
    return { stream, name: row.name, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes) };
  }

  private async findRow(scope: ScopeRef, fileId: string, withKey = false): Promise<FileRow & { storage_key?: string }> {
    if (!isUuid(fileId)) throw new NotFoundException('Not Found');
    await this.assertScopeExists(scope);
    const rows = (await this.dataSource.query(
      `SELECT ${FILE_COLUMNS_F}${withKey ? ', f."storage_key"' : ''} FROM "files" f WHERE f."id" = $1 AND f."scope_key" = $2`,
      [fileId.toLowerCase(), scopeKeyOf(scope)],
    )) as (FileRow & { storage_key?: string })[];
    if (rows.length === 0) throw new NotFoundException('Not Found');
    return rows[0]!;
  }

  private async tagNamesFor(scopeKey: string, fileIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (fileIds.length === 0) return out;
    const rows = (await this.dataSource.query(
      `SELECT ft."file_id", t."name" FROM "file_tags" ft JOIN "tags" t ON t."id" = ft."tag_id" AND t."scope_key" = ft."scope_key"
       WHERE ft."scope_key" = $1 AND ft."file_id" = ANY($2::uuid[]) ORDER BY t."name"`,
      [scopeKey, fileIds],
    )) as { file_id: string; name: string }[];
    for (const r of rows) out.set(r.file_id, [...(out.get(r.file_id) ?? []), r.name]);
    return out;
  }

  private async load(manager: EntityManager, scope: ScopeRef, id: string, tagNames: string[]): Promise<FileDto> {
    const rows = (await manager.query(
      `SELECT "id", "scope", "workspace_id", "name", "extension", "mime_type", "size_bytes", "sha256", "collection_id", "ingestion_status", "created_at", "updated_at"
       FROM "files" WHERE "id" = $1 AND "scope_key" = $2`,
      [id, scopeKeyOf(scope)],
    )) as FileRow[];
    return toFileDto(rows[0]!, tagNames);
  }

  /** Post-commit: a listener failure is logged by class name and never turns the committed upload into an error. */
  private async emitUploaded(payload: FileUploadedEvent): Promise<void> {
    try {
      await this.events.emitAsync(FILE_UPLOADED_EVENT, payload);
    } catch (err) {
      this.logger.error(`file.uploaded listener failed for file ${payload.id} (${err instanceof Error ? err.name : 'unknown'})`);
    }
  }

  private async discard(id: string, key: string, scope: ScopeRef): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (err) {
      this.logger.error(`Could not remove upload object for file ${id} (${err instanceof Error ? err.name : 'unknown'})`);
      // Persist the key so the object is retried (also after a restart) instead of being orphaned.
      try {
        await this.cleanup.record(this.dataSource.manager, [{ storageKey: key, resourceType: 'file', resourceId: id, scopeKey: scopeKeyOf(scope) }]);
        void this.cleanup.drain({ resourceId: id });
      } catch {
        // nothing more to do; the original error is what the caller sees
      }
    }
  }

  private async assertScopeExists(scope: ScopeRef): Promise<void> {
    if (scope.kind === 'global') return;
    const rows = (await this.dataSource.query(`SELECT 1 FROM "workspaces" WHERE "id" = $1`, [scope.workspaceId])) as unknown[];
    if (rows.length === 0) throw new NotFoundException('Not Found');
  }
}
