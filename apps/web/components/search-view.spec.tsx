// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api-client', () => ({ apiFetch: (p: string, i?: RequestInit) => fetch(p, i), handleUnauthorized: vi.fn() }));

import { SearchView, buildRequest } from './search-view';
import { WorkspacesProvider } from './workspaces-provider';
import { json, ws } from './shell.fixture';
import type { ChunkSearchResultDto, MemorySearchResultDto, SearchResponseDto } from '@/lib/api-types';
import type { Scope } from '@/lib/scope';

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

const alpha = ws('alpha', 'Alpha', 'uuid-1');
const beta = ws('beta', 'Beta', 'uuid-2');
const FILE = '11111111-1111-4111-8111-111111111111';
const CHUNK = '22222222-2222-4222-8222-222222222222';
const MEM = '33333333-3333-4333-8333-333333333333';
const base = { score: 0.0328, vectorRank: 1, keywordRank: 2 };
const chunk = (over: Partial<ChunkSearchResultDto> = {}): ChunkSearchResultDto => ({
  ...base, kind: 'chunk', id: CHUNK, scope: { kind: 'workspace', id: 'uuid-1', slug: 'alpha' }, content: 'The invoice number is INV-42 today',
  file: { id: FILE, name: 'notes.md' }, collectionId: null, ordinal: 2, location: { headingPath: ['Billing'], startOffset: 0, endOffset: 9, startLine: 4, endLine: 6 }, ...over,
});
const mem = (over: Partial<MemorySearchResultDto> = {}): MemorySearchResultDto => ({
  ...base, kind: 'memory', id: MEM, scope: { kind: 'global' }, content: 'Prefer short answers', memoryType: 'preference', title: 'Style', tags: ['voice'], status: 'active',
  confidence: null, source: null, provenance: { createdBy: { kind: 'admin', keyId: null, keyName: null }, client: null }, updatedAt: '2026-03-03T10:00:00.000Z', ...over,
});

type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
function routes(searchHandler: Route, extra: Route[] = []) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    for (const h of extra) {
      const r = h(url, init);
      if (r) return Promise.resolve(r);
    }
    if (url === '/api/global/workspaces') return Promise.resolve(json([alpha, beta]));
    if (url.endsWith('/collections')) return Promise.resolve(json([{ id: 'c1', name: 'Docs' }]));
    if (url.includes('/files?')) return Promise.resolve(json({ items: [{ id: FILE, name: 'notes.md' }], nextCursor: null, hasMore: false, limit: 100 }));
    if (url.endsWith('/tags')) return Promise.resolve(json([{ id: 't1', name: 'voice' }, { id: 't2', name: 'billing' }]));
    const r = searchHandler(url, init);
    if (r) return Promise.resolve(r);
    throw new Error(`Unexpected fetch ${url}`);
  });
}
const searchCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/search'));
const lastBody = () => JSON.parse(String(searchCalls().at(-1)![1].body));
const respond = (body: SearchResponseDto) => json(body);
const ok = (body: SearchResponseDto): Route => (u) => (u.endsWith('/search') ? respond(body) : undefined);

const renderScope = (scope: Scope) => render(<WorkspacesProvider><SearchView scope={scope} /></WorkspacesProvider>);
const G: Scope = { kind: 'global' };
const A: Scope = { kind: 'workspace', slug: 'alpha' };
async function search(user: ReturnType<typeof userEvent.setup>, q: string) {
  await screen.findByLabelText('Query');
  await user.clear(screen.getByLabelText('Query'));
  await user.type(screen.getByLabelText('Query'), q);
  await user.click(screen.getByRole('button', { name: 'Search' }));
}

