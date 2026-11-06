// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OverviewView } from './overview-view';
import { WorkspacesProvider } from './workspaces-provider';
import { json, routeFetch, ws } from './shell.fixture';
import { emptyUsage } from './usage-dashboard.fixture';

/** Every Overview also fetches its usage aggregate; tests that do not care get an empty one. */
const withUsage = (r: Record<string, () => Response | Promise<Response>>) =>
  routeFetch({
    '/api/global/usage/overview?days=30': () => json(emptyUsage('global')),
    '/api/workspaces/uuid-1/usage/overview?days=30': () => json(emptyUsage('workspace')),
    '/api/workspaces/uuid-2/usage/overview?days=30': () => json(emptyUsage('workspace')),
    ...r,
  });

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

const view = (scope: Parameters<typeof OverviewView>[0]['scope']) =>
  render(
    <WorkspacesProvider>
      <OverviewView scope={scope} />
    </WorkspacesProvider>,
  );
const urls = () => fetchMock.mock.calls.map((c) => c[0]);

describe('Global Overview', () => {
  it('shows loading, then the scope name', async () => {
    fetchMock.mockImplementation(
      withUsage({
        '/api/global/workspaces': () => json([ws('a')]),
        '/api/global/overview': () => json({ scope: 'global', name: 'Global' }),
      }),
    );
    view({ kind: 'global' });
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(await screen.findByRole('heading', { name: 'Global' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create your first Workspace' })).not.toBeInTheDocument();
    // Only a genuinely available metric becomes a stat card: the authorized Workspace count.
    expect(screen.getByText('Workspaces')).toBeInTheDocument();
    expect(screen.getByText('Available to you')).toBeInTheDocument();
  });
  it('shows no stat card while the Workspace collection failed', async () => {
    fetchMock.mockImplementation(
      withUsage({
        '/api/global/workspaces': () => json({}, 500),
        '/api/global/overview': () => json({ scope: 'global', name: 'Global' }),
      }),
    );
    view({ kind: 'global' });
    expect(await screen.findByRole('heading', { name: 'Global' })).toBeInTheDocument();
    expect(screen.queryByText('Workspaces')).not.toBeInTheDocument();
  });
  it('offers Create your first Workspace linking to Global Settings when there are none', async () => {
    fetchMock.mockImplementation(
      withUsage({
        '/api/global/workspaces': () => json([]),
        '/api/global/overview': () => json({ scope: 'global', name: 'Global' }),
      }),
    );
    view({ kind: 'global' });
    const cta = await screen.findByRole('link', { name: 'Create your first Workspace' });
    expect(cta).toHaveAttribute('href', '/global/settings');
    expect(screen.queryByText('Workspaces')).not.toBeInTheDocument();
  });
  it('shows an error and retries', async () => {
    let fail = true;
    fetchMock.mockImplementation(
      withUsage({
        '/api/global/workspaces': () => json([ws('a')]),
        '/api/global/overview': () => (fail ? json({}, 500) : json({ scope: 'global', name: 'Global' })),
      }),
    );
    view({ kind: 'global' });
    await screen.findByRole('alert');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Global' })).toBeInTheDocument();
  });
});

describe('Workspace Overview', () => {
  it('shows a loading status, then the details without a description placeholder lie', async () => {
    fetchMock.mockImplementation(
      withUsage({
        '/api/global/workspaces': () => json([ws('alpha', 'Alpha', 'uuid-1')]),
        '/api/workspaces/uuid-1/overview': () =>
          json({ scope: 'workspace', id: 'uuid-1', name: 'Alpha', slug: 'alpha', description: null, createdAt: '2026-03-02T10:00:00.000Z' }),
      }),
    );
    view({ kind: 'workspace', slug: 'alpha' });
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByText('No description')).toBeInTheDocument();
  });
  it('retries a failed Workspace overview', async () => {
    let fail = true;
    fetchMock.mockImplementation(
      withUsage({
        '/api/global/workspaces': () => json([ws('alpha', 'Alpha', 'uuid-1')]),
        '/api/workspaces/uuid-1/overview': () =>
          fail ? json({}, 500) : json({ scope: 'workspace', id: 'uuid-1', name: 'Alpha', slug: 'alpha', description: 'x', createdAt: '2026-03-02T10:00:00.000Z' }),
      }),
    );
    view({ kind: 'workspace', slug: 'alpha' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the Overview');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeInTheDocument();
  });
  const workspaces = [ws('alpha', 'Alpha', 'uuid-1'), ws('beta', 'Beta', 'uuid-2')];
  it('resolves the slug to the UUID and shows name, description and created date', async () => {
    fetchMock.mockImplementation(
      withUsage({
        '/api/global/workspaces': () => json(workspaces),
        '/api/workspaces/uuid-1/overview': () =>
          json({ scope: 'workspace', id: 'uuid-1', name: 'Alpha', slug: 'alpha', description: 'About alpha', createdAt: '2026-03-02T10:00:00.000Z' }),
      }),
    );
    view({ kind: 'workspace', slug: 'alpha' });
    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByText('About alpha')).toBeInTheDocument();
    expect(screen.getByText(/2 March 2026/)).toBeInTheDocument();
    expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-03-02T10:00:00.000Z');
    expect(screen.queryByText('Workspaces')).not.toBeInTheDocument();
    expect(urls()).not.toContain('/api/workspaces/alpha/overview');
    expect(urls().every((u) => u.startsWith('/api/'))).toBe(true);
  });
  it('shows not found for an unknown slug without calling a Workspace endpoint', async () => {
    fetchMock.mockImplementation(withUsage({ '/api/global/workspaces': () => json(workspaces) }));
    view({ kind: 'workspace', slug: 'ghost' });
    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Global Overview' })).toHaveAttribute('href', '/global/overview');
    expect(urls()).toEqual(['/api/global/workspaces']);
  });
  it('shows the same not found when the Workspace was deleted after listing (404)', async () => {
    fetchMock.mockImplementation(
      withUsage({
        '/api/global/workspaces': () => json(workspaces),
        '/api/workspaces/uuid-2/overview': () => json({ message: 'Not Found' }, 404),
      }),
    );
    view({ kind: 'workspace', slug: 'beta' });
    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument();
  });
  it('shows an error with retry when the collection fails', async () => {
    fetchMock.mockImplementation(withUsage({ '/api/global/workspaces': () => json({}, 500) }));
    view({ kind: 'workspace', slug: 'alpha' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load Workspaces');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
