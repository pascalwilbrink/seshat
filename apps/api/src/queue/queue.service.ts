import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PgBoss, type Job } from 'pg-boss';
import {
  EMBED_MEMORY_QUEUE,
  INGEST_EXPIRE_SECONDS,
  INGEST_FILE_QUEUE,
  INGEST_MAX_ATTEMPTS,
  INGEST_RETRY_DELAY_MAX_SECONDS,
  INGEST_RETRY_DELAY_SECONDS,
  INGEST_RETRY_LIMIT,
  QUEUE_STOP_TIMEOUT_MS,
  type QueueName,
} from './queue.constants.js';
import { QueueJobFailure, QueueStartError, QueueUnavailableError, safeErrorCode, toQueueJobFailure } from './queue-errors.js';

export const QUEUE_OPTIONS = Symbol('QUEUE_OPTIONS');
/** Test seam: builds the pg-boss instance. Production uses `new PgBoss(...)`. */
export const QUEUE_BOSS_FACTORY = Symbol('QUEUE_BOSS_FACTORY');

export interface QueueOptions {
  connectionString: string;
  /** Dedicated pg-boss schema. */
  schema: string;
  /** Parallel ingest jobs in this process. */
  ingestionConcurrency: number;
  /** Base backoff delay in seconds; tests lower it. */
  retryDelaySeconds?: number;
  /** Polling interval of workers in seconds (>= 0.5); tests lower it. */
  pollingIntervalSeconds?: number;
  stopTimeoutMs?: number;
}

/** What a worker learns about the job it processes: identity and attempt only, never content. */
export interface IngestJobContext {
  fileId: string;
  /** 1-based attempt number. */
  attempt: number;
  maxAttempts: number;
  /** True when a failure of this attempt is final (pg-boss will not retry it). */
  isFinalAttempt: boolean;
}

/** Throw to fail (and, unless final, retry) the job. Whatever is thrown is reduced to a safe code before storage. */
export type IngestFileHandler = (context: IngestJobContext) => Promise<void>;

export interface IngestFileJobData {
  fileId: string;
}

/** Payload of an `embed-memory` job: identity and generation token only, never text or vectors. */
export interface EmbedMemoryJobData {
  /** `global` or the Workspace id. */
  scope: string;
  memoryId: string;
  /** `memories.embedding_generation` the job was created for. */
  generation: number;
}

export interface EmbedMemoryJobContext extends EmbedMemoryJobData {
  /** 1-based attempt number. */
  attempt: number;
  maxAttempts: number;
  /** True when a failure of this attempt is final (pg-boss will not retry it). */
  isFinalAttempt: boolean;
}

export type EmbedMemoryHandler = (context: EmbedMemoryJobContext) => Promise<void>;

export type EnqueueResult = 'queued' | 'already_queued';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minimal pg-boss surface used here, so lifecycle tests can substitute a mock. */
export type BossLike = Pick<
  PgBoss,
  'on' | 'start' | 'stop' | 'createQueue' | 'updateQueue' | 'send' | 'work' | 'offWork'
>;

/**
 * pg-boss lifecycle and the ingestion queue.
 *
 * - Starts in `onApplicationBootstrap`, i.e. after every module initialised. This module injects the TypeORM
 *   DataSource, so the database bootstrap (connect, optional migrations) has already succeeded. pg-boss opens its
 *   own pool on the same DATABASE_URL and keeps its tables in its own schema.
 * - Workers are registered with `registerWorker` (typically in `onModuleInit`). They are only started once the
 *   schema and the queue exist; nothing is consumed before a real handler is registered, and there is no default
 *   consumer.
 * - The queue has the `exclusive` policy: at most one queued, retrying or active job per `singletonKey` (the file
 *   id). Completed, failed and cancelled jobs do not count, so a file can be indexed again later.
 * - Shutdown (`beforeApplicationShutdown`, which runs before TypeORM closes its pool) stops workers gracefully,
 *   waits for running jobs up to a timeout, then closes pg-boss's own connections. It never throws.
 * - Error events and job failures are reduced to codes: raw driver or provider messages are never logged or stored.
 */
