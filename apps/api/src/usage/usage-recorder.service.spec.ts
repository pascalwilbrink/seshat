import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageRecorderService, USAGE_BUFFER_LIMITS, USAGE_FLUSH_INTERVAL_MS } from './usage-recorder.service.js';
import { UsageCollector } from './usage-request-context.js';
import type { UsageBatchInput } from './usage-batch.js';

const RID = '8f14e45f-ceea-4e67-a1b2-0c9d3e4f5a6b';
const WS = '11111111-1111-4111-8111-111111111111';
const ok = { status: 'applied' } as never;
const scope = { kind: 'workspace', workspaceId: WS } as const;
const access = { resourceKind: 'file', resourceId: RID, scope, channel: 'api', accessKind: 'read' } as const;

function setup(persist = vi.fn(async (_b: UsageBatchInput) => ok)) {
  const svc = new UsageRecorderService({ persistBatch: persist });
  return { svc, persist };
}

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-11-06T10:00:00Z') }));
afterEach(() => vi.useRealTimers());

describe('UsageRecorderService', () => {
  it('enqueue is synchronous, aggregates and performs no persistence', () => {
    const { svc, persist } = setup();
    svc.enqueueAccess(access);
    svc.enqueueAccess(access);
    expect(persist).not.toHaveBeenCalled();
  });

  it('flushes aggregated increments on the timer', async () => {
    const { svc, persist } = setup();
    svc.onModuleInit();
    svc.enqueueAccess(access);
    svc.enqueueAccess(access);
    svc.enqueueListCount({ workspaceId: WS, keyId: RID, keyName: 'k' });
    await vi.advanceTimersByTimeAsync(USAGE_FLUSH_INTERVAL_MS);
    const batches = persist.mock.calls.map((c) => c[0]);
    expect(batches.flatMap((b) => b.accesses ?? [])).toMatchObject([{ count: 2, day: '2026-11-06', resourceId: RID }]);
    expect(batches.flatMap((b) => b.listCounts ?? [])).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(USAGE_FLUSH_INTERVAL_MS);
    expect(persist).toHaveBeenCalledTimes(batches.length); // empty buffer: nothing more
    await svc.beforeApplicationShutdown();
  });

  it('retries a failed batch once with the same batch id, then succeeds', async () => {
    const persist = vi.fn<(b: UsageBatchInput) => Promise<never>>().mockRejectedValueOnce(new Error('uncertain commit')).mockResolvedValue(ok);
    const { svc } = setup(persist);
    svc.enqueueAccess(access);
    await svc.flush();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1]![0].batchId).toBe(persist.mock.calls[0]![0].batchId);
  });

  it('drops after the second failure and logs counts only', async () => {
    const persist = vi.fn(async () => {
      throw new Error('SECRET-SENTINEL driver text');
    });
    const { svc } = setup(persist);
    const logs: string[] = [];
    const spy = (m: unknown) => void logs.push(String(m));
    (svc as any).logger = { warn: spy, log: spy, error: spy };
    svc.enqueueAccess(access);
    await expect(svc.flush()).resolves.toBeUndefined();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(logs.join()).toContain('1 items');
    expect(logs.join()).not.toContain('SECRET-SENTINEL');
    await svc.flush();
    expect(persist).toHaveBeenCalledTimes(2); // dropped, not re-queued
  });

  it('keeps enqueues made during a flush for the next one and never overlaps commits', async () => {
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const persist = vi.fn(async (_b: UsageBatchInput) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gate;
      active--;
      return ok;
    });
    const { svc } = setup(persist);
    svc.enqueueAccess(access);
    const first = svc.flush();
    await Promise.resolve();
    svc.enqueueAccess({ ...access, resourceId: '9f14e45f-ceea-4e67-a1b2-0c9d3e4f5a6b' });
    const second = svc.flush();
    release();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
    const ids = persist.mock.calls.flatMap((c) => c[0].accesses ?? []).map((a) => a.resourceId).sort();
    expect(ids).toEqual([RID, '9f14e45f-ceea-4e67-a1b2-0c9d3e4f5a6b']);
  });

  it('bounds memory: overflow is dropped without throwing', async () => {
    const { svc, persist } = setup();
    for (let i = 0; i < USAGE_BUFFER_LIMITS.accesses + 5; i++) {
      expect(() => svc.enqueueAccess({ ...access, resourceId: `r${i}` })).not.toThrow();
    }
    await svc.flush();
    const n = persist.mock.calls.reduce((s, c) => s + (c[0].accesses?.length ?? 0), 0);
    expect(n).toBe(USAGE_BUFFER_LIMITS.accesses);
  });

  it('flushes on graceful shutdown and stops accepting afterwards', async () => {
    const { svc, persist } = setup();
    svc.onModuleInit();
    svc.enqueueMcpCall({
      workspaceId: WS, keyId: RID, keyName: 'k', tool: 'recall', outcome: 'ok', durationMs: 1, resultChars: 2,
      truncated: false, argsSummary: {}, touched: [],
    });
    await svc.beforeApplicationShutdown();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]![0].mcpCalls).toHaveLength(1);
    svc.enqueueAccess(access);
    await vi.advanceTimersByTimeAsync(USAGE_FLUSH_INTERVAL_MS * 2);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('enqueue never throws on malformed input', () => {
    const { svc } = setup();
    expect(() => svc.enqueueAccess(null as never)).not.toThrow();
    expect(() => svc.enqueueMcpCall(undefined as never)).not.toThrow();
    expect(() => svc.enqueueListCount(null as never)).not.toThrow();
  });
});

