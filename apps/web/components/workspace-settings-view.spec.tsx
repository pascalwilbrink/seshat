// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const router = { push: vi.fn(), replace: vi.fn() };
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));
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
  toast.success.mockReset();
  toast.error.mockReset();
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
    expect(toast.success).toHaveBeenCalledWith('Workspace saved');
    expect(toast.error).not.toHaveBeenCalled();
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
    expect(toast.error).toHaveBeenCalledWith('Check the highlighted fields.');
    expect(toast.success).not.toHaveBeenCalled();
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
    expect(toast.error).toHaveBeenCalledWith('Something went wrong. Please try again.');
    expect(toast.success).not.toHaveBeenCalled();
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
    expect(toast.error).toHaveBeenCalledWith('This Workspace no longer exists.');
    expect(toast.success).not.toHaveBeenCalled();
  });
  it('toasts a network failure on save and keeps the form', async () => {
    fetchMock.mockImplementation((_u: string, init?: RequestInit) => (init?.method === 'PUT' ? Promise.reject(new TypeError('x')) : Promise.resolve(json([alpha]))));
    view();
    await screen.findByLabelText('Name');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Could not reach the server'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
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

  const openDialog = async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Workspace' }));
    return screen.findByRole('dialog');
  };
  const confirmButton = (d: HTMLElement) => within(d).getByRole('button', { name: 'Delete Workspace' });

  it('opens a modal with the consequence and keeps delete disabled until the exact slug is typed', async () => {
    fetchMock.mockResolvedValue(json([alpha]));
    view();
    const dialog = await openDialog();
    expect(dialog).toHaveAccessibleDescription(/permanently deletes Alpha/);
    const confirm = within(dialog).getByLabelText(/Type alpha to confirm/);
    expect(confirm).toHaveFocus();
    expect(confirmButton(dialog)).toBeDisabled();
    await userEvent.type(confirm, 'alph');
    expect(confirmButton(dialog)).toBeDisabled();
    await userEvent.type(confirm, 'A');
    expect(confirmButton(dialog)).toBeDisabled();
    await userEvent.clear(confirm);
    await userEvent.type(confirm, 'alpha');
    expect(confirmButton(dialog)).toBeEnabled();
    expect(mutation('DELETE')).toBeUndefined();
  });
  it('cancels without deleting, returns focus to the opener and clears the typed slug', async () => {
    fetchMock.mockResolvedValue(json([alpha]));
    view();
    const opener = await screen.findByRole('button', { name: 'Delete Workspace' });
    await userEvent.click(opener);
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Type alpha/), 'alpha');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    expect(mutation('DELETE')).toBeUndefined();
    expect(toast.success).not.toHaveBeenCalled();
    // Escape also cancels, and reopening starts empty.
    const again = await openDialog();
    expect(within(again).getByLabelText(/Type alpha/)).toHaveValue('');
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
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
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText(/Type alpha/), 'alpha');
    await userEvent.click(confirmButton(dialog));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/global/overview'));
    const [url, init] = mutation('DELETE')!;
    expect(url).toBe('/api/workspaces/uuid-1');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual({ slug: 'alpha' });
    expect(fetchMock.mock.calls.filter((c) => !c[1]?.method).length).toBe(2);
    expect(toast.success).toHaveBeenCalledWith('Workspace deleted');
    expect(toast.error).not.toHaveBeenCalled();
  });
  it('treats a 404 on delete as already deleted', async () => {
    fetchMock.mockImplementation((_u: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'DELETE' ? json({ message: 'Not Found' }, 404) : json([alpha])),
    );
    view();
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText(/Type alpha/), 'alpha');
    await userEvent.click(confirmButton(dialog));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/global/overview'));
    expect(toast.success).toHaveBeenCalledWith('Workspace deleted');
    expect(toast.error).not.toHaveBeenCalled();
  });
  it('shows pending state, blocks duplicate submits and cancel while the delete is in flight', async () => {
    let release: (r: Response) => void = () => {};
    let deletes = 0;
    fetchMock.mockImplementation((_u: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deletes += 1;
        return new Promise<Response>((r) => (release = r));
      }
      return Promise.resolve(json([alpha]));
    });
    view();
    const dialog = await openDialog();
    const input = within(dialog).getByLabelText(/Type alpha/);
    await userEvent.type(input, 'alpha');
    await userEvent.click(confirmButton(dialog));
    const working = within(dialog).getByRole('button', { name: 'Working…' });
    expect(working).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(input).toBeDisabled();
    await userEvent.type(input, '{Enter}');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(deletes).toBe(1);
    release(json({ message: 'Workspace still has data' }, 409));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('still has data');
  });
  it('shows the API reason inside the dialog, toasts, stays on the page and allows retry', async () => {
    fetchMock.mockImplementation((_u: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'DELETE' ? json({ message: 'Workspace still has data and cannot be deleted' }, 409) : json([alpha])),
    );
    view();
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText(/Type alpha/), 'alpha');
    await userEvent.click(confirmButton(dialog));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('still has data');
    expect(toast.error).toHaveBeenCalledWith('Workspace still has data and cannot be deleted');
    expect(toast.success).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(confirmButton(dialog)).toBeEnabled();
    // Cancelling clears the stale error for the next attempt.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const again = await openDialog();
    expect(within(again).queryByRole('alert')).not.toBeInTheDocument();
  });
  it('keeps a generic safe message for server and network failures on delete', async () => {
    fetchMock.mockImplementation((_u: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'DELETE' ? json({ message: 'SQLITE_ERROR leak' }, 500) : json([alpha])),
    );
    view();
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText(/Type alpha/), 'alpha');
    await userEvent.click(confirmButton(dialog));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(alert).not.toHaveTextContent('SQLITE');
    fetchMock.mockImplementation((_u: string, init?: RequestInit) => (init?.method === 'DELETE' ? Promise.reject(new TypeError('x')) : Promise.resolve(json([alpha]))));
    await userEvent.click(confirmButton(dialog));
    await vi.waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('Could not reach the server'));
    expect(toast.error).toHaveBeenLastCalledWith(expect.stringContaining('Could not reach the server'));
    expect(router.replace).not.toHaveBeenCalled();
  });
});
