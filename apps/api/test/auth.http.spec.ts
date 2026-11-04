import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { Controller, Get, type INestApplication, type LoggerService, Module } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TEST_ADMIN_ENV,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_PASSWORD_HASH,
  TEST_ADMIN_USERNAME,
  TEST_SESSION_SECRET,
} from './fixtures/admin.js';

const SENTINEL_PASSWORD = 'SENTINEL-wrong-password-7f3a';
const SENTINEL_USER = 'SENTINEL-unknown-user-91c2';
const SENTINEL_ERROR = 'SENTINEL-driver-detail-55aa';

async function fakeInitialize(ds: unknown) {
  const d = ds as { isInitialized: boolean; destroy: () => Promise<void> };
  d.isInitialized = true;
  d.destroy = async () => {
    d.isInitialized = false;
  };
  return ds;
}

class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  private push = (...args: unknown[]) => void this.lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  log = this.push;
  error = this.push;
  warn = this.push;
  debug = this.push;
  verbose = this.push;
  fatal = this.push;
}

interface Booted {
  base: string;
  logs: CapturingLogger;
  output: string[];
  close: () => Promise<void>;
}

async function boot(opts: { env?: Record<string, string>; trustProxy?: false | number } = {}): Promise<Booted> {
  vi.resetModules();
  for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test', ...opts.env })) {
    vi.stubEnv(k, v);
  }
  vi.doMock('../src/database/bootstrap.js', () => ({ initializeDatabase: vi.fn(fakeInitialize) }));
  const { AppModule } = await import('../src/app.module.js');
  const { createApp } = await import('../src/app.setup.js');

  @Controller('boom')
  class BoomController {
    @Get()
    boom(): never {
      throw new Error(`driver failure ${SENTINEL_ERROR}`);
    }
  }
  @Module({ imports: [AppModule], controllers: [BoomController] })
  class TestRoot {}

  const logs = new CapturingLogger();
  const output: string[] = [];
  const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void output.push(a.map(String).join(' '))),
  );
  const app: INestApplication = await createApp(TestRoot, { trustProxy: opts.trustProxy ?? false }, logs);
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    logs,
    output,
    close: async () => {
      spies.forEach((s) => s.mockRestore());
      await app.close();
    },
  };
}

