// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PERMISSIONS } from '@seshat/domain';

// Keep the 401 redirect out of jsdom; the view shows its own session message.
vi.mock('@/lib/api-client', () => ({ apiFetch: (p: string, i?: RequestInit) => fetch(p, i) }));

import { ApiKeysView } from './api-keys-view';
import { WorkspacesProvider } from './workspaces-provider';
import { json, ws } from './shell.fixture';
import type { ApiKeyDto } from '@/lib/api-types';

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

const alpha = ws('alpha', 'Alpha', 'uuid-1');
const KEYS = '/api/workspaces/uuid-1/api-keys';
const SECRET = 'sk_test_ABCDEF_not-a-real-secret';

const key = (over: Partial<ApiKeyDto> = {}): ApiKeyDto => ({
  id: 'k1',
  name: 'CI agent',
  prefix: 'skp_abcd',
  permissions: ['files:read', 'search'],
  createdAt: '2026-03-02T10:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  status: 'active',
  ...over,
});

/** Mutable server double. */
function server(initial: ApiKeyDto[], opts: { fail?: Record<string, number> } = {}) {
  let keys = initial;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const fail = opts.fail?.[`${method} ${url}`];
    if (fail) return json({ message: 'nope' }, fail);
    if (url === '/api/global/workspaces') return json([alpha]);
    if (url === KEYS && method === 'GET') return json(keys);
    if (url === KEYS && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      const created = key({ id: 'k2', name: body.name, permissions: body.permissions, expiresAt: body.expiresAt ?? null });
      keys = [...keys, created];
      return json({ apiKey: created, secret: SECRET }, 201);
    }
    const m = /^\/api\/workspaces\/uuid-1\/api-keys\/([^/]+)(\/revoke)?$/.exec(url);
    if (m && method === 'PUT') {
      const body = JSON.parse(String(init?.body));
      keys = keys.map((k) => (k.id === m[1] ? { ...k, ...body } : k));
      return json(keys.find((k) => k.id === m[1]));
    }
    if (m && m[2] && method === 'POST') {
      keys = keys.map((k) => (k.id === m[1] ? { ...k, status: 'revoked' as const, revokedAt: '2026-03-03T10:00:00.000Z' } : k));
      return json(keys.find((k) => k.id === m[1]));
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  });
}

const view = (slug = 'alpha') =>
  render(
    <WorkspacesProvider>
      <ApiKeysView slug={slug} />
    </WorkspacesProvider>,
  );
const calls = (method: string) => fetchMock.mock.calls.filter((c) => (c[1]?.method ?? 'GET') === method);
const checked = () => screen.getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).checked).map((c) => c.closest('label')!.querySelector('code')!.textContent);

async function openCreate() {
  await userEvent.click(await screen.findByRole('button', { name: 'Create API key' }));
}

describe('API keys list', () => {
  it('shows loading, then all metadata with status, using Workspace endpoints only', async () => {
    server([
      key(),
      key({ id: 'k3', name: 'Old', status: 'revoked', revokedAt: '2026-03-03T10:00:00.000Z', lastUsedAt: '2026-03-04T08:30:00.000Z' }),
      key({ id: 'k4', name: 'Gone', status: 'expired', expiresAt: '2026-03-01T00:00:00.000Z' }),
    ]);
    view();
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    const row = (await screen.findByRole('row', { name: /CI agent/ }));
    expect(within(row).getByText('skp_abcd')).toBeInTheDocument();
    expect(within(row).getByText('files:read')).toBeInTheDocument();
    expect(within(row).getByText('2 Mar 2026, 10:00 UTC')).toBeInTheDocument();
    expect(within(row).getAllByText('Never')).toHaveLength(2);
    expect(within(row).getByText('Active')).toBeInTheDocument();
    const revoked = screen.getByRole('row', { name: /Old/ });
    expect(within(revoked).getByText('Revoked')).toBeInTheDocument();
    expect(within(revoked).getByText('4 Mar 2026, 08:30 UTC')).toBeInTheDocument();
    expect(within(revoked).queryByRole('button')).not.toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Gone/ })).getByText('Expired')).toBeInTheDocument();
    for (const [url] of fetchMock.mock.calls) expect(url).toMatch(/^\/api\/(global\/workspaces|workspaces\/uuid-1\/api-keys)/);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/global/api-keys'))).toBe(false);
  });

  it('shows the empty state', async () => {
    server([]);
    view();
    expect(await screen.findByText(/No API keys yet/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows a load failure and retries', async () => {
    let n = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/global/workspaces') return json([alpha]);
      return n++ === 0 ? json({}, 500) : json([key()]);
    });
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('row', { name: /CI agent/ })).toBeInTheDocument();
  });

  it('shows an expired session without a retry loop', async () => {
    server([], { fail: { [`GET ${KEYS}`]: 401 } });
    view();
    expect(await screen.findByRole('alert')).toHaveTextContent('session has expired');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows not found for an unknown Workspace and never lists keys', async () => {
    server([key()]);
    view('ghost');
    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument();
    expect(calls('GET').some(([u]) => String(u).includes('api-keys'))).toBe(false);
  });
});

