// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let pathname = '/global/overview';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

import { AppShell } from './app-shell';
import { json, routeFetch, ws } from './shell.fixture';
import { SIDEBAR_STORAGE_KEY } from '@/lib/sidebar-storage';

const fetchMock = vi.fn();
const assign = vi.fn();
beforeEach(() => {
  pathname = '/global/overview';
  window.localStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(window, 'location', { value: { assign, pathname: '/x', search: '' }, configurable: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  assign.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

const withWorkspaces = (list = [ws('beta', 'Beta'), ws('alpha', 'Alpha')]) =>
  fetchMock.mockImplementation(routeFetch({ '/api/global/workspaces': () => json(list) }));

async function openScope(user = userEvent.setup()) {
  render(<AppShell username="admin">x</AppShell>);
  await user.click(screen.getByRole('button', { name: /^Scope:/ }));
  return { user, menu: await screen.findByRole('menu') };
}

describe('navigation', () => {
  it('shows Overview, Memories and Settings, grouped, in Global', () => {
    withWorkspaces();
    render(<AppShell username="admin">x</AppShell>);
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(nav).getAllByRole('link').map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Overview', '/global/overview'],
      ['Memories', '/global/memories'],
      ['Settings', '/global/settings'],
    ]);
    expect(within(nav).getByText('Knowledge')).toBeInTheDocument();
    expect(within(nav).getByText('System')).toBeInTheDocument();
    expect(within(nav).queryByText('Developer')).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  });
  it('scopes links to the Workspace in the URL and marks Settings current', () => {
    withWorkspaces();
    pathname = '/w/alpha/settings';
    render(<AppShell username="admin">x</AppShell>);
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(nav).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/w/alpha/settings');
    expect(within(nav).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  });
  it('does not list direct-route areas (Files, Collections, API Keys) yet keeps their pages in the shell', () => {
    withWorkspaces();
    pathname = '/w/alpha/api-keys';
    render(<AppShell username="admin">x</AppShell>);
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    for (const n of ['Files', 'Collections', 'API Keys']) expect(within(nav).queryByRole('link', { name: n })).not.toBeInTheDocument();
    expect(screen.getByText('x')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('API Keys')).toBeInTheDocument();
  });
});

describe('scope breadcrumb and badge', () => {
  it('shows Global with its badge', () => {
    withWorkspaces();
    render(<AppShell username="admin">x</AppShell>);
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByText('Global')).toBeInTheDocument();
    expect(within(crumb).getByText('Overview')).toHaveAttribute('aria-current', 'page');
    expect(document.querySelector('header [data-scope="global"]')).not.toBeNull();
  });
  it('shows the Workspace name once loaded (slug while loading or failing) with the Workspace badge', async () => {
    withWorkspaces();
    pathname = '/w/alpha/settings';
    render(<AppShell username="admin">x</AppShell>);
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByText('alpha')).toBeInTheDocument();
    expect(document.querySelector('header [data-scope="workspace"]')).not.toBeNull();
    expect(await within(crumb).findByText('Alpha')).toBeInTheDocument();
  });
  it('still shows scope when Workspaces fail to load', async () => {
    fetchMock.mockResolvedValue(json({}, 500));
    pathname = '/w/alpha/overview';
    render(<AppShell username="admin">x</AppShell>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('alpha')).toBeInTheDocument();
  });
  it('shows no scope header on an unscoped URL', () => {
    withWorkspaces();
    pathname = '/somewhere';
    render(<AppShell username="admin">x</AppShell>);
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
  });
});

describe('scope dropdown', () => {
  it('lists Global first, then Workspaces alphabetically, then Create Workspace', async () => {
    withWorkspaces([ws('c', 'charlie'), ws('b', 'Bravo'), ws('a', 'alpha')]);
    const { menu } = await openScope();
    await within(menu).findByRole('menuitem', { name: 'Bravo' });
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Global', 'alpha', 'Bravo', 'charlie', 'Create Workspace']);
    expect(within(menu).getByRole('menuitem', { name: 'Create Workspace' })).toHaveAttribute('href', '/global/settings#create-workspace');
    expect(menu.querySelector('[data-scope-item="global"]')).not.toBeNull();
  });
  it('marks the active scope and keeps an available area when switching', async () => {
    withWorkspaces();
    pathname = '/global/settings';
    const { menu } = await openScope();
    expect(await within(menu).findByRole('menuitem', { name: 'Alpha' })).toHaveAttribute('href', '/w/alpha/settings');
    expect(within(menu).getByRole('menuitem', { name: 'Global' })).toHaveAttribute('aria-current', 'page');
  });
  it('falls back to Overview for an unavailable or Workspace-only area', async () => {
    withWorkspaces();
    pathname = '/global/files';
    const first = await openScope();
    expect(await within(first.menu).findByRole('menuitem', { name: 'Alpha' })).toHaveAttribute('href', '/w/alpha/overview');
    first.user.keyboard('{Escape}');
  });
  it('never links to a Global API Keys page when switching from a Workspace key page', async () => {
    withWorkspaces();
    pathname = '/w/alpha/api-keys';
    const { menu } = await openScope();
    expect(within(menu).getByRole('menuitem', { name: 'Global' })).toHaveAttribute('href', '/global/overview');
  });
  it('has a loading state', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { menu } = await openScope();
    expect(within(menu).getByRole('status')).toHaveTextContent('Loading Workspaces');
  });
  it('shows an empty state with Create Workspace still available', async () => {
    withWorkspaces([]);
    const { menu } = await openScope();
    expect(await within(menu).findByText('No Workspaces yet')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Create Workspace' })).toBeInTheDocument();
  });
  it('shows an error with retry', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 500));
    const { user, menu } = await openScope();
    await within(menu).findByRole('alert');
    withWorkspaces([ws('alpha', 'Alpha')]);
    await user.click(within(menu).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('menuitem', { name: 'Alpha' })).toBeInTheDocument();
  });
  it('opens from the keyboard', async () => {
    withWorkspaces();
    const user = userEvent.setup();
    render(<AppShell username="admin">x</AppShell>);
    screen.getByRole('button', { name: /^Scope:/ }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });
});