describe('SearchView states', () => {
  it('starts idle without a request', async () => {
    routes(ok({ results: [] }));
    renderScope(G);
    expect(await screen.findByText('Search your knowledge')).toBeInTheDocument();
    expect(searchCalls()).toHaveLength(0);
  });

  it('validates the query before sending', async () => {
    routes(ok({ results: [] }));
    const user = userEvent.setup();
    renderScope(G);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByText('Enter something to search for.')).toBeInTheDocument();
    expect(searchCalls()).toHaveLength(0);
  });

  it('shows loading skeletons and a disabled button while searching', async () => {
    let release!: (r: Response) => void;
    routes((u) => (u.endsWith('/search') ? (new Promise<Response>((r) => (release = r)) as unknown as Response) : undefined));
    const user = userEvent.setup();
    renderScope(G);
    await search(user, 'invoice');
    expect(await screen.findByRole('status', { name: 'Searching' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Searching…' })).toBeDisabled();
    release(respond({ results: [] }));
    expect(await screen.findByText('No results')).toBeInTheDocument();
  });

  it('does not submit twice while a request is running', async () => {
    let release!: (r: Response) => void;
    routes((u) => (u.endsWith('/search') ? (new Promise<Response>((r) => (release = r)) as unknown as Response) : undefined));
    const user = userEvent.setup();
    renderScope(G);
    await user.type(screen.getByLabelText('Query'), 'invoice');
    const form = screen.getByRole('form', { name: 'Search knowledge' });
    await user.click(screen.getByRole('button', { name: 'Search' }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    release(respond({ results: [chunk({ scope: { kind: 'global' } })] }));
    await screen.findByRole('list', { name: 'Search results' });
    expect(searchCalls()).toHaveLength(1);
  });

  it('shows the empty state', async () => {
    routes(ok({ results: [] }));
    const user = userEvent.setup();
    renderScope(G);
    await search(user, 'nothing');
    expect(await screen.findByText('No results')).toBeInTheDocument();
  });

  it('shows failure and retries the same request', async () => {
    let n = 0;
    routes((u) => (u.endsWith('/search') ? (n++ === 0 ? json({ message: 'boom stack' }, 500) : respond({ results: [mem()] })) : undefined));
    const user = userEvent.setup();
    renderScope(G);
    await search(user, 'style');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong. Please try again.');
    expect(alert).not.toHaveTextContent('boom');
    await user.click(screen.getByRole('button', { name: 'Retry search' }));
    expect(await screen.findByRole('list', { name: 'Search results' })).toBeInTheDocument();
    expect(searchCalls()).toHaveLength(2);
    expect(JSON.parse(String(searchCalls()[0]![1].body))).toEqual(JSON.parse(String(searchCalls()[1]![1].body)));
  });

  it('reports network failures and a missing permission safely', async () => {
    let mode: 'net' | 'forbidden' = 'net';
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/global/workspaces') return Promise.resolve(json([alpha]));
      if (url.endsWith('/search')) return mode === 'net' ? Promise.reject(new Error('down')) : Promise.resolve(json({ message: 'secret' }, 403));
      return Promise.resolve(json([]));
    });
    const user = userEvent.setup();
    renderScope(G);
    await search(user, 'a1');
    expect(await screen.findByText('Could not reach the server. Check your connection and try again.')).toBeInTheDocument();
    mode = 'forbidden';
    await user.click(screen.getByRole('button', { name: 'Retry search' }));
    expect(await screen.findByText(/not allowed to search/)).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('shows an expired session without retry', async () => {
    routes((u) => (u.endsWith('/search') ? json({}, 401) : undefined));
    const user = userEvent.setup();
    renderScope(G);
    await search(user, 'a1');
    expect(await screen.findByText('Your session has expired. Log in again to continue.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry search' })).not.toBeInTheDocument();
  });

  it('shows the keyword-only notice', async () => {
    routes(ok({ results: [chunk()], degraded: 'keyword_only' }));
    const user = userEvent.setup();
    renderScope(A);
    await search(user, 'invoice');
    expect(await screen.findByText(/Showing keyword matches only/)).toBeInTheDocument();
  });

  it('shows no notice for normal results and no totals', async () => {
    routes(ok({ results: [chunk()] }));
    const user = userEvent.setup();
    renderScope(A);
    await search(user, 'invoice');
    await screen.findByRole('list', { name: 'Search results' });
    expect(screen.queryByText(/keyword matches only/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ results?/i)).not.toBeInTheDocument();
  });
});

describe('SearchView request contract', () => {
  it('posts to the Global route with only the Global contract', async () => {
    routes(ok({ results: [] }));
    const user = userEvent.setup();
    renderScope(G);
    await search(user, '  hello  ');
    await screen.findByText('No results');
    expect(searchCalls()[0]![0]).toBe('/api/global/search');
    expect(searchCalls()[0]![1].method).toBe('POST');
    expect(lastBody()).toEqual({ query: 'hello', types: ['files', 'memories'], limit: 10 });
    expect(screen.queryByLabelText('Include Global')).not.toBeInTheDocument();
  });

  it('posts to the Workspace route by id with Include Global off by default', async () => {
    routes(ok({ results: [] }));
    const user = userEvent.setup();
    renderScope(A);
    expect(await screen.findByLabelText('Include Global')).not.toBeChecked();
    await search(user, 'hello');
    await screen.findByText('No results');
    expect(searchCalls()[0]![0]).toBe('/api/workspaces/uuid-1/search');
    expect(lastBody()).toEqual({ query: 'hello', types: ['files', 'memories'], limit: 10, includeGlobal: false });
    await user.click(screen.getByLabelText('Include Global'));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(searchCalls()).toHaveLength(2));
    expect(lastBody().includeGlobal).toBe(true);
  });

  it('keeps at least one type selected and sends only applicable filters', async () => {
    routes(ok({ results: [] }));
    const user = userEvent.setup();
    renderScope(A);
    await screen.findByRole('option', { name: 'Docs' });
    await user.selectOptions(screen.getByLabelText('Collection'), 'c1');
    await user.selectOptions(screen.getByLabelText('File'), FILE);
    await user.selectOptions(screen.getByLabelText('Memory type'), 'decision');
    await user.click(screen.getByLabelText('Include superseded Memories'));
    await user.click(await screen.findByLabelText('voice'));
    await user.click(screen.getByLabelText('billing'));
    await user.selectOptions(screen.getByLabelText('Tag matching'), 'all');
    await search(user, 'x1');
    await screen.findByText('No results');
    expect(lastBody()).toEqual({
      query: 'x1', types: ['files', 'memories'], limit: 10, includeGlobal: false, collectionIds: ['c1'], fileIds: [FILE],
      tags: ['voice', 'billing'], tagMatch: 'all', memoryTypes: ['decision'], includeSuperseded: true,
    });

    // Memories off: file filters are hidden and not sent.
    await user.click(screen.getByLabelText('Memories'));
    expect(screen.getByLabelText('Files')).toBeDisabled();
    expect(screen.queryByLabelText('Memory type')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(searchCalls()).toHaveLength(2));
    expect(lastBody().types).toEqual(['files']);
    expect(lastBody().memoryTypes).toBeUndefined();
    expect(lastBody().includeSuperseded).toBeUndefined();

    // Files off instead: Collection and file are not sent.
    await user.click(screen.getByLabelText('Memories'));
    await user.click(screen.getByLabelText('Files'));
    expect(screen.queryByLabelText('Collection')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(searchCalls()).toHaveLength(3));
    expect(lastBody().types).toEqual(['memories']);
    expect(lastBody().collectionIds).toBeUndefined();
    expect(lastBody().fileIds).toBeUndefined();
  });

  it('validates and sends limit and minimum score', async () => {
    routes(ok({ results: [] }));
    const user = userEvent.setup();
    renderScope(G);
    await user.type(screen.getByLabelText('Query'), 'q1');
    await user.clear(screen.getByLabelText('Result limit'));
    await user.type(screen.getByLabelText('Result limit'), '99');
    await user.type(screen.getByLabelText('Minimum score'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByText('Enter a whole number from 1 to 50.')).toBeInTheDocument();
    expect(screen.getByText('Enter a number.')).toBeInTheDocument();
    expect(searchCalls()).toHaveLength(0);
    await user.clear(screen.getByLabelText('Result limit'));
    await user.type(screen.getByLabelText('Result limit'), '5');
    await user.clear(screen.getByLabelText('Minimum score'));
    await user.type(screen.getByLabelText('Minimum score'), '0.02');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText('No results');
    expect(lastBody()).toMatchObject({ limit: 5, minScore: 0.02 });
  });

  it('buildRequest never emits empty optional fields', () => {
    const f = { query: 'a b', files: true, memories: true, collectionId: '', fileId: '', tags: [], tagMatch: 'any' as const, memoryType: '' as const, includeSuperseded: false, includeGlobal: false, limit: '10', minScore: '' };
    expect(buildRequest(f, false)).toEqual({ ok: true, body: { query: 'a b', types: ['files', 'memories'], limit: 10 } });
  });

  it('does not offer file options of a scope that denies them', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/global/workspaces') return Promise.resolve(json([alpha]));
      if (url.includes('/collections') || url.includes('/files?') || url.endsWith('/tags')) return Promise.resolve(json({}, 403));
      throw new Error(`Unexpected fetch ${url}`);
    });
    renderScope(G);
    expect(await screen.findByText(/Some filter options could not be loaded/)).toBeInTheDocument();
    expect(screen.getByLabelText('Collection').querySelectorAll('option')).toHaveLength(1);
  });

  it('only reads options of the requested types', async () => {
    routes(ok({ results: [] }));
    const user = userEvent.setup();
    renderScope(G);
    await screen.findByRole('option', { name: 'Docs' });
    fetchMock.mockClear();
    await user.click(screen.getByLabelText('Files'));
    await waitFor(() => expect(screen.queryByLabelText('Collection')).not.toBeInTheDocument());
    await waitFor(() => expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(['/api/global/tags']));
  });
});