describe('UsageCollector', () => {
  function collector() {
    const recorder = { enqueueAccess: vi.fn() } as unknown as UsageRecorderService;
    return { c: new UsageCollector(recorder), enqueue: recorder.enqueueAccess as ReturnType<typeof vi.fn> };
  }
  const staged = { resourceKind: 'file', resourceId: RID, scope, accessKind: 'retrieved' } as const;

  it('deduplicates per request and commits with the explicit channel', () => {
    const { c, enqueue } = collector();
    c.run('mcp', (ctx) => {
      c.stage(staged);
      c.stage(staged); // second chunk of the same file
      c.stage({ ...staged, accessKind: 'read' });
      c.commit(ctx);
    });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls.every((a) => a[0].channel === 'mcp')).toBe(true);
  });

  it('discards staged accesses on failure and cannot commit afterwards', () => {
    const { c, enqueue } = collector();
    c.run('api', (ctx) => {
      c.stage(staged);
      c.discard(ctx);
      c.commit(ctx);
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('isolates simultaneous requests', async () => {
    const { c, enqueue } = collector();
    const other = '9f14e45f-ceea-4e67-a1b2-0c9d3e4f5a6b';
    await Promise.all([
      c.run('ui', async (ctx) => {
        c.stage(staged);
        await new Promise((r) => setTimeout(r, 10));
        c.commit(ctx);
      }),
      c.run('api', async (ctx) => {
        c.stage({ ...staged, resourceId: other });
        await new Promise((r) => setTimeout(r, 5));
        c.discard(ctx);
      }),
      vi.advanceTimersByTimeAsync(20),
    ]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]).toMatchObject({ resourceId: RID, channel: 'ui' });
  });

  it('records nothing without a request context (system reads)', () => {
    const { c, enqueue } = collector();
    c.stage(staged);
    c.touch({ resourceKind: 'file', resourceId: RID, scope, action: 'read' });
    c.commit();
    expect(c.current()).toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('keeps touched ids as metadata that is never counted', () => {
    const { c, enqueue } = collector();
    c.run('mcp', (ctx) => {
      c.touch({ resourceKind: 'memory', resourceId: RID, scope, action: 'created' });
      c.commit(ctx);
      expect(ctx.touched()).toHaveLength(1);
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