describe('permission controls', () => {
  it('groups every catalog permission, with Global separate and off initially', async () => {
    server([]);
    view();
    await openCreate();
    const perms = within(screen.getByRole('group', { name: 'Permissions' }));
    for (const area of ['Files', 'Collections', 'Memories', 'Search']) expect(perms.getByRole('group', { name: area })).toBeInTheDocument();
    expect(perms.queryByRole('group', { name: 'Global knowledge' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(PERMISSIONS.length);
    const global = screen.getByRole('group', { name: 'Global knowledge' });
    const toggle = within(global).getByRole('checkbox');
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/matching read permission/);
    expect(checked()).toEqual([]);
  });

  it('applies the exact presets, never delete or global:read, and leaves the Global toggle alone', async () => {
    server([]);
    view();
    await openCreate();
    await userEvent.click(screen.getByRole('button', { name: 'Agent: read' }));
    expect(checked().sort()).toEqual(['collections:read', 'files:read', 'memories:read', 'search']);
    await userEvent.click(screen.getByRole('button', { name: 'Agent: read and write' }));
    expect(checked().sort()).toEqual(
      ['collections:read', 'collections:write', 'files:read', 'files:write', 'memories:read', 'memories:write', 'search'],
    );
    expect(checked().some((p) => p!.endsWith(':delete') || p === 'global:read')).toBe(false);

    const toggle = screen.getByRole('checkbox', { name: /Allow reading Global/ });
    await userEvent.click(toggle);
    expect(checked()).toHaveLength(8);
    expect(checked()).toContain('global:read');
    await userEvent.click(screen.getByRole('button', { name: 'Agent: read' }));
    expect(toggle).toBeChecked(); // an explicit choice is kept
    expect(checked()).toHaveLength(5);
    await userEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(checked()).toHaveLength(4);
  });
});

describe('create and one-time secret', () => {
  it('validates name and permissions before sending', async () => {
    server([]);
    view();
    await openCreate();
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('Name must not be empty');
    expect(screen.getByText('Select at least one permission')).toBeInTheDocument();
    expect(calls('POST')).toHaveLength(0);
  });

  it('creates, shows the secret once, copies, and never persists it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    server([]);
    const { unmount } = view();
    await openCreate();
    await userEvent.type(screen.getByLabelText('Name'), '  Agent one ');
    await userEvent.click(screen.getByRole('button', { name: 'Agent: read' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));

    expect(await screen.findByRole('heading', { name: 'Copy your API key now' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot be shown again/);
    expect(screen.getByLabelText('API key')).toHaveValue(SECRET);
    const post = calls('POST')[0]!;
    expect(post[0]).toBe(KEYS);
    expect(JSON.parse(String(post[1].body))).toEqual({ name: 'Agent one', permissions: ['files:read', 'collections:read', 'memories:read', 'search'] });

    await userEvent.click(screen.getByRole('button', { name: 'Copy key' }));
    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(await screen.findByText('Copied to clipboard.')).toBeInTheDocument();

    // Not in storage, URL, or the list.
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);
    expect(window.location.href).not.toContain(SECRET);
    expect(within(screen.getByRole('table')).queryByText(SECRET)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'I have saved it' }));
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(SECRET);

    // A fresh mount (reload or navigation) never shows it, and the list endpoint never carried it.
    unmount();
    view();
    expect(await screen.findByRole('row', { name: /Agent one/ })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('clears the secret when the view is left', async () => {
    server([]);
    const { unmount } = view();
    await openCreate();
    await userEvent.type(screen.getByLabelText('Name'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Agent: read' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));
    await screen.findByDisplayValue(SECRET);
    unmount();
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('handles a copy failure without losing the secret or crashing', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    server([]);
    view();
    await openCreate();
    await userEvent.type(screen.getByLabelText('Name'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Agent: read' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));
    await screen.findByDisplayValue(SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Copy key' }));
    expect(await screen.findByText(/Could not copy automatically/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(SECRET)).toBeInTheDocument();
  });

  it('sends a future expiry as ISO and rejects a past one', async () => {
    server([]);
    view();
    await openCreate();
    await userEvent.type(screen.getByLabelText('Name'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Agent: read' }));
    const expiry = screen.getByLabelText('Expiry (optional)');
    await userEvent.type(expiry, '2000-01-01T10:00');
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));
    expect(expiry).toHaveAccessibleDescription(/in the future/);
    expect(calls('POST')).toHaveLength(0);
    await userEvent.clear(expiry);
    await userEvent.type(expiry, '2999-01-01T10:00');
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));
    await screen.findByDisplayValue(SECRET);
    expect(JSON.parse(String(calls('POST')[0]![1].body)).expiresAt).toMatch(/^2999-01-01T\d\d:00:00\.000Z$/);
  });

  it('shows API validation failures without echoing the submitted secret and stays usable', async () => {
    server([], { fail: { [`POST ${KEYS}`]: 500 } });
    view();
    await openCreate();
    await userEvent.type(screen.getByLabelText('Name'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Agent: read' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create key' })).toBeEnabled();
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  });

  it('shows a pending state while creating', async () => {
    let release!: () => void;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/global/workspaces') return Promise.resolve(json([alpha]));
      if (init?.method === 'POST') return new Promise((r) => (release = () => r(json({ apiKey: key(), secret: SECRET }, 201))));
      return Promise.resolve(json([]));
    });
    view();
    await openCreate();
    await userEvent.type(screen.getByLabelText('Name'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Agent: read' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create key' }));
    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeDisabled();
    release();
    await screen.findByDisplayValue(SECRET);
  });
});

describe('edit', () => {
  it('edits name and permissions with the same controls and PUTs only those', async () => {
    server([key()]);
    view();
    await userEvent.click(await screen.findByRole('button', { name: /Edit/ }));
    const form = within(screen.getByRole('form', { name: 'Edit API key' }));
    expect(form.getByLabelText('Name')).toHaveValue('CI agent');
    expect(checked().sort()).toEqual(['files:read', 'search']);
    await userEvent.clear(form.getByLabelText('Name'));
    await userEvent.type(form.getByLabelText('Name'), 'Renamed');
    await userEvent.click(form.getByRole('button', { name: 'Agent: read and write' }));
    await userEvent.click(form.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('API key saved.')).toBeInTheDocument();
    const patch = calls('PUT')[0]!;
    expect(patch[0]).toBe(`${KEYS}/k1`);
    const body = JSON.parse(String(patch[1].body));
    expect(Object.keys(body).sort()).toEqual(['name', 'permissions']);
    expect(body.name).toBe('Renamed');
    expect(await screen.findByRole('row', { name: /Renamed/ })).toBeInTheDocument();
  });

  it('keeps the form and shows the failure when saving fails', async () => {
    server([key()], { fail: { [`PUT ${KEYS}/k1`]: 500 } });
    view();
    await userEvent.click(await screen.findByRole('button', { name: /Edit/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Edit API key' })).toBeInTheDocument();
  });

  it('does not offer edit or revoke for non-active keys', async () => {
    server([key({ status: 'expired' })]);
    view();
    await screen.findByRole('row', { name: /CI agent/ });
    expect(screen.queryByRole('button', { name: /Edit|Revoke/ })).not.toBeInTheDocument();
  });
});

describe('revoke', () => {
  it('cancel closes the dialog without a request', async () => {
    server([key()]);
    view();
    await userEvent.click(await screen.findByRole('button', { name: /Revoke/ }));
    const dialog = screen.getByRole('alertdialog', { name: /Revoke “CI agent”/ });
    expect(dialog).toHaveAccessibleDescription(/cannot be undone/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(calls('POST')).toHaveLength(0);
  });

  it('Escape cancels', async () => {
    server([key()]);
    view();
    await userEvent.click(await screen.findByRole('button', { name: /Revoke/ }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('confirm revokes and refreshes the status', async () => {
    server([key()]);
    view();
    await userEvent.click(await screen.findByRole('button', { name: /Revoke/ }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke key' }));
    expect(await screen.findByText('API key revoked.')).toBeInTheDocument();
    expect(calls('POST')[0]![0]).toBe(`${KEYS}/k1/revoke`);
    await waitFor(() => expect(within(screen.getByRole('row', { name: /CI agent/ })).getByText('Revoked')).toBeInTheDocument());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows a failure in the dialog and allows retry', async () => {
    server([key()], { fail: { [`POST ${KEYS}/k1/revoke`]: 500 } });
    view();
    await userEvent.click(await screen.findByRole('button', { name: /Revoke/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Revoke key' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('button', { name: 'Revoke key' })).toBeEnabled();
  });
});
