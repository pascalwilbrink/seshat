import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { EmbeddingError, type EmbeddingService, validateEmbeddings } from '../ingestion/embedding.service.js';
import type { EmbedMemoryJobContext, QueueService } from '../queue/index.js';
import { QueueJobFailure } from '../queue/queue-errors.js';
import { MEMORY_VECTOR_DIMENSION } from './memory.entity.js';

/** Inline embedding gives up after this long and falls back to a queued job. */
export const MEMORY_INLINE_EMBED_TIMEOUT_MS = 2500;
/** A pending record without a queued job is recovered by the reconciler once it is this old. */
export const MEMORY_RECONCILE_GRACE_MS = 30_000;
/** A job that was queued but never finished is queued again after this long. */
export const MEMORY_RECONCILE_STALE_MS = 15 * 60_000;
export const MEMORY_RECONCILE_BATCH = 100;
export const MEMORY_HINT_LIMIT = 3;
export const MEMORY_HINT_PREVIEW_CHARS = 120;

export interface MemoryEmbeddingOptions {
  inlineTimeoutMs?: number;
  reconcileGraceMs?: number;
  reconcileStaleMs?: number;
  /** Minimum cosine similarity of a hint (0 to 1). */
  similarityHint: number;
}

export interface MemoryHint {
  id: string;
  type: string;
  preview: string;
}

/** The text that is embedded: the optional title, then the content. */
export function memoryEmbeddingText(title: string | null, content: string): string {
  return title ? `${title}\n\n${content}` : content;
}

