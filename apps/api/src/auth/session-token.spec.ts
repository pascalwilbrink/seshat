import { describe, expect, it } from 'vitest';
import { SESSION_TTL_SECONDS, createSessionToken, readCookie, verifySessionToken } from './session-token.js';

const SECRET = 'unit-test-secret-0123456789abcdefghij';
const NOW = Date.UTC(2026, 0, 1);

describe('session token', () => {
  it('verifies a freshly issued token', () => {
    expect(verifySessionToken(SECRET, createSessionToken(SECRET, NOW), NOW)).toBe(true);
  });

  it('expires after seven days (server-verified)', () => {
    const token = createSessionToken(SECRET, NOW);
    const ttlMs = SESSION_TTL_SECONDS * 1000;
    expect(SESSION_TTL_SECONDS).toBe(7 * 24 * 3600);
    expect(verifySessionToken(SECRET, token, NOW + ttlMs - 1000)).toBe(true);
    expect(verifySessionToken(SECRET, token, NOW + ttlMs)).toBe(false);
    expect(verifySessionToken(SECRET, token, NOW + ttlMs + 1)).toBe(false);
  });

  it('rejects a token signed with another secret', () => {
    expect(verifySessionToken(SECRET + 'x', createSessionToken(SECRET, NOW), NOW)).toBe(false);
  });

  it('rejects tampered payloads and signatures', () => {
    const [v, payload, sig] = createSessionToken(SECRET, NOW).split('.') as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({ sub: 'admin', iat: 0, exp: 9_999_999_999 }),
    ).toString('base64url');
    expect(verifySessionToken(SECRET, `${v}.${forged}.${sig}`, NOW)).toBe(false);
    expect(verifySessionToken(SECRET, `${v}.${payload}.${sig.slice(0, -2)}AA`, NOW)).toBe(false);
    expect(verifySessionToken(SECRET, `${v}.${payload}.`, NOW)).toBe(false);
  });

  it.each(['', 'garbage', 'v1.a.b', 'v1.a.b.c', 'v2.a.b', '.', '..', 'a'.repeat(600), 'null', '{}'])(
    'rejects malformed token %#',
    (token) => {
      expect(verifySessionToken(SECRET, token, NOW)).toBe(false);
    },
  );
});

describe('readCookie', () => {
  it('reads one cookie by name', () => {
    expect(readCookie('a=1; seshat_session=tok; b=2', 'seshat_session')).toBe('tok');
  });
  it('treats absent, empty, duplicated or oversized as missing', () => {
    expect(readCookie(undefined, 'x')).toBeUndefined();
    expect(readCookie('x=', 'x')).toBeUndefined();
    expect(readCookie('x=1; x=2', 'x')).toBeUndefined();
    expect(readCookie(`x=${'a'.repeat(5000)}`, 'x')).toBeUndefined();
  });
});
