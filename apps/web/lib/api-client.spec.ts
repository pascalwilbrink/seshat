// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api-client';

const fetchMock = vi.fn();
const assign = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(window, 'location', { value: { assign, pathname: '/x', search: '?a=1' }, configurable: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  assign.mockReset();
});

describe('api client', () => {
  it('redirects to login (with a local next) on any 401', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));
    await apiFetch('/api/global/overview');
    expect(assign).toHaveBeenCalledWith('/login?next=%2Fx%3Fa%3D1');
  });
  it('refuses absolute URLs so the browser never calls the API origin', async () => {
    await expect(apiFetch('http://localhost:4200/api/x')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
