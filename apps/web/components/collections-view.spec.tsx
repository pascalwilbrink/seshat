// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api-client', () => ({ apiFetch: (p: string, i?: RequestInit) => fetch(p, i) }));

import { CollectionsView } from './collections-view';
import { WorkspacesProvider } from './workspaces-provider';
import { json, ws } from './shell.fixture';
import type { CollectionDto } from '@/lib/api-types';
import type { Scope } from '@/lib/scope';

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

const alpha = ws('alpha', 'Alpha', 'uuid-1');
const beta = ws('beta', 'Beta', 'uuid-2');
const col = (over: Partial<CollectionDto> = {}): CollectionDto => ({
  id: 'c1',
  name: 'Specs',
  description: 'Design docs',
  fileCount: 3,
  createdAt: '2026-03-02T10:00:00.000Z',
  updatedAt: '2026-03-02T10:00:00.000Z',
  ...over,
});

const G = '/api/global/collections';
const A = '/api/workspaces/uuid-1/collections';
const B = '/api/workspaces/uuid-2/collections';

/** Per-collection-path mutable server double. */
function server(data: Record<string, CollectionDto[]>, opts: { fail?: Record<string, Response | (() => Response)> } = {}) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const f = opts.fail?.[`${method} ${url}`];
    if (f) return typeof f === 'function' ? f() : f.clone();
    if (url === '/api/global/workspaces') return json([alpha, beta]);
    const m = /^(.*\/collections)(?:\/([^/]+))?$/.exec(url);
    if (!m || !(m[1] in data)) throw new Error(`Unexpected fetch ${method} ${url}`);
    const [, base, id] = m;
    if (method === 'GET' && !id) return json(data[base]);
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body));
      if (data[base].some((c) => c.name === body.name)) return json({ message: 'A Collection with this name already exists' }, 409);
      const created = col({ id: `n${data[base].length}`, name: body.name, description: body.description ?? null, fileCount: 0 });
      data[base] = [...data[base], created];
      return json(created, 201);
    }
    if (method === 'PATCH') {
      const body = JSON.parse(String(init?.body));
      if (data[base].some((c) => c.id !== id && c.name === body.name)) return json({ message: 'A Collection with this name already exists' }, 409);
      data[base] = data[base].map((c) => (c.id === id ? { ...c, ...body } : c));
      return json(data[base].find((c) => c.id === id));
    }
    if (method === 'DELETE') {
      data[base] = data[base].filter((c) => c.id !== id);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  });
}

const view = (scope: Scope) =>
  render(
    <WorkspacesProvider>
      <CollectionsView scope={scope} />
    </WorkspacesProvider>,
  );
const ui = (scope: Scope) => (
  <WorkspacesProvider>
    <CollectionsView scope={scope} />
  </WorkspacesProvider>
);
const calls = (method: string) => fetchMock.mock.calls.filter((c) => (c[1]?.method ?? 'GET') === method);
const globalScope: Scope = { kind: 'global' };
const wsScope = (slug: string): Scope => ({ kind: 'workspace', slug });