describe('SearchView results', () => {
  it('cites kind, scope, source, location and a highlighted excerpt with links into the right scope', async () => {
    routes(ok({ results: [chunk(), chunk({ id: 'c-g', scope: { kind: 'global' }, file: { id: FILE, name: 'global.md' } }), mem()] }));
    const user = userEvent.setup();
    renderScope(A);
    await search(user, 'INV-42');
    const items = within(await screen.findByRole('list', { name: 'Search results' })).getAllByRole('listitem');
    expect(items).toHaveLength(3);

    const first = items[0]!;
    expect(within(first).getByText('File')).toBeInTheDocument();
    expect(first.dataset.scope).toBe('workspace');
    expect(within(first).getByText('Workspace')).toBeInTheDocument();
    expect(within(first).getByText('Chunk 3 · Billing · lines 4–6')).toBeInTheDocument();
    expect(first.querySelector('mark')?.textContent).toBe('INV-42');
    expect(within(first).getByRole('link', { name: 'notes.md' })).toHaveAttribute('href', `/w/alpha/files?file=${FILE}&chunk=${CHUNK}&ordinal=2`);

    // A Global result on a Workspace page opens the Global detail.
    expect(items[1]!.dataset.scope).toBe('global');
    expect(within(items[1]!).getByRole('link', { name: 'global.md' })).toHaveAttribute('href', `/global/files?file=${FILE}&chunk=c-g&ordinal=2`);

    const m = items[2]!;
    expect(within(m).getByText('Memory')).toBeInTheDocument();
    expect(within(m).getByText('preference')).toBeInTheDocument();
    expect(within(m).getByText('Tags: voice')).toBeInTheDocument();
    expect(within(m).getByRole('link', { name: 'Style' })).toHaveAttribute('href', `/global/memories?memory=${MEM}`);
  });

  it('renders hostile content, titles and queries as text only', async () => {
    const evil = '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=1</script> needle';
    routes(ok({ results: [chunk({ content: evil, file: { id: FILE, name: '<b>bold</b>.md' } }), mem({ content: evil, title: '<i>t</i>', tags: ['<u>x</u>'] })] }));
    const user = userEvent.setup();
    const { container } = renderScope(G);
    await search(user, '<img needle');
    await screen.findByRole('list', { name: 'Search results' });
    const list = container.querySelector('ol')!;
    expect(list.querySelector('img, script, b, i, u')).toBeNull();
    expect(list.textContent).toContain('<img src=x onerror="window.__pwned=1">');
    expect(within(list).getByRole('link', { name: '<b>bold</b>.md' })).toBeInTheDocument();
    expect([...list.querySelectorAll('mark')].map((m) => m.textContent)).toContain('needle');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(container.innerHTML).not.toContain('dangerouslySetInnerHTML');
  });
});

