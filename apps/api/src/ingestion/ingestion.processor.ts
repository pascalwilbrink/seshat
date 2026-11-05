import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { chunkDocuments, type Chunk, type ChunkOptions } from './chunker.js';
import { EmbeddingError, validateEmbeddings, type EmbeddingService } from './embedding.service.js';
import { extensionOf } from './file-ingestor.js';
import type { FileIngestorProvider } from './file-ingestor.provider.js';
import { isPermanentIngestionError, OriginalMissingError } from './ingestion-errors.js';
import { QueueJobFailure, type IngestJobContext } from '../queue/index.js';
import { StorageObjectNotFoundError, type FileStorage } from '../storage/file-storage.js';

/** The only texts that can reach `files.ingestion_error` besides the fixed messages of permanent `IngestionError`s. */
export const INGESTION_ERROR_MESSAGES = {
  provider_failed: 'Embedding provider request failed',
  invalid_output: 'Embedding provider returned invalid output',
  job_failed: 'Ingestion failed',
} as const;

/** Rows per multi-row INSERT (11 parameters each stays far below the 65535 limit). */
const INSERT_BATCH = 200;

interface FileRow {
  id: string;
  scope: 'global' | 'workspace';
  workspace_id: string | null;
  name: string;
  extension: string | null;
  storage_key: string;
}

/**
 * Processes one `ingest-file` job: pending -> processing -> indexed | failed.
 *
 * - The original is read only through `FileStorage`; provider network work (embedding) happens outside any
 *   transaction.
 * - The replacement of the file's chunks and the `indexed` metadata commit in ONE transaction that first locks the
 *   file row (`FOR UPDATE`). The lock serializes duplicate and re-index runs per file, so generations never mix, and
 *   the locked existence check means a file (or Workspace) deleted while reading or embedding is never recreated.
 * - Chunk ids are derived from file id, ordinal and content hash, so re-running yields identical rows.
 * - Permanent failures (`IngestionError`) are stored and end the job without retry. Other errors are rethrown as a
 *   safe code so pg-boss retries; on the final attempt the file becomes `failed` with an allowlisted message.
 * - Nothing here logs or stores file content, chunk text, vectors, keys or raw error messages.
 */
