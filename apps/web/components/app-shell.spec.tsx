// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let pathname = '/global/overview';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

import { AppShell } from './app-shell';
import { json, routeFetch, ws } from './shell.fixture';

const fetchMock = vi.fn();
const assign = vi.fn();
beforeEach(() => {
  pathname = '/global/overview';
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(window, 'location', { value: { assign, pathname: '/x', search: '' }, configurable: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  assign.mockReset();
});

const withWorkspaces = (list = [ws('beta', 'Beta'), ws('alpha', 'Alpha')]) =>
  fetchMock.mockImplementation(routeFetch({ '/api/global/workspaces': () => json(list) }));

describe('scope switcher', () => {
  it('lists Global first and distinct, then Workspaces, with the active scope selected', async () => {
    withWorkspaces();
    pathname = '/w/alpha/overview';
    render(<AppShell username="admin">x</AppShell>);
    const nav = screen.getByRole('navigation', { name: 'Scope' });
    await within(nav).findByRole('link', { name: 'Alpha' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Global', 'Beta', 'Alpha']);
    expect(links[0]).toHaveClass('scope-global');
    expect(links[1]).not.toHaveClass('scope-global');
    expect(links[2]).toHaveAttribute('aria-current', 'page');
    expect(links[0]).not.toHaveAttribute('aria-current');
  });
  it('marks Global active on Global URLs and keeps the current section in links', async () => {
    withWorkspaces();
    pathname = '/global/settings';
    render(<AppShell username="admin">x</AppShell>);
    const nav = screen.getByRole('navigation', { name: 'Scope' });
    const beta = await within(nav).findByRole('link', { name: 'Beta' });
    expect(within(nav).getByRole('link', { name: 'Global' })).toHaveAttribute('aria-current', 'page');
    expect(beta).toHaveAttribute('href', '/w/beta/settings');
    expect(within(nav).getByRole('link', { name: 'Global' })).toHaveAttribute('href', '/global/settings');
  });
  it('shows only Overview and Settings, scoped to the URL', async () => {
    withWorkspaces();
    pathname = '/w/alpha/overview';
    render(<AppShell username="admin">x</AppShell>);
    const sections = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(sections).getAllByRole('link').map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Overview', '/w/alpha/overview'],
      ['Settings', '/w/alpha/settings'],
    ]);
    await screen.findByRole('link', { name: 'Alpha' });
  });
  it('shows an error with retry when Workspaces fail to load', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 500));
    render(<AppShell username="admin">x</AppShell>);
    await screen.findByRole('alert');
    withWorkspaces([ws('alpha', 'Alpha')]);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Alpha' })).toBeInTheDocument();
  });
});

describe('logout', () => {
  it('posts to /api/auth/logout then goes to login', async () => {
    fetchMock.mockImplementation(
      routeFetch({
        '/api/global/workspaces': () => json([]),
        '/api/auth/logout': () => new Response(null, { status: 204 }),
      }),
    );
    render(<AppShell username="admin">x</AppShell>);
    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    const logout = fetchMock.mock.calls.find((c) => c[0] === '/api/auth/logout')!;
    expect(logout[1]).toMatchObject({ method: 'POST' });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
  });
});
