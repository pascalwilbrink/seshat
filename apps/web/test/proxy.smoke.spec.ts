import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo, createServer as netServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SESSION = 'seshat_session=FIXTURE-TOKEN; HttpOnly; Path=/; SameSite=Lax';
let stub: Server;
let web: ChildProcess;
let base = '';
let seen: { url?: string; cookie?: string; method?: string }[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = netServer().listen(0, () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  stub = createServer((req: IncomingMessage, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie, method: req.method });
    res.setHeader('set-cookie', [SESSION, 'other=1; Path=/']);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => stub.listen(0, r));
  const apiPort = (stub.address() as AddressInfo).port;
  const webPort = await freePort();
  base = `http://127.0.0.1:${webPort}`;
  web = spawn('pnpm', ['exec', 'next', 'dev', '-p', String(webPort)], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, API_URL: `http://127.0.0.1:${apiPort}`, NEXT_DIST_DIR: '.next-smoke', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/login`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('web did not start');
}, 90_000);

afterAll(() => {
  web?.kill('SIGTERM');
  stub?.close();
});

describe('same-origin API proxy (stub API)', () => {
  it('forwards path, query, method and cookies, and preserves Set-Cookie', async () => {
    seen = [];
    const res = await fetch(`${base}/api/auth/login?x=1`, { method: 'POST', headers: { cookie: 'a=b' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toEqual([{ url: '/api/auth/login?x=1', cookie: 'a=b', method: 'POST' }]);
    expect(res.headers.getSetCookie()).toEqual([SESSION, 'other=1; Path=/']);
  }, 30_000);
});
