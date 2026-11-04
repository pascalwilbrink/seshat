/** Default API origin when API_URL is unset. Server-only: never exposed with a NEXT_PUBLIC prefix. */
export const DEFAULT_API_URL = 'http://localhost:4200';

export function resolveApiUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.API_URL?.trim();
  return (raw ? raw : DEFAULT_API_URL).replace(/\/+$/, '');
}

/** Proxies /api/* to the API; Next forwards request cookies and passes Set-Cookie back unchanged. */
export function apiRewrites(env: Record<string, string | undefined> = process.env) {
  return [{ source: '/api/:path*', destination: `${resolveApiUrl(env)}/api/:path*` }];
}