@Injectable()
export class QueueService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Queue');
  private boss: BossLike | undefined;
  private started = false;
  private stopping = false;
  private readonly handlers = new Map<QueueName, (job: Job<any>) => Promise<void>>();
  private readonly workerIds = new Map<QueueName, string>();

  constructor(
    @Inject(QUEUE_OPTIONS) private readonly options: QueueOptions,
    @Optional() @Inject(QUEUE_BOSS_FACTORY) private readonly factory?: (options: QueueOptions) => BossLike,
  ) {}

  get isStarted(): boolean {
    return this.started;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /**
   * Registers the processor of a queue. Allowed once per queue. Before start it is remembered and the worker
   * begins after the queue exists; after start the worker begins immediately.
   */
  async registerWorker(queue: QueueName, handler: IngestFileHandler): Promise<void> {
    if (this.handlers.has(queue)) throw new Error(`A worker is already registered for queue ${queue}`);
    const run = (job: Job<any>) => runJob(job, handler);
    this.handlers.set(queue, run);
    if (this.started) await this.startWorker(queue, run);
  }

  /** Registers the processor of the `embed-memory` queue (once). Same start semantics as `registerWorker`. */
  async registerMemoryWorker(handler: EmbedMemoryHandler): Promise<void> {
    if (this.handlers.has(EMBED_MEMORY_QUEUE)) throw new Error(`A worker is already registered for queue ${EMBED_MEMORY_QUEUE}`);
    const run = (job: Job<any>) => runMemoryJob(job, handler);
    this.handlers.set(EMBED_MEMORY_QUEUE, run);
    if (this.started) await this.startWorker(EMBED_MEMORY_QUEUE, run);
  }

  /**
   * Queues an `embed-memory` job. The queue uses the standard policy (no singleton): a newer generation must always
   * be able to queue its own job, and stale or duplicate jobs are harmless because every write is generation-guarded.
   */
  async enqueueMemoryEmbedding(data: EmbedMemoryJobData): Promise<void> {
    if (!UUID.test(data.memoryId) || !(data.scope === 'global' || UUID.test(data.scope)) || !Number.isSafeInteger(data.generation) || data.generation < 0) {
      throw new TypeError('invalid memory embedding payload');
    }
    if (!this.boss || !this.started || this.stopping) throw new QueueUnavailableError('not_started');
    try {
      const payload: EmbedMemoryJobData = { scope: data.scope, memoryId: data.memoryId, generation: data.generation };
      await this.boss.send(EMBED_MEMORY_QUEUE, payload);
    } catch {
      throw new QueueUnavailableError('enqueue_failed');
    }
  }

  /**
   * Queues an `ingest-file` job for the file. Resolves `already_queued` when a job for the same file is still
   * queued, retrying or active (the running or waiting job covers it), `queued` otherwise.
   */
  async enqueue(fileId: string): Promise<EnqueueResult> {
    if (!UUID.test(fileId)) throw new TypeError('fileId must be a UUID');
    if (!this.boss || !this.started || this.stopping) throw new QueueUnavailableError('not_started');
    const data: IngestFileJobData = { fileId };
    try {
      const id = await this.boss.send(INGEST_FILE_QUEUE, data, { singletonKey: fileId });
      return id ? 'queued' : 'already_queued';
    } catch {
      throw new QueueUnavailableError('enqueue_failed');
    }
  }

  private async start(): Promise<void> {
    if (this.started) return;
    const boss = this.factory
      ? this.factory(this.options)
      : new PgBoss({
          connectionString: this.options.connectionString,
          schema: this.options.schema,
          // Workers hold a connection while they poll; leave room for sends and maintenance.
          max: this.options.ingestionConcurrency + 4,
          application_name: 'seshat-queue',
        });
    boss.on('error', (err) => this.logger.error(`pg-boss error${errorSuffix(err)}`));
    boss.on('warning', (warning) => this.logger.warn(`pg-boss warning${warningSuffix(warning)}`));
    this.boss = boss;
    try {
      await boss.start();
      const queueOptions = {
        retryLimit: INGEST_RETRY_LIMIT,
        retryDelay: this.options.retryDelaySeconds ?? INGEST_RETRY_DELAY_SECONDS,
        retryBackoff: true,
        retryDelayMax: INGEST_RETRY_DELAY_MAX_SECONDS,
        expireInSeconds: INGEST_EXPIRE_SECONDS,
      };
      for (const [queue, policy] of [
        [INGEST_FILE_QUEUE, 'exclusive'],
        [EMBED_MEMORY_QUEUE, 'standard'],
      ] as const) {
        await boss.createQueue(queue, { policy, ...queueOptions });
        // createQueue keeps an existing queue untouched: apply changed settings on later starts.
        await boss.updateQueue(queue, { retryLimit: queueOptions.retryLimit, retryDelay: queueOptions.retryDelay, retryBackoff: true, retryDelayMax: queueOptions.retryDelayMax, expireInSeconds: queueOptions.expireInSeconds });
      }
      this.started = true;
      for (const [queue, handler] of this.handlers) await this.startWorker(queue, handler);
    } catch (err) {
      this.started = false;
      this.boss = undefined;
      await boss.stop({ graceful: false, close: true, timeout: 5000 }).catch(() => undefined);
      throw new QueueStartError(safeErrorCode(err));
    }
    this.logger.log(`Queue started (schema ${this.options.schema}, concurrency ${this.options.ingestionConcurrency})`);
  }

  private async startWorker(queue: QueueName, handler: (job: Job<any>) => Promise<void>): Promise<void> {
    const boss = this.boss;
    if (!boss) throw new QueueUnavailableError('not_started');
    const id = await boss.work<unknown>(
      queue,
      {
        localConcurrency: this.options.ingestionConcurrency,
        batchSize: 1,
        pollingIntervalSeconds: this.options.pollingIntervalSeconds ?? 2,
      },
      async (jobs) => {
        for (const job of jobs) await handler(job);
      },
    );
    this.workerIds.set(queue, id);
  }

  private async stop(): Promise<void> {
    const boss = this.boss;
    if (!boss || this.stopping) return;
    this.stopping = true;
    this.started = false;
    try {
      await boss.stop({ graceful: true, close: true, timeout: this.options.stopTimeoutMs ?? QUEUE_STOP_TIMEOUT_MS });
    } catch (err) {
      this.logger.error(`Queue did not stop cleanly${errorSuffix(err)}`);
    } finally {
      this.boss = undefined;
      this.workerIds.clear();
    }
  }
}

