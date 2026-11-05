/** Failure codes are fixed strings; anything else is mapped to `job_failed`. */
const SAFE_CODE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * The only error shape that reaches pg-boss. pg-boss stores a thrown error's name, message and stack in the job
 * output, so none of those may carry file contents, provider messages or credentials: the message is a short code,
 * and the stack is replaced by the same code.
 */
export class QueueJobFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'QueueJobFailure';
    this.stack = `${this.name}: ${code}`;
  }
}

/** Raised by `enqueue` when the queue is not running or the database refused the job. Never carries driver text. */
export class QueueUnavailableError extends Error {
  constructor(readonly code: 'not_started' | 'enqueue_failed') {
    super(`Queue unavailable (${code})`);
    this.name = 'QueueUnavailableError';
  }
}

/** Raised when pg-boss cannot start. The message never contains connection details. */
export class QueueStartError extends Error {
  constructor(code?: string) {
    super(`Queue start failed${code ? ` (${code})` : ''}; check DATABASE_URL and that the role may create the pg-boss schema`);
    this.name = 'QueueStartError';
  }
}

/** A short, driver-level code (ECONNREFUSED, 28P01, 42501 ...) or undefined; never a message. */
export function safeErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,24}$/.test(code) ? code : undefined;
}

/** Maps any thrown value to a safe failure. Only a `code` that is an allowlisted-shaped string survives. */
export function toQueueJobFailure(err: unknown): QueueJobFailure {
  if (err instanceof QueueJobFailure) return err;
  const code = (err as { code?: unknown } | null)?.code;
  return new QueueJobFailure(typeof code === 'string' && SAFE_CODE.test(code) ? code : 'job_failed');
}
