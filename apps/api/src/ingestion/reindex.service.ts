import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { Principal } from '../auth/principal.js';
import type { FileDto } from '../files/file.dto.js';
import type { IngestionStatus } from '../files/file.entity.js';
import { FilesService } from '../files/files.service.js';
import { QueueService } from '../queue/index.js';
import { type ScopeRef, isUuid } from '../scopes/scope-ref.js';
import { scopeKeyOf } from '../tags/tags.service.js';

/** Files handled per transaction when a whole scope is re-indexed. */
export const REINDEX_BATCH_SIZE = 200;

/** Counts only: a scope re-index never names files. */
export interface ReindexScopeResult {
  /** Files found in the scope. */
  matched: number;
  /** Files set to pending and queued now. */
  enqueued: number;
  /** Files set to pending whose already queued or retrying job will process them. */
  alreadyQueued: number;
  /** Files being processed right now; the running job covers them. */
  skippedProcessing: number;
}

interface Previous {
  id: string;
  status: IngestionStatus;
  error: string | null;
}

/**
 * Re-indexing. A file moves to `pending` (error cleared) in a transaction under its row lock, and only then is a job
 * queued through the shared singleton queue.
 *
 * Repeat requests: the queue allows one queued, retrying or active job per file.
 * - A file that is `processing` is left alone: the active job covers it and, because the status is not touched, a
 *   job that fails permanently cannot be overwritten into a state nobody will process.
 * - Otherwise a repeat request sets `pending` again and the enqueue answers `already_queued` when a job is waiting, or
 *   queues a new one. A file that stayed `pending` without a job (for instance a lost enqueue) is therefore recovered
 *   by simply asking again.
 * - If the queue refuses the job, the previous status and error are restored (only while the file is still
 *   `pending`) and the request fails with 503; a failed enqueue is never reported as a successful re-index.
 */
@Injectable()
export class ReindexService {
  constructor(
    @Inject(getDataSourceToken()) private readonly dataSource: DataSource,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  /** `file.reindex` (`files:write`). Returns the file as it is after the request. */
  async reindexFile(principal: Principal, scope: ScopeRef, fileId: string): Promise<FileDto> {
    this.authorization.assertCan(principal, 'file.reindex', scope);
    if (!isUuid(fileId)) throw new NotFoundException('Not Found');
    const id = fileId.toLowerCase();
    await this.assertScopeExists(scope);

    const previous = await this.dataSource.transaction(async (manager) => {
      const rows = await this.lockAndMarkPending(manager, scope, id);
      if (rows === null) throw new NotFoundException('Not Found');
      return rows[0] ?? null;
    });
    if (previous) {
      try {
        await this.queue.enqueue(id);
      } catch (err) {
        await this.restore([previous]);
        throw unavailable(err);
      }
    }
    return this.files.loadDto(scope, id);
  }

  /** `fileIndex:reindexScope` (admin only). Walks every file of the scope in bounded keyset batches. */
  async reindexScope(principal: Principal, scope: ScopeRef): Promise<ReindexScopeResult> {
    this.authorization.assertCan(principal, 'fileIndex:reindexScope', scope);
    await this.assertScopeExists(scope);

    const result: ReindexScopeResult = { matched: 0, enqueued: 0, alreadyQueued: 0, skippedProcessing: 0 };
    let after: string | null = null;
    for (;;) {
      const batch: { ids: string[]; previous: Previous[] } = await this.dataSource.transaction(async (manager) => {
        const locked = await this.lockBatch(manager, scope, after);
        const previous = await this.markPending(manager, locked);
        return { ids: locked.map((r) => r.id), previous };
      });
      if (batch.ids.length === 0) break;
      result.matched += batch.ids.length;
      result.skippedProcessing += batch.ids.length - batch.previous.length;
      for (let i = 0; i < batch.previous.length; i++) {
        try {
          const outcome = await this.queue.enqueue(batch.previous[i]!.id);
          if (outcome === 'queued') result.enqueued++;
          else result.alreadyQueued++;
        } catch (err) {
          // This file and the rest of the batch never got a job: put them back before failing.
          await this.restore(batch.previous.slice(i));
          throw unavailable(err);
        }
      }
      after = batch.ids[batch.ids.length - 1]!;
      if (batch.ids.length < REINDEX_BATCH_SIZE) break;
    }
    return result;
  }

  private async lockBatch(manager: EntityManager, scope: ScopeRef, after: string | null): Promise<Previous[]> {
    const rows = (await manager.query(
      `SELECT "id", "ingestion_status" AS "status", "ingestion_error" AS "error" FROM "files"
       WHERE "scope_key" = $1 AND ($2::uuid IS NULL OR "id" > $2::uuid)
       ORDER BY "id" ASC LIMIT $3 FOR UPDATE`,
      [scopeKeyOf(scope), after, REINDEX_BATCH_SIZE],
    )) as Previous[];
    return rows;
  }

  /** Locks one file; null when it does not exist in the scope, else the previous state (empty when it is processing). */
  private async lockAndMarkPending(manager: EntityManager, scope: ScopeRef, id: string): Promise<Previous[] | null> {
    const rows = (await manager.query(
      `SELECT "id", "ingestion_status" AS "status", "ingestion_error" AS "error" FROM "files" WHERE "id" = $1 AND "scope_key" = $2 FOR UPDATE`,
      [id, scopeKeyOf(scope)],
    )) as Previous[];
    if (rows.length === 0) return null;
    return this.markPending(manager, rows);
  }

  /** Sets every locked, non-processing file to pending with its error cleared; returns their previous state. */
  private async markPending(manager: EntityManager, locked: Previous[]): Promise<Previous[]> {
    const todo = locked.filter((r) => r.status !== 'processing');
    if (todo.length === 0) return [];
    await manager.query(
      `UPDATE "files" SET "ingestion_status" = 'pending', "ingestion_error" = NULL, "updated_at" = now() WHERE "id" = ANY($1::uuid[])`,
      [todo.map((r) => r.id)],
    );
    return todo;
  }

  /** Puts back the status and error of files that are still `pending` (a worker that already moved on is not undone). */
  private async restore(previous: Previous[]): Promise<void> {
    for (const p of previous) {
      await this.dataSource.query(
        `UPDATE "files" SET "ingestion_status" = $2, "ingestion_error" = $3, "updated_at" = now() WHERE "id" = $1 AND "ingestion_status" = 'pending'`,
        [p.id, p.status, p.error],
      );
    }
  }

  private async assertScopeExists(scope: ScopeRef): Promise<void> {
    if (scope.kind === 'global') return;
    const rows = (await this.dataSource.query(`SELECT 1 FROM "workspaces" WHERE "id" = $1`, [scope.workspaceId])) as unknown[];
    if (rows.length === 0) throw new NotFoundException('Not Found');
  }
}

function unavailable(_err: unknown): ServiceUnavailableException {
  // Only the fixed text: queue and driver messages never reach the client.
  return new ServiceUnavailableException('Ingestion queue is unavailable; try again later');
}
