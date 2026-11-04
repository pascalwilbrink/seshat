import 'server-only';
import { cookies } from 'next/headers';
import { resolveApiUrl } from './api-target';

export interface Session {
  username: string;
}

/**
 * Validates the session server-side against the API (/api/auth/me) with the incoming cookies.
 * Never cached, and cookie presence alone is not treated as validity. Returns null for any
 * missing, invalid or expired session.
 */
export async function getSession(): Promise<Session | null> {
  const cookieHeader = (await cookies()).toString();
  if (!cookieHeader) return null;
  let res: Response;
  try {
    res = await fetch(`${resolveApiUrl()}/api/auth/me`, {
      headers: { cookie: cookieHeader },
      cache: 'no-store',
    });
  } catch {
    throw new Error('Session check failed: API unreachable');
  }
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Session check failed: API responded ${res.status}`);
  const body: unknown = await res.json().catch(() => null);
  const username = (body as { username?: unknown } | null)?.username;
  return typeof username === 'string' ? { username } : null;
}
