import { loginPath } from './safe-redirect';

/** Browser fetch helper: relative same-origin /api paths only; a 401 sends the user to login. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith('/api/')) throw new Error('apiFetch only calls relative /api paths');
  const res = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 401) handleUnauthorized();
  return res;
}

export function handleUnauthorized(): void {
  const here = `${window.location.pathname}${window.location.search}`;
  window.location.assign(loginPath(here));
}
