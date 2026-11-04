// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppHeader } from './app-header';
import { handleUnauthorized, apiFetch } from '@/lib/api-client';

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

describe('logout', () => {
  it('posts to /api/auth/logout then goes to login', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    render(<AppHeader username="admin" />);
    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/logout');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
  });
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
    handleUnauthorized();
  });
});