function login(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const GOOD = { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD };

function sessionCookie(res: Response): { header: string; value: string } {
  const header = res.headers.getSetCookie().find((c) => c.startsWith('seshat_session='))!;
  return { header, value: header.split(';')[0]!.slice('seshat_session='.length) };
}

let app: Booted | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('login', () => {
  it('issues a signed 7-day HttpOnly SameSite=Lax cookie, Secure outside development, and no token in the body', async () => {
    app = await boot({ env: { NODE_ENV: 'production' } });
    const res = await login(app.base, GOOD);
    expect(res.status).toBe(200);
    const { header, value } = sessionCookie(res);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\//);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/Max-Age=604800/);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ kind: 'admin', username: TEST_ADMIN_USERNAME });
    expect(body).not.toContain(value);
  });

  it('omits Secure in development', async () => {
    app = await boot({ env: { NODE_ENV: 'development' } });
    const res = await login(app.base, GOOD);
    expect(res.status).toBe(200);
    expect(sessionCookie(res).header).not.toMatch(/Secure/i);
    expect(sessionCookie(res).header).toMatch(/HttpOnly/i);
  });

  it('answers wrong username and wrong password with one identical generic response', async () => {
    app = await boot();
    const a = await login(app.base, { username: SENTINEL_USER, password: TEST_ADMIN_PASSWORD });
    const b = await login(app.base, { username: TEST_ADMIN_USERNAME, password: SENTINEL_PASSWORD });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    const [ta, tb] = [await a.text(), await b.text()];
    expect(ta).toBe(tb);
    expect(a.headers.getSetCookie()).toEqual([]);
    expect(ta).not.toContain(SENTINEL_USER);
  });

  it('verifies argon2id even for unknown usernames (no fast failure path)', async () => {
    const argon2 = (await import('argon2')).default;
    const verify = vi.spyOn(argon2, 'verify');
    app = await boot();
    await login(app.base, { username: SENTINEL_USER, password: SENTINEL_PASSWORD });
    expect(verify).toHaveBeenCalledTimes(1);
    verify.mockRestore();
  });

  it.each([
    ['not json', '{"username": "x", "password": "SENTINEL-body-snippet"'],
    ['array', '[]'],
    ['missing password', JSON.stringify({ username: 'a' })],
    ['non-string', JSON.stringify({ username: 'a', password: 5 })],
    ['extra key', JSON.stringify({ ...GOOD, admin: true })],
    ['overlong password', JSON.stringify({ username: 'a', password: 'p'.repeat(257) })],
    ['empty', JSON.stringify({ username: '', password: '' })],
  ])('rejects invalid input (%s) with a sanitized 400', async (_n, body) => {
    app = await boot();
    const res = await login(app.base, body);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain('SENTINEL');
    expect(text).not.toContain('position');
  });

  it('rejects oversized bodies', async () => {
    app = await boot();
    const res = await login(app.base, JSON.stringify({ username: 'a', password: 'p'.repeat(40_000) }));
    expect(res.status).toBe(413);
  });
});

describe('rate limiting', () => {
  it('limits to 5 attempts per minute per IP, then resets', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    app = await boot();
    const wrong = { username: 'x', password: SENTINEL_PASSWORD };
    for (let i = 0; i < 5; i++) expect((await login(app.base, wrong)).status).toBe(401);
    const limited = await login(app.base, GOOD);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.headers.getSetCookie()).toEqual([]);
    vi.advanceTimersByTime(61_000);
    expect((await login(app.base, GOOD)).status).toBe(200);
  });

  it('ignores X-Forwarded-For unless a proxy hop is trusted (no spoofed bypass)', async () => {
    app = await boot({ trustProxy: false });
    for (let i = 0; i < 5; i++) await login(app.base, { username: 'x', password: 'y' }, { 'x-forwarded-for': `10.0.0.${i}` });
    const res = await login(app.base, GOOD, { 'x-forwarded-for': '10.9.9.9' });
    expect(res.status).toBe(429);
  });

  it('separates client IPs when one proxy hop is trusted', async () => {
    app = await boot({ trustProxy: 1 });
    for (let i = 0; i < 5; i++) await login(app.base, { username: 'x', password: 'y' }, { 'x-forwarded-for': '203.0.113.1' });
    expect((await login(app.base, GOOD, { 'x-forwarded-for': '203.0.113.1' })).status).toBe(429);
    expect((await login(app.base, GOOD, { 'x-forwarded-for': '203.0.113.2' })).status).toBe(200);
  });
});

