// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const router = { push: vi.fn(), replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { GlobalSettingsView } from './global-settings-view';
import { WorkspacesProvider } from './workspaces-provider';
import { json, routeFetch, ws } from './shell.fixture';

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  router.push.mockReset();
});

const view = () =>
  render(
    <WorkspacesProvider>
      <GlobalSettingsView />
    </WorkspacesProvider>,
  );
const create = async (name: string, slug = '') => {
  await userEvent.type(await screen.findByLabelText('Name'), name);
  if (slug) await userEvent.type(screen.getByLabelText(/Slug/), slug);
  await userEvent.click(screen.getByRole('button', { name: 'Create Workspace' }));
};
const postBody = () => {
  const call = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST');
  return call && JSON.parse(call[1].body);
};

describe('Global Settings', () => {
  it('shows loading, then the Workspaces', async () => {
    fetchMock.mockImplementation(routeFetch({ '/api/global/workspaces': () => json([ws('a', 'Alpha')]) }));
    view();
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(await screen.findByRole('link', { name: 'Alpha' })).toHaveAttribute('href', '/w/a/overview');
  });
  it('shows the first-Workspace empty state', async () => {
    fetchMock.mockImplementation(routeFetch({ '/api/global/workspaces': () => json([]) }));
    view();
    expect(await screen.findByText(/No Workspaces yet/)).toBeInTheDocument();
  });
  it('shows a load failure with retry', async () => {
    let fail = true;
    fetchMock.mockImplementation(routeFetch({ '/api/global/workspaces': () => (fail ? json({}, 500) : json([ws('a', 'Alpha')])) }));
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load Workspaces');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'Alpha' })).toBeInTheDocument();
  });
  it('has no rename or delete for Global', async () => {
    fetchMock.mockImplementation(routeFetch({ '/api/global/workspaces': () => json([]) }));
    view();
    await screen.findByText(/No Workspaces yet/);
    expect(screen.queryByRole('button', { name: /delete|rename|save/i })).not.toBeInTheDocument();
  });

  it('creates a Workspace, refreshes the list and navigates to its scoped Overview', async () => {
    let list = [ws('a', 'Alpha')];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        list = [...list, ws('new-one', 'New One')];
        return Promise.resolve(json(ws('new-one', 'New One'), 201));
      }
      return Promise.resolve(json(list));
    });
    view();
    await create('New One');
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith('/w/new-one/overview'));
    expect(postBody()).toEqual({ name: 'New One' });
    // The collection was re-fetched before navigating.
    expect(fetchMock.mock.calls.filter((c) => !c[1]?.method).length).toBe(2);
    expect(fetchMock.mock.calls.every((c) => String(c[0]).startsWith('/api/'))).toBe(true);
  });
  it('sends an explicit slug and description', async () => {
    fetchMock.mockImplementation((_u: string, init?: RequestInit) => Promise.resolve(init?.method === 'POST' ? json(ws('x'), 201) : json([])));
    view();
    await userEvent.type(await screen.findByLabelText('Description (optional)'), 'hi');
    await create('X', 'my-slug');
    await vi.waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(postBody()).toEqual({ name: 'X', slug: 'my-slug', description: 'hi' });
  });
  it('disables the form while submitting', async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation((_u: string, init?: RequestInit) =>
      init?.method === 'POST' ? new Promise<Response>((r) => (release = r)) : Promise.resolve(json([])),
    );
    view();
    await create('Slow');
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    expect(screen.getByLabelText('Name')).toBeDisabled();
    release(json({ message: 'x' }, 400));
    expect(await screen.findByRole('button', { name: 'Create Workspace' })).toBeEnabled();
  });
  it('shows accessible field errors for a reserved slug (400)', async () => {
    fetchMock.mockImplementation((_u: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'POST'
          ? json({ message: 'Invalid request', issues: [{ path: 'slug', message: 'Slug "global" is reserved' }] }, 400)
          : json([]),
      ),
    );
    view();
    await create('Global', 'global');
    const slug = await screen.findByLabelText(/Slug/);
    expect(slug).toHaveAttribute('aria-invalid', 'true');
    expect(slug).toHaveAccessibleDescription(/reserved/);
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'false');
    expect(router.push).not.toHaveBeenCalled();
  });
  it('shows a slug collision (409) on the slug field and allows retry', async () => {
    fetchMock.mockImplementation((_u: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'POST' ? json({ message: 'A Workspace with this slug already exists' }, 409) : json([ws('a')])),
    );
    view();
    await create('Alpha', 'a');
    expect(await screen.findByLabelText(/Slug/)).toHaveAccessibleDescription(/already exists/);
    expect(screen.getByRole('button', { name: 'Create Workspace' })).toBeEnabled();
  });
  it('shows a generic safe error for a server failure and for a network error', async () => {
    fetchMock.mockImplementation((_u: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'POST' ? json({ message: 'SQLITE_ERROR secret detail' }, 500) : json([])),
    );
    view();
    await create('Boom');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(alert).not.toHaveTextContent('SQLITE');
    fetchMock.mockImplementation((_u: string, init?: RequestInit) => (init?.method === 'POST' ? Promise.reject(new TypeError('x')) : Promise.resolve(json([]))));
    await userEvent.click(screen.getByRole('button', { name: 'Create Workspace' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
  });
  it('sends an expired session (401) to the shared login flow', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/global/settings', search: '', assign });
    fetchMock.mockImplementation((_u: string, init?: RequestInit) => Promise.resolve(init?.method === 'POST' ? json({}, 401) : json([])));
    view();
    await create('Late');
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(expect.stringContaining('/login')));
  });
});