async function runJob(job: Job<IngestFileJobData>, handler: IngestFileHandler): Promise<void> {
  const fileId = job.data?.fileId;
  if (typeof fileId !== 'string' || !UUID.test(fileId)) throw new QueueJobFailure('invalid_payload');
  const attempt = job.retryCount + 1;
  try {
    await handler({ fileId, attempt, maxAttempts: INGEST_MAX_ATTEMPTS, isFinalAttempt: attempt >= INGEST_MAX_ATTEMPTS });
  } catch (err) {
    throw toQueueJobFailure(err);
  }
}

async function runMemoryJob(job: Job<EmbedMemoryJobData>, handler: EmbedMemoryHandler): Promise<void> {
  const d = job.data as Partial<EmbedMemoryJobData> | undefined;
  if (
    typeof d?.memoryId !== 'string' || !UUID.test(d.memoryId) ||
    typeof d.scope !== 'string' || !(d.scope === 'global' || UUID.test(d.scope)) ||
    typeof d.generation !== 'number' || !Number.isSafeInteger(d.generation) || d.generation < 0
  ) {
    throw new QueueJobFailure('invalid_payload');
  }
  const attempt = job.retryCount + 1;
  try {
    await handler({ scope: d.scope, memoryId: d.memoryId, generation: d.generation, attempt, maxAttempts: INGEST_MAX_ATTEMPTS, isFinalAttempt: attempt >= INGEST_MAX_ATTEMPTS });
  } catch (err) {
    throw toQueueJobFailure(err);
  }
}

function errorSuffix(err: unknown): string {
  const code = safeErrorCode(err);
  return code ? ` (${code})` : '';
}

function warningSuffix(warning: unknown): string {
  const type = (warning as { type?: unknown } | null)?.type;
  return typeof type === 'string' && /^[a-z_]{1,40}$/.test(type) ? ` (${type})` : '';
}
