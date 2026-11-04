import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'seshat_session';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const VERSION = 'v1';
const MAX_TOKEN_LENGTH = 512;

interface SessionPayload {
  sub: 'admin';
  iat: number;
  exp: number;
}

function sign(secret: string, payloadB64: string): Buffer {
  return createHmac('sha256', secret).update(`${VERSION}.${payloadB64}`).digest();
}

/** Creates a signed, self-contained session token: `v1.<payload>.<hmac>` (base64url). Expiry is verified server-side. */
export function createSessionToken(secret: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const payload: SessionPayload = { sub: 'admin', iat, exp: iat + SESSION_TTL_SECONDS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${VERSION}.${payloadB64}.${sign(secret, payloadB64).toString('base64url')}`;
}

/** Returns true only for a well-formed, correctly signed, unexpired admin token. Never throws. */
export function verifySessionToken(secret: string, token: string, nowMs: number): boolean {
  try {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== VERSION) return false;
    const [, payloadB64, sigB64] = parts as [string, string, string];
    const given = Buffer.from(sigB64, 'base64url');
    const expected = sign(secret, payloadB64);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    if (payload.sub !== 'admin') return false;
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return false;
    const now = Math.floor(nowMs / 1000);
    const { iat, exp } = payload as SessionPayload;
    return exp - iat <= SESSION_TTL_SECONDS && iat <= now + 60 && now < exp;
  } catch {
    return false;
  }
}

/** Extracts one cookie by name from a Cookie header. Duplicates are treated as absent (ambiguous). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header || header.length > 4096) return undefined;
  let found: string | undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    if (found !== undefined) return undefined;
    found = part.slice(eq + 1).trim();
  }
  return found || undefined;
}
