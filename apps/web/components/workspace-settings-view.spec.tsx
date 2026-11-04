// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const router = { push: vi.fn(), replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { WorkspaceSettingsView } from './workspace-settings-view';
import { WorkspacesProvider } from './workspaces-provider';
import { json, ws } from './shell.fixture';

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  router.replace.mockReset();
});

const view = (slug = 'alpha') =>
  render(
    <WorkspacesProvider>
      <WorkspaceSettingsView slug={slug} />
    </WorkspacesProvider>,
  );
const alpha = ws('alpha', 'Alpha', 'uuid-1');
const mutation = (method: string) => fetchMock.mock.calls.find((c) => c[1]?.method === method);

describe('Workspace Settings', () => {
  it('shows loading then the form with a read-only fixed slug', async () => {
    fetchMock.mockResolvedValue(json([alpha]));
    view();
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(await screen.findByLabelText('Name')).toHaveValue('Alpha');
    const slug = screen.getByLabelText('Slug');
    expect(slug).toHaveValue('alpha');
    expect(slug).toHaveAttribute('readonly');
    expect(slug).toHaveAccessibleDescription(/cannot be changed/);
  });
  it('shows a load failure with retry', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 500)).mockResolvedValue(json([alpha]));
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load Workspaces');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Name')).toBeInTheDocument();
  });
  it('shows not found for a stale or unknown slug', async () => {
    fetchMock.mockResolvedValue(json([alpha]));
    view('ghost');
    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Global Overview' })).toHaveAttribute('href', '/global/overview');
    expect(screen.queryByRole('button', { name: 'Delete Workspace' })).not.toBeInTheDocument();
  });

  it('renames name and description without sending a slug, then refreshes and confirms', async () => {
    let list = [alpha];
    fetchMock.mockImplementation((_u: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        list = [{ ...alpha, name: 'Alpha 2', description: 'new' }];
        return Promise.resolve(json(list[0]));
      }
      return Promise.resolve(json(list));
    });
    view();
    const name = await screen.findByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Alpha 2');
    await userEvent.clear(screen.getByLabelText('Description'));
    await userEvent.type(screen.getByLabelText('Description'), 'new');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Workspace saved');
    const [url, init] = mutation('PUT')!;
    expect(url).toBe('/api/workspaces/uuid-1');
    expect(JSON.parse(init.body)).toEqual({ name: 'Alpha 2', description: 'new' });
    expect(fetchMock.mock.calls.filter((c) => !c[1]?.method).length).toBe(2);
  });
  it('shows validation errors on the field and keeps the form usable', async () => {
    fetchMock.mockImplementation((_u: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'PUT'
          ? json({ message: 'Invalid request', issues: [{ path: 'name', message: 'Name must not be empty' }] }, 400)
          : json([alpha]),
      ),
    );
    view();
    await userEvent.clear(await screen.findByLabelText('Name'));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const name = await screen.findByLabelText('Name');
    await vi.waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'));
    expect(name).toHaveAccessibleDescription('Name must not be empty');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });
  it('shows a safe error when saving fails', async () => {
    fetchMock.mockImplementation((_u: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'PUT' ? json({ message: 'stack trace' }, 500) : json([alpha])),
    );
    view();
    await screen.findByLabelText('Name');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(alert).not.toHaveTextContent('stack trace');
  });
  it('shows not found when the Workspace was deleted elsewhere (404 on save)', async () => {
    let list = [alpha];
    fetchMock.mockImplementation((_u: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        list = [];
        return Promise.resolve(json({ message: 'Not Found' }, 404));
      }
      return Promise.resolve(json(list));
    });
    view();
    await screen.findByLabelText('Name');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument();
  });
  it('sends an expired session (401) to the shared login flow', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/w/alpha/settings', search: '', assign });
    fetchMock.mockImplementation((_u: string, init?: RequestInit) => Promise.resolve(init?.method === 'PUT' ? json({}, 401) : json([alpha])));
    view();
    await screen.findByLabelText('Name');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(expect.stringContaining('/login')));
  });

  it('keeps delete disabled until the exact slug is typed and flags a mismatch', async () => {
    fetchMock.mockResolvedValue(json([alpha]));
    view();
    const del = await screen.findByRole('button', { name: 'Delete Workspace' });
    const confirm = screen.getByLabelText(/Type the slug "alpha"/);
    expect(del).toBeDisabled();
    await userEvent.type(confirm, 'alph');
    expect(confirm).toHaveAccessibleDescription('The slug does not match.');
    expect(del).toBeDisabled();
    await userEvent.type(confirm, 'A');
    expect(del).toBeDisabled();
    await userEvent.clear(confirm);
    await userEvent.type(confirm, 'alpha');
    expect(del).toBeEnabled();
    expect(mutation('DELETE')).toBeUndefined();
  });
  it('deletes with the slug confirmation, refreshes the collection and returns to Global', async () => {
    let list = [alpha, ws('beta')];
    fetchMock.mockImplementation((_u: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        list = [list[1]];
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(json(list));
    });
    view();
    await userEvent.type(await screen.findByLabelText(/Type the slug/), 'alpha');
    await userEvent.click(screen.getByRole('button', { name: 'Delete Workspace' }));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/global/overview'));
    const [url, init] = mutation('DELETE')!;
    expect(url).toBe('/api/workspaces/uuid-1');
    expect(JSON.parse(init.body)).toEqual({ slug: 'alpha' });
    expect(fetchMock.mock.calls.filter((c) => !c[1]?.method).length).toBe(2);
  });
  it('shows the API reason when delete fails and stays on the page', async () => {
    fetchMock.mockImplementation((_u: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'DELETE' ? json({ message: 'Workspace still has data and cannot be deleted' }, 409) : json([alpha])),
    );
    view();
    await userEvent.type(await screen.findByLabelText(/Type the slug/), 'alpha');
    await userEvent.click(screen.getByRole('button', { name: 'Delete Workspace' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('still has data');
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete Workspace' })).toBeEnabled();
  });
});
