import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { INGEST_FILE_QUEUE } from './queue.constants.js';
import { QueueJobFailure, QueueStartError, QueueUnavailableError, toQueueJobFailure } from './queue-errors.js';
import { QueueService, type BossLike, type QueueOptions } from './queue.service.js';

const FILE_ID = '8f14e45f-ceea-4e67-a1b2-0c9d3e4f5a6b';
const options: QueueOptions = { connectionString: 'postgres://u:p@h/db', schema: 'pgboss', ingestionConcurrency: 3 };

class MockBoss extends EventEmitter {
  calls: string[] = [];
  workHandler: ((jobs: any[]) => Promise<void>) | undefined;
  workOptions: any;
  sendResult: string | null = 'id-1';
  startError: unknown;
  stopError: unknown;
  start = vi.fn(async () => {
    this.calls.push('start');
    if (this.startError) throw this.startError;
    return this;
  });
  stop = vi.fn(async (_o?: unknown) => {
    this.calls.push('stop');
    if (this.stopError) throw this.stopError;
  });
  createQueue = vi.fn(async (..._a: unknown[]) => void this.calls.push('createQueue'));
  updateQueue = vi.fn(async (..._a: unknown[]) => void this.calls.push('updateQueue'));
  send = vi.fn(async (..._a: unknown[]) => this.sendResult);
  offWork = vi.fn();
  work = vi.fn(async (_name: string, o: unknown, h: (jobs: any[]) => Promise<void>) => {
    this.calls.push('work');
    this.workOptions = o;
    this.workHandler = h;
    return 'worker-1';
  });
}

function setup() {
  const boss = new MockBoss();
  const service = new QueueService(options, () => boss as unknown as BossLike);
  return { boss, service };
}

describe('QueueService lifecycle', () => {
  it('starts pg-boss, creates the queue and only then starts registered workers', async () => {
    const { boss, service } = setup();
    const handler = vi.fn(async () => {});
    await service.registerWorker(INGEST_FILE_QUEUE, handler);
    expect(boss.work).not.toHaveBeenCalled();
    await service.onApplicationBootstrap();
    expect(boss.calls).toEqual(['start', 'createQueue', 'updateQueue', 'work']);
    expect(boss.createQueue).toHaveBeenCalledWith(
      INGEST_FILE_QUEUE,
      expect.objectContaining({ policy: 'exclusive', retryLimit: 2, retryBackoff: true }),
    );
    expect(boss.workOptions).toMatchObject({ localConcurrency: 3, batchSize: 1 });
  });

  it('does not attach any consumer when no worker was registered', async () => {
    const { boss, service } = setup();
    await service.onApplicationBootstrap();
    expect(boss.work).not.toHaveBeenCalled();
    expect(service.isStarted).toBe(true);
  });

  it('starts a worker registered after start immediately, and refuses a second one', async () => {
    const { boss, service } = setup();
    await service.onApplicationBootstrap();
    await service.registerWorker(INGEST_FILE_QUEUE, async () => {});
    expect(boss.work).toHaveBeenCalledTimes(1);
    await expect(service.registerWorker(INGEST_FILE_QUEUE, async () => {})).rejects.toThrow(/already registered/);
  });

  it('stops gracefully on shutdown, is idempotent and never throws', async () => {
    const { boss, service } = setup();
    await service.onApplicationBootstrap();
    boss.stopError = Object.assign(new Error('secret connection string postgres://u:pw@h'), { code: 'ECONNRESET' });
    await expect(service.beforeApplicationShutdown()).resolves.toBeUndefined();
    await service.beforeApplicationShutdown();
    expect(boss.stop).toHaveBeenCalledTimes(1);
    expect(boss.stop.mock.calls[0]![0]).toMatchObject({ graceful: true, close: true });
    await expect(service.enqueue(FILE_ID)).rejects.toBeInstanceOf(QueueUnavailableError);
  });

  it('start failure releases connections and throws a sanitized error', async () => {
    const { boss, service } = setup();
    boss.startError = Object.assign(new Error('password authentication failed for postgres://u:pw@h'), { code: '28P01' });
    const err = await service.onApplicationBootstrap().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueueStartError);
    expect((err as Error).message).toContain('28P01');
    expect((err as Error).message).not.toContain('pw');
    expect(boss.stop).toHaveBeenCalledWith(expect.objectContaining({ graceful: false, close: true }));
    expect(service.isStarted).toBe(false);
  });

  it('logs error events as codes only', async () => {
    const { boss, service } = setup();
    const { Logger } = await import('@nestjs/common');
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    await service.onApplicationBootstrap();
    boss.emit('error', Object.assign(new Error('boom SENTINEL postgres://u:pw@h'), { code: 'ECONNREFUSED', stack: 'SENTINEL' }));
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toContain('SENTINEL');
    expect(JSON.stringify(spy.mock.calls)).toContain('ECONNREFUSED');
    spy.mockRestore();
  });
});

