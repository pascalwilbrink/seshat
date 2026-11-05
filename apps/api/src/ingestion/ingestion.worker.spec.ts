import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { INGEST_FILE_QUEUE } from '../queue/queue.constants.js';
import type { QueueService } from '../queue/queue.service.js';
import { IngestionWorker } from './ingestion.worker.js';
import type { IngestionProcessor } from './ingestion.processor.js';

const ID = '8f14e45f-ceea-4e67-a1b2-0c9d3e4f5a6b';

function setup() {
  const queue = { registerWorker: vi.fn(async () => {}), enqueue: vi.fn(async () => 'queued' as const) };
  const processor = { process: vi.fn(async () => {}) };
  const worker = new IngestionWorker(queue as unknown as QueueService, processor as unknown as IngestionProcessor);
  return { queue, processor, worker };
}

describe('IngestionWorker', () => {
  it('registers the real processor as the ingest-file worker', async () => {
    const { queue, processor, worker } = setup();
    await worker.onModuleInit();
    expect(queue.registerWorker).toHaveBeenCalledWith(INGEST_FILE_QUEUE, expect.any(Function));
    const ctx = { fileId: ID, attempt: 1, maxAttempts: 3, isFinalAttempt: false };
    await (queue.registerWorker.mock.calls[0] as unknown as [string, (c: unknown) => Promise<void>])[1](ctx);
    expect(processor.process).toHaveBeenCalledWith(ctx);
  });

  it('enqueues the uploaded file id only', async () => {
    const { queue, worker } = setup();
    await worker.onFileUploaded({ id: ID, scope: { kind: 'global' } });
    expect(queue.enqueue).toHaveBeenCalledExactlyOnceWith(ID);
  });

  it('logs an enqueue failure by class only and does not throw', async () => {
    const { queue, worker } = setup();
    queue.enqueue.mockRejectedValueOnce(Object.assign(new Error('postgres://u:pw@h SENTINEL'), { name: 'QueueUnavailableError' }));
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    await expect(worker.onFileUploaded({ id: ID, scope: { kind: 'global' } })).resolves.toBeUndefined();
    expect(JSON.stringify(spy.mock.calls)).toContain('QueueUnavailableError');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('SENTINEL');
    spy.mockRestore();
  });
});