/** TypeORM's postgres driver answers `UPDATE ... RETURNING` with `[rows, affectedCount]`; SELECTs with plain rows. */
export function returnedRows<T>(result: unknown): T[] {
  return (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number' ? result[0] : result) as T[];
}

const vectorLiteral = (v: number[]): string => `[${v.join(',')}]`;

/**
 * Embeds Memories. Provider calls never run inside a database transaction: a lifecycle transaction commits first (the
 * record is `pending`, its `embedding_generation` bumped, any stale vector cleared), then this class tries inline with
 * a short timeout, and otherwise queues an `embed-memory` job. Every write is `UPDATE ... WHERE embedding_generation = $g
 * AND embedding_status = 'pending'`, so a late inline result, a stale retry or a job for a forgotten Memory can neither
 * restore an old vector nor recreate a row (nothing here ever inserts). The pending record itself is the outbox:
 * `reconcile` queues jobs for pending records that have none. Nothing here logs titles, contents, metadata, vectors or
 * provider messages; logs carry ids and error classes only.
 */
export class MemoryEmbeddingCoordinator {
  private readonly logger = new Logger('MemoryEmbedding');

  constructor(
    private readonly dataSource: DataSource,
    private readonly embeddings: EmbeddingService,
    private readonly queue: QueueService,
    private readonly options: MemoryEmbeddingOptions,
  ) {}

  get similarityHint(): number {
    return this.options.similarityHint;
  }

  /**
   * After a lifecycle commit: embed inline; if that fails or times out, queue a job. Returns the vector only when it
   * was stored (so hints can use it).
   */
  async embedAfterCommit(target: { scopeKey: string; id: string; generation: number; title: string | null; content: string }): Promise<number[] | null> {
    const vector = await this.embedInline(target);
    if (!vector) await this.schedule(target.scopeKey, target.id, target.generation);
    return vector;
  }

  private async embedInline(t: { scopeKey: string; id: string; generation: number; title: string | null; content: string }): Promise<number[] | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const call = this.embeddings.embed([memoryEmbeddingText(t.title, t.content)]);
      call.catch(() => undefined); // a result that arrives after the timeout is dropped, never written
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EmbeddingError('provider_failed', 'Embedding timed out')), this.options.inlineTimeoutMs ?? MEMORY_INLINE_EMBED_TIMEOUT_MS);
      });
      const [vector] = this.validate(await Promise.race([call, timeout]));
      return (await this.write(t.scopeKey, t.id, t.generation, vector!)) ? vector! : null;
    } catch (err) {
      this.logger.warn(`Inline embedding of Memory ${t.id} failed (${errorClass(err)}); a job will retry`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private validate(raw: unknown): number[][] {
    if (this.embeddings.dimension !== MEMORY_VECTOR_DIMENSION) throw new EmbeddingError('invalid_output', 'Embedding dimension does not match the memories column');
    return validateEmbeddings(raw, 1, MEMORY_VECTOR_DIMENSION);
  }

  /** Generation-guarded write of a ready vector. Resolves false when the record moved on, vanished or is not pending. */
  private async write(scopeKey: string, id: string, generation: number, vector: number[]): Promise<boolean> {
    const rows = returnedRows(await this.dataSource.query(
      `UPDATE "memories" SET "embedding" = $4::vector, "embedding_model" = $5, "embedding_status" = 'ready', "embedding_scheduled_at" = NULL
       WHERE "id" = $1 AND "scope_key" = $2 AND "embedding_generation" = $3 AND "embedding_status" = 'pending' RETURNING "id"`,
      [id, scopeKey, generation, vectorLiteral(vector), this.embeddings.model],
    ));
    return rows.length > 0;
  }

  /** Queues a job for this generation and marks the record scheduled. A failure leaves it unscheduled for the reconciler. */
  async schedule(scopeKey: string, id: string, generation: number): Promise<void> {
    try {
      await this.queue.enqueueMemoryEmbedding({ scope: scopeKey, memoryId: id, generation });
      await this.dataSource.query(
        `UPDATE "memories" SET "embedding_scheduled_at" = now()
         WHERE "id" = $1 AND "scope_key" = $2 AND "embedding_generation" = $3 AND "embedding_status" = 'pending'`,
        [id, scopeKey, generation],
      );
    } catch (err) {
      this.logger.warn(`Could not queue embedding of Memory ${id} (${errorClass(err)}); the reconciler will retry`);
    }
  }

  /** The `embed-memory` worker. Quietly does nothing for deleted, non-pending or newer-generation records. */
  async process(job: EmbedMemoryJobContext): Promise<void> {
    const [row] = (await this.dataSource.query(
      `SELECT "content", "title", "embedding_status", "embedding_generation" FROM "memories" WHERE "id" = $1 AND "scope_key" = $2`,
      [job.memoryId, job.scope],
    )) as { content: string; title: string | null; embedding_status: string; embedding_generation: number }[];
    if (!row || row.embedding_status !== 'pending') return;
    // A job of an older generation is stale: the newer generation has (or will get) its own job.
    if (row.embedding_generation !== job.generation) return;
    try {
      const [vector] = this.validate(await this.embeddings.embed([memoryEmbeddingText(row.title, row.content)]));
      await this.write(job.scope, job.memoryId, job.generation, vector!);
    } catch (err) {
      if (job.isFinalAttempt) {
        await this.dataSource.query(
          `UPDATE "memories" SET "embedding_status" = 'failed', "embedding_scheduled_at" = NULL
           WHERE "id" = $1 AND "scope_key" = $2 AND "embedding_generation" = $3 AND "embedding_status" = 'pending'`,
          [job.memoryId, job.scope, job.generation],
        );
      }
      // Only a fixed code reaches pg-boss; never the provider's message.
      throw new QueueJobFailure(err instanceof EmbeddingError ? err.code : 'embedding_failed');
    }
  }

  /** Queues jobs for pending records that have none (never scheduled, or scheduled long ago). Returns how many. */
  async reconcile(): Promise<number> {
    const grace = this.options.reconcileGraceMs ?? MEMORY_RECONCILE_GRACE_MS;
    const stale = this.options.reconcileStaleMs ?? MEMORY_RECONCILE_STALE_MS;
    const rows = (await this.dataSource.query(
      `SELECT "id", "scope_key", "embedding_generation" FROM "memories"
       WHERE "embedding_status" = 'pending'
         AND (("embedding_scheduled_at" IS NULL AND "updated_at" < now() - ($1::int * interval '1 millisecond'))
              OR "embedding_scheduled_at" < now() - ($2::int * interval '1 millisecond'))
       ORDER BY "updated_at" LIMIT ${MEMORY_RECONCILE_BATCH}`,
      [grace, stale],
    )) as { id: string; scope_key: string; embedding_generation: number }[];
    for (const r of rows) await this.schedule(r.scope_key, r.id, r.embedding_generation);
    return rows.length;
  }

  /** Up to three active, ready Memories of the same scope at or above the threshold, most similar first. */
  async hints(scopeKey: string, selfId: string, vector: number[]): Promise<MemoryHint[]> {
    const rows = (await this.dataSource.query(
      `SELECT "id", "type", left("content", ${MEMORY_HINT_PREVIEW_CHARS}) AS "preview" FROM "memories"
       WHERE "scope_key" = $1 AND "status" = 'active' AND "embedding_status" = 'ready' AND "embedding" IS NOT NULL AND "id" <> $2
         AND 1 - ("embedding" <=> $3::vector) >= $4
       ORDER BY "embedding" <=> $3::vector, "id" LIMIT ${MEMORY_HINT_LIMIT}`,
      [scopeKey, selfId, vectorLiteral(vector), this.options.similarityHint],
    )) as { id: string; type: string; preview: string }[];
    return rows.map((r) => ({ id: r.id, type: r.type, preview: r.preview }));
  }

  /** Admin retry of a failed record: pending again with a new generation, then queued. Returns the new generation or null. */
  async restart(scopeKey: string, id: string): Promise<number | null> {
    const rows = returnedRows<{ generation: number }>(await this.dataSource.query(
      `UPDATE "memories" SET "embedding_status" = 'pending', "embedding_generation" = "embedding_generation" + 1,
         "embedding_scheduled_at" = NULL, "embedding" = NULL, "embedding_model" = NULL, "updated_at" = now()
       WHERE "id" = $1 AND "scope_key" = $2 AND "embedding_status" = 'failed' RETURNING "embedding_generation" AS "generation"`,
      [id, scopeKey],
    ));
    return rows[0]?.generation ?? null;
  }
}

function errorClass(err: unknown): string {
  if (err instanceof EmbeddingError) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,24}$/.test(code) ? code : err instanceof Error ? err.name : 'unknown';
}
