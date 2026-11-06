/** pg-boss keeps its tables in this schema, never next to the application tables in `public`. */
export const QUEUE_SCHEMA = 'pgboss';

/** Queue that carries one job per file to ingest. */
export const INGEST_FILE_QUEUE = 'ingest-file';
/** Queue that carries one job per Memory embedding generation (payload: scope key, Memory id, generation; never text). */
export const EMBED_MEMORY_QUEUE = 'embed-memory';
/** Queue of the daily usage pruning job (payload: none). */
export const PRUNE_USAGE_QUEUE = 'prune-usage';
/** pg-boss cron (evaluated in UTC): once a day at 03:15. */
export const PRUNE_USAGE_CRON = '15 3 * * *';
export type QueueName = typeof INGEST_FILE_QUEUE | typeof EMBED_MEMORY_QUEUE | typeof PRUNE_USAGE_QUEUE;

/**
 * pg-boss `retryLimit` counts retries after the first attempt (verified against the installed version in
 * `test/queue.integration.spec.ts`), so 2 retries are 3 attempts in total.
 */
export const INGEST_MAX_ATTEMPTS = 3;
export const INGEST_RETRY_LIMIT = INGEST_MAX_ATTEMPTS - 1;
/** Base delay of the exponential backoff between attempts, in seconds (jittered by pg-boss). */
export const INGEST_RETRY_DELAY_SECONDS = 10;
export const INGEST_RETRY_DELAY_MAX_SECONDS = 300;
/** A job that stays active longer than this is failed by pg-boss and retried. */
export const INGEST_EXPIRE_SECONDS = 1800;
/** How long `stop` waits for running jobs before giving up. */
export const QUEUE_STOP_TIMEOUT_MS = 30_000;