describe('sessions', () => {
  async function loggedIn() {
    const res = await login(app!.base, GOOD);
    return sessionCookie(res);
  }
  const me = (cookie?: string) =>
    fetch(`${app!.base}/api/auth/me`, { headers: cookie ? { cookie: `seshat_session=${cookie}` } : {} });

  it('/me returns the principal for a valid session and 401 without one', async () => {
    app = await boot();
    const { value } = await loggedIn();
    const ok = await me(value);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ kind: 'admin', username: TEST_ADMIN_USERNAME });
    expect((await me()).status).toBe(401);
  });

  it('rejects tampered, malformed and foreign-signed cookies', async () => {
    app = await boot();
    const { value } = await loggedIn();
    const [v, payload, sig] = value.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', iat: 1, exp: 9_999_999_999 })).toString('base64url');
    for (const bad of [`${v}.${forged}.${sig}`, `${v}.${payload}.${sig.slice(0, -3)}abc`, 'garbage', '']) {
      expect((await me(bad)).status).toBe(401);
    }
  });

  it('expires the session after seven days', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-01T00:00:00Z') });
    app = await boot();
    const { value } = await loggedIn();
    vi.setSystemTime(new Date('2026-03-07T23:59:00Z'));
    expect((await me(value)).status).toBe(200);
    vi.setSystemTime(new Date('2026-03-08T00:00:01Z'));
    expect((await me(value)).status).toBe(401);
  });

  it('logout requires a session and clears the cookie with matching attributes', async () => {
    app = await boot({ env: { NODE_ENV: 'production' } });
    expect((await fetch(`${app.base}/api/auth/logout`, { method: 'POST' })).status).toBe(401);
    const { value, header } = await loggedIn();
    const res = await fetch(`${app.base}/api/auth/logout`, { method: 'POST', headers: { cookie: `seshat_session=${value}` } });
    expect(res.status).toBe(204);
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith('seshat_session='))!;
    expect(cleared).toMatch(/^seshat_session=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    for (const attr of [/Path=\//, /HttpOnly/i, /SameSite=Lax/i, /Secure/i]) {
      expect(cleared).toMatch(attr);
      expect(header).toMatch(attr);
    }
  });
});

describe('default-deny guard', () => {
  it('allows only the two public pairs; everything else needs a session', async () => {
    app = await boot();
    expect((await fetch(`${app.base}/api/health`)).status).toBe(200);
    expect((await login(app.base, GOOD)).status).toBe(200);
    // Unregistered method/path pairs have no handler at all, so they never reach application code.
    expect((await fetch(`${app.base}/api/health`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${app.base}/api/auth/login`)).status).toBe(404);
    expect((await fetch(`${app.base}/api/auth/me`)).status).toBe(401);
    expect((await fetch(`${app.base}/api/boom`)).status).toBe(401);
    expect((await fetch(`${app.base}/`)).status).toBe(404);
  });
});

describe('sanitization', () => {
  it('keeps secrets, hashes, passwords and tokens out of logs, errors and responses', async () => {
    app = await boot();
    const seen: string[] = [];
    const record = async (res: Response) => {
      seen.push(await res.text());
      seen.push(
        [...res.headers.entries()].filter(([k]) => k !== 'set-cookie').map(([k, v]) => `${k}: ${v}`).join('\n'),
      );
      return res;
    };
    const ok = await login(app.base, GOOD);
    const { value } = sessionCookie(ok);
    const forgedValue = value.slice(0, -4) + 'AAAA';
    await record(ok);
    await record(await login(app.base, { username: SENTINEL_USER, password: SENTINEL_PASSWORD }));
    await record(await login(app.base, `{"password":"${SENTINEL_PASSWORD}"`));
    await record(await login(app.base, { ...GOOD, extra: SENTINEL_PASSWORD }));
    await record(await fetch(`${app.base}/api/auth/me`, { headers: { cookie: `seshat_session=${forgedValue}` } }));
    await record(await fetch(`${app.base}/api/boom`, { headers: { cookie: `seshat_session=${value}` } }));
    for (let i = 0; i < 5; i++) await record(await login(app.base, { username: SENTINEL_USER, password: SENTINEL_PASSWORD }));

    const haystack = [...seen, ...app.logs.lines, ...app.output].join('\n');
    for (const secret of [
      SENTINEL_PASSWORD,
      SENTINEL_USER,
      SENTINEL_ERROR,
      TEST_ADMIN_PASSWORD,
      TEST_ADMIN_PASSWORD_HASH,
      TEST_SESSION_SECRET,
      value,
      forgedValue,
      'argon2id',
    ]) {
      expect(haystack, `leaked ${secret.slice(0, 12)}`).not.toContain(secret);
    }
    // The unexpected error was still logged, but only by class name.
    expect(app.logs.lines.join('\n')).toContain('Unhandled error (Error)');
  });
});