export class IngestionProcessor {
  private readonly logger = new Logger('Ingestion');
  /** In-process per-file serialization; across processes the row lock in the replacement transaction does it. */
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: FileStorage,
    private readonly ingestors: FileIngestorProvider,
    private readonly embeddings: EmbeddingService,
    private readonly chunking: ChunkOptions,
  ) {}

  process(context: IngestJobContext): Promise<void> {
    const previous = this.tails.get(context.fileId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.run(context));
    this.tails.set(context.fileId, run);
    const cleanup = () => {
      if (this.tails.get(context.fileId) === run) this.tails.delete(context.fileId);
    };
    run.then(cleanup, cleanup);
    return run;
  }

  private async run(context: IngestJobContext): Promise<void> {
    const { fileId } = context;
    const file = await this.markProcessing(fileId);
    if (!file) {
      this.logger.log(`Skipping file ${fileId}: it no longer exists`);
      return;
    }
    try {
      const chunks = await this.extract(file);
      const vectors = chunks.length === 0 ? [] : validateEmbeddings(await this.embeddings.embed(chunks.map((c) => c.content)), chunks.length, this.embeddings.dimension);
      const replaced = await this.replaceChunks(file, chunks, vectors);
      this.logger.log(replaced ? `Indexed file ${fileId} (${chunks.length} chunks)` : `File ${fileId} was deleted during processing; nothing written`);
    } catch (err) {
      await this.fail(file, err, context);
    }
  }

  /** pending|failed|indexed -> processing. Null when the file is gone. */
  private async markProcessing(fileId: string): Promise<FileRow | null> {
    const rows = (await this.dataSource.query(
      `UPDATE "files" SET "ingestion_status" = 'processing', "updated_at" = now() WHERE "id" = $1
       RETURNING "id", "scope", "workspace_id", "name", "extension", "storage_key"`,
      [fileId],
    )) as FileRow[][] | FileRow[];
    // pg returns [rows, count] for UPDATE ... RETURNING through TypeORM's query().
    const list = (Array.isArray(rows[0]) ? rows[0] : rows) as FileRow[];
    return list[0] ?? null;
  }

  private async extract(file: FileRow): Promise<Chunk[]> {
    const extension = (file.extension ?? extensionOf(file.name)).toLowerCase();
    const ingestor = this.ingestors.get(extension);
    let stream;
    try {
      stream = await this.storage.get(file.storage_key);
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) throw new OriginalMissingError();
      throw err;
    }
    const documents = await ingestor.ingest({ fileId: file.id, fileName: file.name, extension, stream });
    return chunkDocuments(documents, this.chunking);
  }

  /** Returns false when the file no longer exists (nothing was written). */
  private async replaceChunks(file: FileRow, chunks: Chunk[], vectors: number[][]): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const locked = (await manager.query(`SELECT "id" FROM "files" WHERE "id" = $1 FOR UPDATE`, [file.id])) as unknown[];
      if (locked.length === 0) return false;
      await manager.query(`DELETE FROM "chunks" WHERE "file_id" = $1`, [file.id]);
      await this.insertChunks(manager, file, chunks, vectors);
      await manager.query(
        `UPDATE "files" SET "ingestion_status" = 'indexed', "indexed_at" = now(), "chunk_count" = $2, "ingestion_error" = NULL, "updated_at" = now() WHERE "id" = $1`,
        [file.id, chunks.length],
      );
      return true;
    });
  }

  private async insertChunks(manager: EntityManager, file: FileRow, chunks: Chunk[], vectors: number[][]): Promise<void> {
    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      const params: unknown[] = [];
      const tuples: string[] = [];
      for (let j = i; j < Math.min(i + INSERT_BATCH, chunks.length); j++) {
        const c = chunks[j]!;
        const hash = createHash('sha256').update(c.content).digest('hex');
        const location: Record<string, unknown> = { startOffset: c.startOffset, endOffset: c.endOffset, startLine: c.startLine, endLine: c.endLine };
        if (c.section !== null) location.section = c.section;
        if (c.headingPath.length > 0) location.headingPath = c.headingPath;
        if (c.page !== undefined) location.page = c.page;
        const n = params.length;
        tuples.push(`($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, $${n + 8}, $${n + 9}, $${n + 10}::vector, $${n + 11})`);
        params.push(stableChunkId(file.id, c.ordinal, hash), file.scope, file.workspace_id, file.id, c.ordinal, c.content, JSON.stringify(location), c.content.length, hash, `[${vectors[j]!.join(',')}]`, this.embeddings.model);
      }
      await manager.query(
        `INSERT INTO "chunks" ("id", "scope", "workspace_id", "file_id", "ordinal", "content", "location", "char_count", "content_hash", "embedding", "embedding_model") VALUES ${tuples.join(', ')}`,
        params,
      );
    }
  }

  private async fail(file: FileRow, err: unknown, context: IngestJobContext): Promise<void> {
    // A delete during any stage (also surfacing as a storage or FK error) ends the job quietly.
    if (!(await this.exists(file.id))) {
      this.logger.log(`File ${file.id} was deleted during processing; ending quietly`);
      return;
    }
    if (isPermanentIngestionError(err)) {
      await this.setStatus(file.id, 'failed', err.message);
      this.logger.warn(`File ${file.id} failed permanently (${err.code})`);
      return;
    }
    const code = err instanceof EmbeddingError ? err.code : 'job_failed';
    if (context.isFinalAttempt) {
      await this.setStatus(file.id, 'failed', INGESTION_ERROR_MESSAGES[code]);
      this.logger.error(`File ${file.id} failed after ${context.attempt} attempts (${code})`);
    } else {
      await this.setStatus(file.id, 'pending', null);
      this.logger.warn(`File ${file.id} attempt ${context.attempt} failed (${code}); will retry`);
    }
    throw new QueueJobFailure(code);
  }

  private async exists(fileId: string): Promise<boolean> {
    return ((await this.dataSource.query(`SELECT 1 FROM "files" WHERE "id" = $1`, [fileId])) as unknown[]).length > 0;
  }

  /** Only moves a file that is still `processing`, so a concurrent successful run is never overwritten. */
  private async setStatus(fileId: string, status: 'failed' | 'pending', error: string | null): Promise<void> {
    await this.dataSource.query(
      `UPDATE "files" SET "ingestion_status" = $2, "ingestion_error" = $3, "updated_at" = now() WHERE "id" = $1 AND "ingestion_status" = 'processing'`,
      [fileId, status, error],
    );
  }
}

/** Deterministic UUID (v5-shaped) from file id, ordinal and content hash. */
function stableChunkId(fileId: string, ordinal: number, contentHash: string): string {
  const h = createHash('sha256').update(`chunk:${fileId}:${ordinal}:${contentHash}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
