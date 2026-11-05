import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueueService, type IngestJobContext, type QueueOptions } from '../src/queue/queue.service.js';
import { INGEST_FILE_QUEUE } from '../src/queue/queue.constants.js';
import { assertDisposableDatabase, describeIntegration, TEST_DATABASE_URL } from './helpers/integration.js';

/** Real pg-boss against TEST_DATABASE_URL, in a throwaway schema that is dropped after every test. */
describeIntegration('ingestion queue (real pg-boss)', () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  let schema: string;
  let client: Client;
  let services: QueueService[];

  const make = (overrides: Partial<QueueOptions> = {}) => {
    const s = new QueueService({
      connectionString: TEST_DATABASE_URL!,
      schema,
      ingestionConcurrency: 2,
      retryDelaySeconds: 1,
      pollingIntervalSeconds: 0.5,
      stopTimeoutMs: 5000,
      ...overrides,
    });
    services.push(s);
    return s;
  };
  const jobs = async (fileId: string) =>
    (await client.query(`SELECT state, retry_count, retry_limit, retry_backoff, output, data FROM "${schema}".job WHERE name = $1 AND singleton_key = $2 ORDER BY created_on`, [INGEST_FILE_QUEUE, fileId])).rows;
  const until = async (cond: () => Promise<boolean> | boolean, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('condition not met in time');
  };

  beforeEach(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    schema = `pgboss_t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    services = [];
    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
  });
  afterEach(async () => {
    for (const s of services) await s.beforeApplicationShutdown().catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await client.end();
  });

  it('uses its own schema, leaves application tables alone and stops cleanly', async () => {
    const q = make();
    await q.registerWorker(INGEST_FILE_QUEUE, async () => {});
    await q.onApplicationBootstrap();
    const rows = await client.query(`SELECT table_schema FROM information_schema.tables WHERE table_name = 'job'`);
    expect(rows.rows.map((r) => r.table_schema)).toContain(schema);
    expect(rows.rows.map((r) => r.table_schema)).not.toContain('public');
    await expect(q.beforeApplicationShutdown()).resolves.toBeUndefined();
    await expect(q.enqueue(randomUUID())).rejects.toMatchObject({ code: 'not_started' });
  });

  it('processes a job with the registered worker and stores only the file id', async () => {
    const seen: IngestJobContext[] = [];
    const q = make();
    await q.registerWorker(INGEST_FILE_QUEUE, async (c) => void seen.push(c));
    await q.onApplicationBootstrap();
    const id = randomUUID();
    await expect(q.enqueue(id)).resolves.toBe('queued');
    await until(async () => (await jobs(id))[0]?.state === 'completed');
    expect(seen).toEqual([{ fileId: id, attempt: 1, maxAttempts: 3, isFinalAttempt: false }]);
    expect((await jobs(id))[0].data).toEqual({ fileId: id });
  });

  it('does not consume or acknowledge jobs without a registered worker', async () => {
    const q = make();
    await q.onApplicationBootstrap();
    const id = randomUUID();
    await q.enqueue(id);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await jobs(id))[0].state).toBe('created');
  });

  it('suppresses duplicates while queued or active, and allows re-enqueue after completion and failure', async () => {
    const q = make({ ingestionConcurrency: 1 });
    const id = randomUUID();
    // Queued twice before any worker: one job.
    await q.onApplicationBootstrap();
    await expect(q.enqueue(id)).resolves.toBe('queued');
    await expect(q.enqueue(id)).resolves.toBe('already_queued');
    expect(await jobs(id)).toHaveLength(1);

    // Active: block the worker, enqueue again.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    await q.registerWorker(INGEST_FILE_QUEUE, async () => {
      runs += 1;
      await gate;
    });
    await until(async () => (await jobs(id))[0]?.state === 'active');
    await expect(q.enqueue(id)).resolves.toBe('already_queued');
    release();
    await until(async () => (await jobs(id))[0]?.state === 'completed');

    // Terminal job does not block explicit re-indexing.
    await expect(q.enqueue(id)).resolves.toBe('queued');
    await until(async () => (await jobs(id)).filter((j) => j.state === 'completed').length === 2);
    expect(runs).toBe(2);
  });

  it('re-enqueues after an exhausted (failed) job', async () => {
    const q = make();
    let fail = true;
    await q.registerWorker(INGEST_FILE_QUEUE, async () => {
      if (fail) throw new Error('nope');
    });
    await q.onApplicationBootstrap();
    const id = randomUUID();
    await q.enqueue(id);
    await until(async () => (await jobs(id))[0]?.state === 'failed');
    fail = false;
    await expect(q.enqueue(id)).resolves.toBe('queued');
    await until(async () => (await jobs(id)).some((j) => j.state === 'completed'));
  });

  it('makes three attempts in total with exponential backoff, then fails with a safe error', async () => {
    const attempts: IngestJobContext[] = [];
    const times: number[] = [];
    const q = make();
    await q.registerWorker(INGEST_FILE_QUEUE, async (c) => {
      attempts.push(c);
      times.push(Date.now());
      throw Object.assign(new Error('provider said sk-SENTINEL-KEY and CONTENT-SENTINEL'), {
        code: 'embedding_failed',
        stack: 'at SENTINEL-STACK',
      });
    });
    await q.onApplicationBootstrap();
    const id = randomUUID();
    await q.enqueue(id);
    await until(async () => (await jobs(id))[0]?.state === 'failed');
    expect(attempts.map((a) => [a.attempt, a.isFinalAttempt])).toEqual([[1, false], [2, false], [3, true]]);
    const [row] = await jobs(id);
    expect(row).toMatchObject({ retry_count: 2, retry_limit: 2, retry_backoff: true });
    // Backoff grows: second wait is at least the first one's minimum, and every wait honours the base delay.
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(900);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(900);
    const stored = JSON.stringify(row.output);
    expect(stored).toContain('embedding_failed');
    for (const secret of ['SENTINEL', 'sk-', 'CONTENT']) expect(stored).not.toContain(secret);
  });

  it('bounds parallelism by the configured concurrency', async () => {
    const q = make({ ingestionConcurrency: 2 });
    let active = 0;
    let peak = 0;
    let done = 0;
    await q.registerWorker(INGEST_FILE_QUEUE, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 700));
      active -= 1;
      done += 1;
    });
    await q.onApplicationBootstrap();
    for (let i = 0; i < 5; i += 1) await q.enqueue(randomUUID());
    await until(() => done === 5);
    expect(peak).toBe(2);
  });

  it('waits for a running job on shutdown before releasing connections', async () => {
    const q = make();
    let finished = false;
    await q.registerWorker(INGEST_FILE_QUEUE, async () => {
      await new Promise((r) => setTimeout(r, 1200));
      finished = true;
    });
    await q.onApplicationBootstrap();
    const id = randomUUID();
    await q.enqueue(id);
    await until(async () => (await jobs(id))[0]?.state === 'active');
    await q.beforeApplicationShutdown();
    expect(finished).toBe(true);
    expect((await jobs(id))[0].state).toBe('completed');
  });
});