describe('sidebar collapse', () => {
  it('has a labelled toggle that collapses to icons with tooltips and persists', async () => {
    withWorkspaces();
    const user = userEvent.setup();
    const { unmount } = render(<AppShell username="admin">x</AppShell>);
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-expanded', 'false');
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('1');
    const link = within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', { name: 'Settings' });
    expect(link).toHaveAttribute('href', '/global/settings');
    link.focus();
    expect((await screen.findAllByText('Settings')).length).toBeGreaterThan(0);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Settings');
    unmount();
    // Reload: state is restored.
    render(<AppShell username="admin">x</AppShell>);
    expect(await screen.findByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    expect(document.querySelector('aside')).toHaveAttribute('data-collapsed', 'true');
  });
  it('renders expanded when storage throws', async () => {
    withWorkspaces();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const user = userEvent.setup();
    render(<AppShell username="admin">x</AppShell>);
    expect(document.querySelector('aside')).toHaveAttribute('data-collapsed', 'false');
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(document.querySelector('aside')).toHaveAttribute('data-collapsed', 'true');
  });
  it('has a skip link to the main content', () => {
    withWorkspaces();
    render(<AppShell username="admin">x</AppShell>);
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });
});

describe('mobile sheet', () => {
  it('opens from the header button, traps focus, closes on Escape and returns focus', async () => {
    withWorkspaces();
    const user = userEvent.setup();
    render(<AppShell username="admin">x</AppShell>);
    const trigger = screen.getByRole('button', { name: 'Open navigation' });
    expect(trigger).toHaveClass('md:hidden');
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Navigation' });
    expect(within(dialog).getByRole('link', { name: 'Overview' })).toBeInTheDocument();
    for (let i = 0; i < 12; i++) await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
  it('closes when a navigation link is chosen', async () => {
    withWorkspaces();
    const user = userEvent.setup();
    render(<AppShell username="admin">x</AppShell>);
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('link', { name: 'Settings' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('desktop sidebar is hidden below 768px and the toggle is desktop-only (Tailwind md breakpoint)', () => {
    withWorkspaces();
    render(<AppShell username="admin">x</AppShell>);
    expect(document.querySelector('aside')).toHaveClass('hidden', 'md:block');
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveClass('hidden', 'md:inline-flex');
  });
});

describe('user menu and sign out', () => {
  async function openUser(user = userEvent.setup()) {
    await user.click(screen.getByRole('button', { name: 'Account menu for admin' }));
    return user;
  }
  it('posts to /api/auth/logout, notifies, then goes to login', async () => {
    fetchMock.mockImplementation(
      routeFetch({
        '/api/global/workspaces': () => json([]),
        '/api/auth/logout': () => new Response(null, { status: 204 }),
      }),
    );
    render(<AppShell username="admin">x</AppShell>);
    const user = await openUser();
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
    const logout = fetchMock.mock.calls.find((c) => c[0] === '/api/auth/logout')!;
    expect(logout[1]).toMatchObject({ method: 'POST' });
    expect(toast.success).toHaveBeenCalledWith('Signed out');
  });
  it('still goes to login and notifies safely when the request fails', async () => {
    fetchMock.mockImplementation((url: string) => (url === '/api/auth/logout' ? Promise.reject(new Error('net')) : Promise.resolve(json([]))));
    render(<AppShell username="admin">x</AppShell>);
    const user = await openUser();
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
    expect(toast.error).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain('net');
  });
  it('treats a non-ok logout response as a failure notification', async () => {
    fetchMock.mockImplementation(
      routeFetch({ '/api/global/workspaces': () => json([]), '/api/auth/logout': () => json({}, 500) }),
    );
    render(<AppShell username="admin">x</AppShell>);
    const user = await openUser();
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
    expect(toast.error).toHaveBeenCalled();
  });
});