describe('enqueue', () => {
  it('sends only the file id with it as singleton key', async () => {
    const { boss, service } = setup();
    await service.onApplicationBootstrap();
    await expect(service.enqueue(FILE_ID)).resolves.toBe('queued');
    expect(boss.send).toHaveBeenCalledWith(INGEST_FILE_QUEUE, { fileId: FILE_ID }, { singletonKey: FILE_ID });
    boss.sendResult = null;
    await expect(service.enqueue(FILE_ID)).resolves.toBe('already_queued');
  });

  it('rejects before start, for invalid ids, and hides driver errors', async () => {
    const { boss, service } = setup();
    await expect(service.enqueue(FILE_ID)).rejects.toMatchObject({ code: 'not_started' });
    await service.onApplicationBootstrap();
    await expect(service.enqueue('not-a-uuid')).rejects.toThrow(TypeError);
    boss.send.mockRejectedValueOnce(new Error('relation SENTINEL does not exist'));
    const err = await service.enqueue(FILE_ID).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'enqueue_failed' });
    expect(String((err as Error).message)).not.toContain('SENTINEL');
  });
});

describe('worker wrapper', () => {
  async function run(handler: (c: any) => Promise<void>, job: object) {
    const { boss, service } = setup();
    await service.registerWorker(INGEST_FILE_QUEUE, handler);
    await service.onApplicationBootstrap();
    return boss.workHandler!([job]);
  }

  it('passes id and attempt info, marking the third attempt as final', async () => {
    const seen: unknown[] = [];
    for (const retryCount of [0, 1, 2]) await run(async (c) => void seen.push(c), { data: { fileId: FILE_ID }, retryCount });
    expect(seen).toEqual([
      { fileId: FILE_ID, attempt: 1, maxAttempts: 3, isFinalAttempt: false },
      { fileId: FILE_ID, attempt: 2, maxAttempts: 3, isFinalAttempt: false },
      { fileId: FILE_ID, attempt: 3, maxAttempts: 3, isFinalAttempt: true },
    ]);
  });

  it('reduces thrown errors to a safe code, dropping message, stack and extra fields', async () => {
    const raw = Object.assign(new Error('sk-SENTINEL content SENTINEL'), { code: 'embedding_failed', cause: 'SENTINEL' });
    const err = await run(async () => { throw raw; }, { data: { fileId: FILE_ID }, retryCount: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueueJobFailure);
    expect(JSON.stringify({ m: (err as Error).message, s: (err as Error).stack, c: (err as QueueJobFailure).code })).not.toContain('SENTINEL');
    expect((err as QueueJobFailure).code).toBe('embedding_failed');
    expect(toQueueJobFailure(new Error('x SENTINEL')).code).toBe('job_failed');
    expect(toQueueJobFailure({ code: 'Has SENTINEL spaces' }).code).toBe('job_failed');
  });

  it('fails jobs with an invalid payload without calling the handler', async () => {
    const handler = vi.fn(async () => {});
    const err = await run(handler, { data: { fileId: 'x', content: 'SENTINEL' }, retryCount: 0 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid_payload' });
    expect(handler).not.toHaveBeenCalled();
  });
});