describe('SearchView races and scope changes', () => {
  it('ignores a stale response after the query is edited', async () => {
    const pending: ((r: Response) => void)[] = [];
    routes((u) => (u.endsWith('/search') ? (new Promise<Response>((r) => pending.push(r)) as unknown as Response) : undefined));
    const user = userEvent.setup();
    renderScope(G);
    await search(user, 'first');
    await waitFor(() => expect(pending).toHaveLength(1));
    await user.type(screen.getByLabelText('Query'), ' more'); // cancels the running search
    expect(screen.getByText('Search your knowledge')).toBeInTheDocument();
    pending[0]!(respond({ results: [mem({ title: 'Stale hit' })] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Stale hit')).not.toBeInTheDocument();
    expect((searchCalls()[0]![1].signal as AbortSignal).aborted).toBe(true);
  });

  it('shows nothing of the old Workspace after switching, and ignores its late response', async () => {
    const pending: ((r: Response) => void)[] = [];
    let releaseBeta!: () => void;
    const betaOptions = new Promise<void>((r) => (releaseBeta = r));
    routes(
      (u) => (u.endsWith('/search') ? (new Promise<Response>((r) => pending.push(r)) as unknown as Response) : undefined),
      [(u) => (u === '/api/workspaces/uuid-2/collections' ? (betaOptions.then(() => json([{ id: 'c9', name: 'Beta docs' }])) as unknown as Response) : undefined)],
    );
    const user = userEvent.setup();
    const { rerender } = renderScope(A);
    await screen.findByRole('option', { name: 'Docs' });
    await user.click(await screen.findByLabelText('Include Global'));
    await search(user, 'secret-alpha');
    await waitFor(() => expect(pending).toHaveLength(1));

    rerender(<WorkspacesProvider><SearchView scope={{ kind: 'workspace', slug: 'beta' }} /></WorkspacesProvider>);
    // Fresh panel: empty query, default toggles, no options until they are read for the new scope.
    await waitFor(() => expect(screen.getByLabelText('Query')).toHaveValue(''));
    expect(screen.getByLabelText('Include Global')).not.toBeChecked();
    expect(screen.queryByRole('option', { name: 'Docs' })).not.toBeInTheDocument();
    expect(screen.getByText('Search your knowledge')).toBeInTheDocument();

    pending[0]!(respond({ results: [chunk({ content: 'ALPHA ONLY secret' })] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/ALPHA ONLY/)).not.toBeInTheDocument();
    releaseBeta();
    await screen.findByRole('option', { name: 'Beta docs' });
    expect(screen.queryByRole('option', { name: 'Docs' })).not.toBeInTheDocument();
  });

  it('lets only the newest of two sequential searches write results', async () => {
    const bodies: string[] = [];
    routes((u, init) => {
      if (!u.endsWith('/search')) return undefined;
      bodies.push(JSON.parse(String(init!.body)).query);
      return respond({ results: [mem({ title: `Hit for ${bodies.at(-1)}` })] });
    });
    const user = userEvent.setup();
    renderScope(G);
    await search(user, 'one');
    await screen.findByText('Hit for one');
    await search(user, 'two');
    await screen.findByText('Hit for two');
    expect(screen.queryByText('Hit for one')).not.toBeInTheDocument();
  });

  it('handles an unknown Workspace and a failed Workspace list', async () => {
    routes(ok({ results: [] }));
    renderScope({ kind: 'workspace', slug: 'nope' });
    expect(await screen.findByText('Workspace not found')).toBeInTheDocument();
  });

  it('offers a retry when Workspaces cannot be loaded', async () => {
    fetchMock.mockResolvedValue(json({}, 500));
    renderScope(A);
    expect(await screen.findByText('Could not load Workspaces.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
