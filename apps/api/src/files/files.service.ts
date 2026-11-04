import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { Principal } from '../auth/principal.js';
import { CollectionsService } from '../collections/collection.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { type ScopeRef, isUuid, scopeColumns } from '../scopes/scope-ref.js';
import { FILE_STORAGE, type FileStorage, originalObjectKey } from '../storage/file-storage.js';
import { StorageCleanupService } from '../storage/storage-cleanup.service.js';
import { TagsService, scopeKeyOf } from '../tags/tags.service.js';
import { type FileDto, type FileRow, type UpdateFileInput, toFileDto } from './file.dto.js';
import { FILE_DELETED_EVENT, FILE_UPLOADED_EVENT, type FileUploadedEvent } from './file.events.js';
import { extensionOf, sanitizeFileName, sanitizeMimeType } from './file-name.js';
import { receiveUpload } from './upload-reader.js';

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
      await this.discard(id, key);
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

  private async discard(id: string, key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (err) {
      this.logger.error(`Could not remove upload object for file ${id} (${err instanceof Error ? err.name : 'unknown'})`);
    }
  }

  private async assertScopeExists(scope: ScopeRef): Promise<void> {
    if (scope.kind === 'global') return;
    const rows = (await this.dataSource.query(`SELECT 1 FROM "workspaces" WHERE "id" = $1`, [scope.workspaceId])) as unknown[];
    if (rows.length === 0) throw new NotFoundException('Not Found');
  }
}
