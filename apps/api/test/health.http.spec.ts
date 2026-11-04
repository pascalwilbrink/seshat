import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootHealthApp } from './helpers/health-app.js';

const SENTINEL = 'SENTINEL-cred-9f3a';

describe('GET /api/health (database-free)', () => {
  let app: Awaited<ReturnType<typeof bootHealthApp>> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  it('answers 200 {status:ok,db:ok} when the query succeeds', async () => {
    app = await bootHealthApp({ query: async () => [{ '?column?': 1 }] });
    const res = await app.get();
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: 'ok', db: 'ok' });
  });

  it('answers 503 {status:error,db:unreachable} and leaks nothing when the driver fails', async () => {
    const out: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')));
    }
    const failure = Object.assign(new Error(`password authentication failed postgres://u:${SENTINEL}@db:5432/x`), {
      stack: `Error: ${SENTINEL}`,
    });
    app = await bootHealthApp({ query: async () => Promise.reject(failure) });
    const res = await app.get();
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ status: 'error', db: 'unreachable' });
    expect(res.text).not.toContain(SENTINEL);
    expect(app.logs.lines.join('\n')).not.toContain(SENTINEL);
    expect(out.join('\n')).not.toContain(SENTINEL);
  });
});
