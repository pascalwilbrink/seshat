import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cookieString = vi.fn();
vi.mock('next/headers', () => ({ cookies: async () => ({ toString: cookieString }) }));

import { getSession } from './session';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  cookieString.mockReturnValue('seshat_session=SENTINEL');
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('getSession', () => {
  it('is null without cookies and does not call the API', async () => {
    cookieString.mockReturnValue('');
    expect(await getSession()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('validates against the API with cookies and no caching', async () => {
    fetchMock.mockResolvedValue(Response.json({ kind: 'admin', username: 'admin' }));
    expect(await getSession()).toEqual({ username: 'admin' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:4200/api/auth/me');
    expect(init).toMatchObject({ cache: 'no-store', headers: { cookie: 'seshat_session=SENTINEL' } });
  });
  it('is null for invalid or expired sessions (401)', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    expect(await getSession()).toBeNull();
  });
  it('does not trust a 200 without a username', async () => {
    fetchMock.mockResolvedValue(Response.json({}));
    expect(await getSession()).toBeNull();
  });
  it('checks per request: a different user cookie is validated again', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ username: 'a' })).mockResolvedValueOnce(new Response('', { status: 401 }));
    expect(await getSession()).toEqual({ username: 'a' });
    cookieString.mockReturnValue('seshat_session=OTHER');
    expect(await getSession()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('throws a sanitized error on API failure', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED cookie=SENTINEL'));
    await expect(getSession()).rejects.toThrow('Session check failed: API unreachable');
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));
    await expect(getSession()).rejects.not.toThrow(/SENTINEL/);
  });
});
