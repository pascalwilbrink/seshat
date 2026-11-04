// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSyncExternalStore } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// A tiny in-memory router: pathname is the single source of truth, like the real URL.
const nav = vi.hoisted(() => {
  let path = '/global/settings';
  const subs = new Set<() => void>();
  const go = (p: string) => {
    path = p;
    subs.forEach((s) => s());
  };
  return {
    get path() {
      return path;
    },
    go,
    subscribe: (s: () => void) => (subs.add(s), () => subs.delete(s)),
  };
});
vi.mock('next/navigation', () => ({
  usePathname: () => useSyncExternalStore(nav.subscribe, () => nav.path, () => nav.path),
  useRouter: () => ({ push: nav.go, replace: nav.go }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        e.preventDefault();
        nav.go(href);
      }}
    >
      {children}
    </a>
  ),
}));

import { AppShell } from './app-shell';
import { GlobalSettingsView } from './global-settings-view';
import { OverviewView } from './overview-view';
import { WorkspaceSettingsView } from './workspace-settings-view';
import { scopeFromPathname } from '@/lib/scope';
import type { WorkspaceDto } from '@/lib/api-types';
import { json } from './shell.fixture';

/** Controlled fixture of the assembled API contract: list/create/overview/rename/delete. */
function fakeApi() {
  const rows: WorkspaceDto[] = [];
  const requests: string[] = [];
  const handler = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    requests.push(url);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (url === '/api/global/workspaces' && method === 'GET') return json(rows);
    if (url === '/api/global/workspaces' && method === 'POST') {
      const slug = body.slug ?? String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (rows.some((r) => r.slug === slug)) return json({ message: 'A Workspace with this slug already exists' }, 409);
      const row = { id: `id-${slug}`, name: body.name, slug, description: body.description ?? null, createdAt: '2026-03-02T10:00:00.000Z', updatedAt: '2026-03-02T10:00:00.000Z' };
      rows.push(row);
      return json(row, 201);
    }
    if (url === '/api/global/overview') return json({ scope: 'global', name: 'Global' });
    const m = /^\/api\/workspaces\/([^/]+)(\/overview)?$/.exec(url);
    const row = m && rows.find((r) => r.id === m[1]);
    if (!m || !row) return json({ message: 'Not Found' }, 404);
    if (m[2]) return json({ scope: 'workspace', ...row });
    if (method === 'PUT') {
      Object.assign(row, { name: body.name, description: body.description || null });
      return json(row);
    }
    if (method === 'DELETE') {
      if (body.slug !== row.slug) return json({ message: 'Slug confirmation does not match' }, 400);
      rows.splice(rows.indexOf(row), 1);
      return new Response(null, { status: 204 });
    }
    return json({}, 405);
  };
  return { handler, requests };
}

function Page() {
  const path = useSyncExternalStore(nav.subscribe, () => nav.path, () => nav.path);
  const scope = scopeFromPathname(path)!;
  const settings = path.endsWith('/settings');
  return (
    <AppShell username="admin">
      {settings ? scope.kind === 'global' ? <GlobalSettingsView /> : <WorkspaceSettingsView slug={scope.slug} /> : <OverviewView scope={scope} />}
    </AppShell>
  );
}

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('Workspace lifecycle through the shell and a same-origin API fixture', () => {
  it('create -> reload scoped Overview -> rename -> slug-confirmed delete -> Global', async () => {
    const api = fakeApi();
    fetchMock.mockImplementation(api.handler);
    nav.go('/global/settings');
    const first = render(<Page />);
    const switcher = () => screen.getByRole('navigation', { name: 'Scope' });

    // Empty state, then create.
    expect(await screen.findByText(/No Workspaces yet\. Create your first/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Name'), 'Acme Corp');
    await userEvent.click(screen.getByRole('button', { name: 'Create Workspace' }));

    // Lands on a valid scoped URL; the switcher already lists it.
    expect(await screen.findByRole('heading', { name: 'Acme Corp' })).toBeInTheDocument();
    expect(nav.path).toBe('/w/acme-corp/overview');
    expect(within(switcher()).getByRole('link', { name: 'Acme Corp' })).toHaveAttribute('aria-current', 'page');

    // Direct reload of the scoped URL (fresh tree, no cached state) keeps the scope.
    first.unmount();
    render(<Page />);
    expect(await screen.findByRole('heading', { name: 'Acme Corp' })).toBeInTheDocument();
    expect(nav.path).toBe('/w/acme-corp/overview');

    // Settings: slug is fixed, rename refreshes the switcher.
    await userEvent.click(screen.getAllByRole('link', { name: 'Settings' }).at(-1)!);
    const name = await screen.findByLabelText('Name');
    expect(screen.getByLabelText('Slug')).toHaveAttribute('readonly');
    await userEvent.clear(name);
    await userEvent.type(name, 'Acme Inc');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Workspace saved');
    expect(await within(switcher()).findByRole('link', { name: 'Acme Inc' })).toBeInTheDocument();
    expect(nav.path).toBe('/w/acme-corp/settings');

    // Delete needs the exact slug; the active Workspace disappears and we land in Global.
    await userEvent.type(screen.getByLabelText(/Type the slug "acme-corp"/), 'acme-corp');
    await userEvent.click(screen.getByRole('button', { name: 'Delete Workspace' }));
    expect(await screen.findByRole('heading', { name: 'Global' })).toBeInTheDocument();
    expect(nav.path).toBe('/global/overview');
    await vi.waitFor(() => expect(within(switcher()).queryByRole('link', { name: 'Acme Inc' })).not.toBeInTheDocument());
    expect(await screen.findByRole('link', { name: 'Create your first Workspace' })).toBeInTheDocument();

    // The deleted Workspace's URL is now not found, with no stale data.
    nav.go('/w/acme-corp/overview');
    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument();

    // Every request was a relative same-origin /api path.
    expect(api.requests.length).toBeGreaterThan(5);
    expect(api.requests.every((u) => u.startsWith('/api/'))).toBe(true);
    expect(fetchMock.mock.calls.every((c) => c[1]?.credentials === 'same-origin')).toBe(true);
  });
});
