import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { type ScopeRef } from '../scopes/scope-ref.js';
import { FILE_STORAGE, type FileStorage } from './file-storage.js';

export const CLEANUP_BATCH_SIZE = 50;
/** How long a claimed intent is invisible to other attempts (also the crash-recovery delay). */
export const CLEANUP_LEASE_SECONDS = 60;
export const CLEANUP_BACKOFF_BASE_SECONDS = 5;
export const CLEANUP_BACKOFF_MAX_SECONDS = 3600;

/** Bounded exponential backoff: 5s, 10s, 20s ... capped at one hour. `attempts` counts failures so far (>= 1). */
export function cleanupBackoffSeconds(attempts: number): number {
  const exp = Math.min(Math.max(attempts, 1) - 1, 20);
  return Math.min(CLEANUP_BACKOFF_BASE_SECONDS * 2 ** exp, CLEANUP_BACKOFF_MAX_SECONDS);
}

export interface CleanupIntentInput {
  storageKey: string;
  resourceType: 'file';
  resourceId: string;
  scopeKey: string;
}

interface ClaimedIntent {
  id: string;
  storage_key: string;
  resource_id: string;
  attempts: number;
}

/**
 * Post-commit removal of stored originals, driven by a persisted ledger (`storage_cleanup_intents`).
 *
 * - Intents are recorded with the caller's EntityManager, i.e. in the transaction that deletes the owning rows, so they
 *   exist if and only if the deletion committed.
 * - `drain` claims due intents with a lease (`FOR UPDATE SKIP LOCKED`), deletes the objects through FileStorage
 *   (already-missing objects succeed) and removes the intent only on success. Duplicate or concurrent drains skip
 *   claimed rows, and deleting an object twice is harmless.
 * - A failure keeps the intent, increments `attempts`, sets bounded backoff and arms a timer; on startup every pending
 *   intent is recovered. Failures are logged by intent/resource id and error class only, never keys, paths or content.
 */
@Injectable()
export class StorageCleanupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('StorageCleanup');
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    @Inject(getDataSourceToken()) private readonly dataSource: DataSource,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  onApplicationBootstrap(): void {
    // Recovery must never delay or fail startup.
    void this.drain().catch(() => undefined);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Records intents inside the caller's transaction. Idempotent per storage key. */
  async record(manager: EntityManager, intents: CleanupIntentInput[]): Promise<void> {
    for (const i of intents) {
      await manager.query(
        `INSERT INTO "storage_cleanup_intents" ("storage_key", "resource_type", "resource_id", "scope_key")
         VALUES ($1, $2, $3, $4) ON CONFLICT ("storage_key") DO NOTHING`,
        [i.storageKey, i.resourceType, i.resourceId, i.scopeKey],
      );
    }
  }

  /**
   * For the later Workspace cleanup: inside the caller's transaction, captures the keys of every file of the scope
   * as intents, then deletes the join rows and the files in FK-safe order. Returns the number of files removed.
   */
  async deleteScopedFilesWithIntents(manager: EntityManager, scope: ScopeRef): Promise<number> {
    const scopeKey = scope.kind === 'global' ? 'global' : scope.workspaceId.toLowerCase();
    await manager.query(
      `INSERT INTO "storage_cleanup_intents" ("storage_key", "resource_type", "resource_id", "scope_key")
       SELECT "storage_key", 'file', "id", "scope_key" FROM "files" WHERE "scope_key" = $1
       ON CONFLICT ("storage_key") DO NOTHING`,
      [scopeKey],
    );
    await manager.query(`DELETE FROM "file_tags" WHERE "scope_key" = $1`, [scopeKey]);
    const deleted = (await manager.query(`DELETE FROM "files" WHERE "scope_key" = $1 RETURNING "id"`, [scopeKey])) as unknown;
    const rows = (Array.isArray(deleted) && Array.isArray(deleted[0]) ? deleted[0] : deleted) as unknown[];
    return rows.length;
  }

  /** Attempts every due intent (optionally only those of one resource or one scope). Never throws. */
  async drain(filter: { resourceId?: string; scopeKey?: string } = {}): Promise<{ removed: number; failed: number }> {
    let removed = 0;
    let failed = 0;
    try {
      for (;;) {
        const claimed = await this.claim(filter);
        if (claimed.length === 0) break;
        for (const intent of claimed) {
          if (await this.attempt(intent)) removed++;
          else failed++;
        }
        if (claimed.length < CLEANUP_BATCH_SIZE) break;
      }
    } catch (err) {
      this.logger.error(`Storage cleanup drain failed (${err instanceof Error ? err.name : 'unknown'})`);
    }
    if (failed > 0) await this.armTimer();
    return { removed, failed };
  }

  private async claim(filter: { resourceId?: string; scopeKey?: string }): Promise<ClaimedIntent[]> {
    const result = (await this.dataSource.query(
      `UPDATE "storage_cleanup_intents" SET "next_attempt_at" = now() + make_interval(secs => $3)
       WHERE "id" IN (
         SELECT "id" FROM "storage_cleanup_intents"
         WHERE "next_attempt_at" <= now()
           AND ($1::uuid IS NULL OR "resource_id" = $1::uuid)
           AND ($2::text IS NULL OR "scope_key" = $2::text)
         ORDER BY "next_attempt_at", "created_at" LIMIT ${CLEANUP_BATCH_SIZE} FOR UPDATE SKIP LOCKED)
       RETURNING "id", "storage_key", "resource_id", "attempts"`,
      [filter.resourceId ?? null, filter.scopeKey ?? null, CLEANUP_LEASE_SECONDS],
    )) as unknown;
    return (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as ClaimedIntent[];
  }

  private async attempt(intent: ClaimedIntent): Promise<boolean> {
    try {
      await this.storage.delete(intent.storage_key); // ENOENT is success by the FileStorage contract
      await this.dataSource.query(`DELETE FROM "storage_cleanup_intents" WHERE "id" = $1`, [intent.id]);
      return true;
    } catch (err) {
      const name = (err instanceof Error ? err.name : 'unknown').slice(0, 100);
      this.logger.error(`Could not remove stored original for ${intent.resource_id} (intent ${intent.id}, attempt ${intent.attempts + 1}, ${name})`);
      try {
        await this.dataSource.query(
          `UPDATE "storage_cleanup_intents" SET "attempts" = "attempts" + 1, "last_error" = $2,
             "next_attempt_at" = now() + make_interval(secs => $3) WHERE "id" = $1`,
          [intent.id, name, cleanupBackoffSeconds(intent.attempts + 1)],
        );
      } catch {
        // the lease expires on its own and the intent is retried
      }
      return false;
    }
  }

  /** Re-arms one in-process timer at the earliest pending due time (at most the maximum backoff away). */
  private async armTimer(): Promise<void> {
    if (this.stopped) return;
    try {
      const rows = (await this.dataSource.query(
        `SELECT GREATEST(extract(epoch FROM (min("next_attempt_at") - now())), 1)::float AS secs FROM "storage_cleanup_intents"`,
      )) as { secs: number | null }[];
      const secs = rows[0]?.secs;
      if (secs == null) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.drain();
      }, Math.min(secs, CLEANUP_BACKOFF_MAX_SECONDS) * 1000);
      this.timer.unref();
    } catch {
      // the next startup recovers
    }
  }
}