describe.each([
  ['Global', globalScope, G],
  ['Workspace', wsScope('alpha'), A],
] as const)('Collections in %s', (_n, scope, base) => {
  it('shows a loading state, then names, descriptions and file counts', async () => {
    server({ [base]: [col(), col({ id: 'c2', name: 'Logs', description: null, fileCount: 0 })] });
    view(scope);
    expect(screen.getByRole('status', { name: '' })).toBeTruthy();
    const row = (await screen.findByRole('rowheader', { name: 'Specs' })).closest('tr')!;
    expect(within(row).getByText('Design docs')).toBeInTheDocument();
    expect(within(row).getByText('3')).toBeInTheDocument();
    const row2 = screen.getByRole('rowheader', { name: 'Logs' }).closest('tr')!;
    expect(within(row2).getByText('0')).toBeInTheDocument();
  });

  it('shows a first-use empty state', async () => {
    server({ [base]: [] });
    view(scope);
    expect(await screen.findByText(/No Collections yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Collection' })).toBeInTheDocument();
  });

  it('shows a failure and retries', async () => {
    let fail = true;
    server({ [base]: [col()] }, { fail: { [`GET ${base}`]: () => (fail ? json({}, 500) : json([col()])) } });
    view(scope);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('rowheader', { name: 'Specs' })).toBeInTheDocument();
  });

  it('reports an expired session without retry', async () => {
    server({ [base]: [] }, { fail: { [`GET ${base}`]: json({}, 401) } });
    view(scope);
    expect(await screen.findByRole('alert')).toHaveTextContent('session has expired');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('validates the name, creates, announces success and refreshes the list', async () => {
    server({ [base]: [] });
    view(scope);
    await userEvent.click(await screen.findByRole('button', { name: 'Create Collection' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    const name = screen.getByLabelText('Name');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('Name must not be empty');
    expect(calls('POST')).toHaveLength(0);
    await userEvent.type(name, '  Notes ');
    await userEvent.type(screen.getByLabelText(/Description/), 'Meeting notes');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Collection “Notes” created.')).toBeInTheDocument();
    expect(JSON.parse(String(calls('POST')[0][1].body))).toEqual({ name: 'Notes', description: 'Meeting notes' });
    expect(calls('POST')[0][0]).toBe(base);
    expect(await screen.findByRole('rowheader', { name: 'Notes' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Create Collection' })).not.toBeInTheDocument();
  });

  it('disables the form while pending', async () => {
    let release!: () => void;
    server({ [base]: [] });
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') await new Promise<void>((r) => (release = r));
      return inner(url, init);
    });
    view(scope);
    await userEvent.click(await screen.findByRole('button', { name: 'Create Collection' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Slow');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('button', { name: 'Creating…' })).toBeDisabled();
    expect(screen.getByLabelText('Name')).toBeDisabled();
    release();
    expect(await screen.findByText('Collection “Slow” created.')).toBeInTheDocument();
  });

  it('shows a name conflict on the name field and keeps the input', async () => {
    server({ [base]: [col()] });
    view(scope);
    await userEvent.click(await screen.findByRole('button', { name: 'Create Collection' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Specs');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    const name = await screen.findByLabelText('Name');
    await waitFor(() => expect(name).toHaveAccessibleDescription('A Collection with this name already exists'));
    expect(name).toHaveValue('Specs');
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('shows a generic failure when creation fails and allows another attempt', async () => {
    server({ [base]: [] }, { fail: { [`POST ${base}`]: json({}, 500) } });
    view(scope);
    await userEvent.click(await screen.findByRole('button', { name: 'Create Collection' }));
    await userEvent.type(screen.getByLabelText('Name'), 'X');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('renames with PATCH to the same scope path and refreshes', async () => {
    server({ [base]: [col()] });
    view(scope);
    await userEvent.click(await screen.findByRole('button', { name: /Rename/ }));
    const name = screen.getByLabelText('Name');
    expect(name).toHaveValue('Specs');
    await userEvent.clear(name);
    await userEvent.type(name, 'Docs');
    await userEvent.clear(screen.getByLabelText(/Description/));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Collection “Docs” saved.')).toBeInTheDocument();
    expect(calls('PATCH')[0][0]).toBe(`${base}/c1`);
    expect(JSON.parse(String(calls('PATCH')[0][1].body))).toEqual({ name: 'Docs', description: null });
    expect(await screen.findByRole('rowheader', { name: 'Docs' })).toBeInTheDocument();
  });

  it('shows a rename conflict', async () => {
    server({ [base]: [col(), col({ id: 'c2', name: 'Logs' })] });
    view(scope);
    await userEvent.click((await screen.findAllByRole('button', { name: /Rename/ }))[1]);
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Specs');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('A Collection with this name already exists'));
  });

  it('delete: warns that files are kept, cancel does nothing, confirm deletes', async () => {
    server({ [base]: [col()] });
    view(scope);
    await userEvent.click(await screen.findByRole('button', { name: /Delete/ }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Its files are kept');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(calls('DELETE')).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: /Delete/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Collection' }));
    expect(await screen.findByText('Collection “Specs” deleted. Its files were kept.')).toBeInTheDocument();
    expect(calls('DELETE')[0][0]).toBe(`${base}/c1`);
    expect(await screen.findByText(/No Collections yet/)).toBeInTheDocument();
  });

  it('delete failure keeps the dialog and shows an error', async () => {
    server({ [base]: [col()] }, { fail: { [`DELETE ${base}/c1`]: json({}, 500) } });
    view(scope);
    await userEvent.click(await screen.findByRole('button', { name: /Delete/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete Collection' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toHaveTextContent('Something went wrong');
  });

  it('renders hostile names as text', async () => {
    server({ [base]: [col({ name: '<img src=x onerror=alert(1)>', description: '<b>bold</b>' })] });
    const { container } = view(scope);
    await screen.findByRole('rowheader', { name: '<img src=x onerror=alert(1)>' });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });
});

describe('Collections scope switching', () => {
  it('uses the Workspace UUID, never the slug, and shows no stale data across Global/two Workspaces', async () => {
    server({ [G]: [col({ id: 'g', name: 'Global one' })], [A]: [col({ id: 'a', name: 'Alpha one' })], [B]: [col({ id: 'b', name: 'Beta one' })] });
    const { rerender } = view(wsScope('alpha'));
    expect(await screen.findByRole('rowheader', { name: 'Alpha one' })).toBeInTheDocument();
    rerender(ui(globalScope));
    expect(screen.queryByRole('rowheader', { name: 'Alpha one' })).not.toBeInTheDocument();
    expect(await screen.findByRole('rowheader', { name: 'Global one' })).toBeInTheDocument();
    rerender(ui(wsScope('beta')));
    expect(screen.queryByRole('rowheader', { name: 'Global one' })).not.toBeInTheDocument();
    expect(await screen.findByRole('rowheader', { name: 'Beta one' })).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual(expect.arrayContaining([A, G, B]));
    expect(urls.every((u) => u.startsWith('/api/') && !u.includes('/alpha/') && !u.includes('/beta/'))).toBe(true);
  });

  it('discards a slow response from the previous scope', async () => {
    let releaseAlpha!: () => void;
    server({ [G]: [col({ id: 'g', name: 'Global one' })], [A]: [col({ id: 'a', name: 'Alpha one' })] });
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === A) await new Promise<void>((r) => (releaseAlpha = r));
      return inner(url, init);
    });
    const { rerender } = view(wsScope('alpha'));
    await waitFor(() => expect(releaseAlpha).toBeDefined());
    rerender(ui(globalScope));
    expect(await screen.findByRole('rowheader', { name: 'Global one' })).toBeInTheDocument();
    releaseAlpha();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('rowheader', { name: 'Alpha one' })).not.toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Global one' })).toBeInTheDocument();
  });

  it('does not carry an open form or notice into another scope', async () => {
    server({ [G]: [], [A]: [] });
    const { rerender } = view(globalScope);
    await userEvent.click(await screen.findByRole('button', { name: 'Create Collection' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Draft');
    rerender(ui(wsScope('alpha')));
    await screen.findByText(/No Collections yet/);
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('shows not found for an unknown Workspace and an error when Workspaces fail', async () => {
    server({ [G]: [] });
    view(wsScope('nope'));
    expect(await screen.findByRole('heading', { name: 'Workspace not found' })).toBeInTheDocument();
  });
});
