import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

const SENTINEL = 'postgres://user:SENTINEL-secret-77@db.internal:5432/app';

describe('HealthService', () => {
  it('reports ok when the query succeeds', async () => {
    const query = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
    await expect(new HealthService({ query }).check()).resolves.toEqual({ status: 'ok', db: 'ok' });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('reports unreachable when the query fails, without exposing the error', async () => {
    const service = new HealthService({ query: vi.fn().mockRejectedValue(new Error(`connect failed ${SENTINEL}`)) });
    const report = await service.check();
    expect(report).toEqual({ status: 'error', db: 'unreachable' });
    expect(JSON.stringify(report)).not.toContain('SENTINEL');
  });

  it('reports unreachable when the query hangs', async () => {
    vi.useFakeTimers();
    try {
      const pending = new HealthService({ query: () => new Promise(() => undefined) }).check();
      await vi.advanceTimersByTimeAsync(3500);
      await expect(pending).resolves.toEqual({ status: 'error', db: 'unreachable' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('HealthController', () => {
  it('returns the ok report', async () => {
    const health = { check: async () => ({ status: 'ok', db: 'ok' }) } as unknown as HealthService;
    await expect(new HealthController(health).check()).resolves.toEqual({ status: 'ok', db: 'ok' });
  });

  it('throws 503 with the fixed body when unreachable', async () => {
    const health = { check: async () => ({ status: 'error', db: 'unreachable' }) } as unknown as HealthService;
    const err = await new HealthController(health).check().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getStatus()).toBe(503);
    expect((err as ServiceUnavailableException).getResponse()).toEqual({ status: 'error', db: 'unreachable' });
  });
});
