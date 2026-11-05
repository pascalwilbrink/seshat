// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api-client', () => ({ apiFetch: (p: string, i?: RequestInit) => fetch(p, i), handleUnauthorized: vi.fn() }));

import { MemoriesView } from './memories-view';
import { WorkspacesProvider } from './workspaces-provider';
import { json, ws } from './shell.fixture';
import { MEMORY_POLL_MS } from './memory-detail';
import type { MemoryDto } from '@/lib/api-types';

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

const mem = (over: Partial<MemoryDto> = {}): MemoryDto => ({
  id: 'm1', scope: 'global', workspaceId: null, type: 'fact', content: 'The sky is blue', title: 'Sky',
  metadata: { keep: { me: true } }, confidence: 0.7, source: 'doc', tags: ['nature'], status: 'active', supersededBy: null,
  provenance: { createdBy: { kind: 'admin', keyId: null, keyName: null }, client: null },
  embeddingStatus: 'ready', embeddingModel: 'm', createdAt: '2026-03-02T10:00:00.000Z', updatedAt: '2026-03-03T10:00:00.000Z', ...over,
});
const page = (items: MemoryDto[]) => json({ items, nextCursor: null, hasMore: false, limit: 25 });
type Call = { url: string; init?: RequestInit };
const calls = (): Call[] => fetchMock.mock.calls.map((c) => ({ url: String(c[0]), init: c[1] as RequestInit | undefined }));
const mutations = () => calls().filter((c) => c.init?.method && c.init.method !== 'GET');
const body = (c: Call) => JSON.parse(String(c.init!.body));

/** Mutable server: `items` is what the list returns; `handler` answers everything else. */
function server(items: MemoryDto[], handler: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/global/workspaces') return Promise.resolve(json([ws('alpha', 'Alpha', 'uuid-1')]));
    if (url.endsWith('/tags')) return Promise.resolve(json([]));
    if (url.startsWith('/api/global/memories?')) return Promise.resolve(page(items));
    const r = handler(url, init);
    if (r) return Promise.resolve(r);
    throw new Error(`Unexpected fetch ${init?.method ?? 'GET'} ${url}`);
  });
}
const renderGlobal = () => render(<WorkspacesProvider><MemoriesView scope={{ kind: 'global' }} /></WorkspacesProvider>);

async function openCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'New Memory' }));
  return screen.findByRole('form', { name: 'New Memory' });
}
const created = (over: Partial<MemoryDto> = {}, extra: object = {}) => json({ ...mem({ id: 'new1', title: null, content: 'Fresh', ...over }), deduplicated: false, hints: [], ...extra }, 201);

describe('create', () => {
  it('validates before sending, then posts only editable fields and refreshes the list', async () => {
    const items: MemoryDto[] = [];
    server(items, (u, i) => (u === '/api/global/memories' && i?.method === 'POST' ? (items.push(mem({ id: 'new1', title: 'Made' })), created()) : undefined));
    const user = userEvent.setup();
    renderGlobal();
    await openCreate(user);
    await user.click(screen.getByRole('button', { name: 'Create Memory' }));
    expect(await screen.findByText('Content is required.')).toBeInTheDocument();
    expect(mutations()).toHaveLength(0);
    await user.type(screen.getByLabelText('Content'), 'Fresh');
    await user.selectOptions(within(screen.getByRole('form', { name: 'New Memory' })).getByLabelText('Type'), 'decision');
    await user.type(screen.getByLabelText('Tags (optional)'), 'A, b');
    await user.type(screen.getByLabelText('Confidence (optional)'), '0.25');
    await user.click(screen.getByRole('button', { name: 'Create Memory' }));
    expect(await screen.findByText('The Memory was created.')).toBeInTheDocument();
    const post = mutations()[0]!;
    expect(body(post)).toEqual({ type: 'decision', content: 'Fresh', tags: ['a', 'b'], confidence: 0.25 });
    expect(await screen.findByText('Made')).toBeInTheDocument(); // list refreshed
    expect(screen.queryByRole('form', { name: 'New Memory' })).not.toBeInTheDocument();
  });

  it('reports a deduplicated create accurately', async () => {
    server([], (u, i) => (i?.method === 'POST' && u === '/api/global/memories' ? created({}, { deduplicated: true }) : undefined));
    const user = userEvent.setup();
    renderGlobal();
    await openCreate(user);
    await user.type(screen.getByLabelText('Content'), 'Fresh');
    await user.click(screen.getByRole('button', { name: 'Create Memory' }));
    expect(await screen.findByText(/identical active Memory already existed/)).toBeInTheDocument();
    expect(screen.queryByText('The Memory was created.')).not.toBeInTheDocument();
  });

  it('sends one request for a double submit', async () => {
    let release: (r: Response) => void = () => {};
    server([], (u, i) => (i?.method === 'POST' ? (new Promise<Response>((r) => (release = r)) as never) : undefined));
    const user = userEvent.setup();
    renderGlobal();
    await openCreate(user);
    await user.type(screen.getByLabelText('Content'), 'Fresh');
    const submit = screen.getByRole('button', { name: 'Create Memory' });
    await user.click(submit);
    await user.click(screen.getByRole('button', { name: 'Saving…' }));
    fireSubmit();
    expect(mutations()).toHaveLength(1);
    release(created());
    await screen.findByText('The Memory was created.');
  });

  it.each([
    ['server field error', () => json({ message: 'Invalid request', issues: [{ path: 'content', message: 'Content is too long' }] }, 400), 'Content is too long'],
    ['server failure', () => json({}, 500), 'Something went wrong'],
    ['expired session', () => json({}, 401), 'Your session has expired'],
    ['network failure', () => Promise.reject(new Error('down')) as never, 'Could not reach the server'],
  ])('keeps the typed values and explains a %s', async (_n, respond, text) => {
    server([], (u, i) => (i?.method === 'POST' ? respond() : undefined));
    const user = userEvent.setup();
    renderGlobal();
    await openCreate(user);
    await user.type(screen.getByLabelText('Content'), 'Keep me');
    await user.click(screen.getByRole('button', { name: 'Create Memory' }));
    expect((await screen.findAllByText(new RegExp(text))).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Content')).toHaveValue('Keep me');
    expect(screen.getByRole('button', { name: 'Create Memory' })).toBeEnabled();
  });

  it('ignores a create response that arrives after a scope switch', async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/global/workspaces') return Promise.resolve(json([ws('alpha', 'Alpha', 'uuid-1'), ws('beta', 'Beta', 'uuid-2')]));
      if (url.endsWith('/tags')) return Promise.resolve(json([]));
      if (url.includes('/memories?')) return Promise.resolve(page([]));
      if (init?.method === 'POST') return new Promise<Response>((r) => (release = r));
      throw new Error(`Unexpected ${url}`);
    });
    const view = (slug: string) => <WorkspacesProvider><MemoriesView scope={{ kind: 'workspace', slug }} /></WorkspacesProvider>;
    const user = userEvent.setup();
    const { rerender } = render(view('alpha'));
    await openCreate(user);
    await user.type(screen.getByLabelText('Content'), 'Alpha only');
    await user.click(screen.getByRole('button', { name: 'Create Memory' }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0]!.url).toBe('/api/workspaces/uuid-1/memories');
    rerender(view('beta'));
    await screen.findByText('No Memories yet.');
    await act(async () => release(created()));
    expect(screen.queryByText('Memory saved')).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'New Memory' })).not.toBeInTheDocument();
  });

  it('creates a replacement that supersedes the opened Memory', async () => {
    const old = mem();
    server([old], (u, i) => {
      if (u === '/api/global/memories/m1' && !i?.method) return json(old);
      if (u === '/api/global/memories' && i?.method === 'POST') return created();
    });
    const user = userEvent.setup();
    renderGlobal();
    await user.click(await screen.findByRole('button', { name: /open details/ }));
    await user.click(await screen.findByRole('button', { name: 'Create replacement' }));
    await user.type(await screen.findByLabelText('Content'), 'Fresh');
    await user.click(screen.getByRole('button', { name: 'Create Memory' }));
    await screen.findByText('The Memory was created.');
    expect(body(mutations()[0]!).supersedes).toBe('m1');
  });

  it('shows a conflict when the predecessor is no longer active', async () => {
    const old = mem();
    server([old], (u, i) => {
      if (u === '/api/global/memories/m1' && !i?.method) return json(old);
      if (i?.method === 'POST') return json({ message: 'The Memory to supersede is not active' }, 409);
    });
    const user = userEvent.setup();
    renderGlobal();
    await user.click(await screen.findByRole('button', { name: /open details/ }));
    await user.click(await screen.findByRole('button', { name: 'Create replacement' }));
    await user.type(await screen.findByLabelText('Content'), 'Fresh');
    await user.click(screen.getByRole('button', { name: 'Create Memory' }));
    expect(await screen.findByText('The Memory to supersede is not active')).toBeInTheDocument();
  });
});

function fireSubmit() {
  const form = screen.getByRole('form', { name: 'New Memory' });
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('similar Memory hints', () => {
  const hints = [{ id: 'h1', type: 'fact', preview: 'Similar one' }, { id: 'h2', type: 'decision', preview: 'Similar two' }];
  async function createWithHints(handler: (u: string, i?: RequestInit) => Response | Promise<Response> | undefined) {
    server([], (u, i) => (u === '/api/global/memories' && i?.method === 'POST' ? created({}, { hints }) : handler(u, i)));
    const user = userEvent.setup();
    renderGlobal();
    await openCreate(user);
    await user.type(screen.getByLabelText('Content'), 'Fresh');
    await user.click(screen.getByRole('button', { name: 'Create Memory' }));
    await screen.findByText('Similar one');
    return user;
  }

  it('Supersede links the chosen predecessor to the saved Memory; Keep both makes no request', async () => {
    const user = await createWithHints((u, i) => (u === '/api/global/memories/h1/supersede' && i?.method === 'POST' ? json(mem({ id: 'h1', status: 'superseded' })) : undefined));
    const one = screen.getByRole('listitem', { name: 'Similar fact Memory' });
    await user.click(within(one).getByRole('button', { name: /Supersede/ }));
    expect(await within(one).findByText('Superseded by the new Memory.')).toBeInTheDocument();
    const sup = mutations().filter((c) => c.url.endsWith('/supersede'));
    expect(sup).toHaveLength(1);
    expect(body(sup[0]!)).toEqual({ successorId: 'new1' });

    const before = mutations().length;
    const two = screen.getByRole('listitem', { name: 'Similar decision Memory' });
    await user.click(within(two).getByRole('button', { name: 'Keep both' }));
    expect(screen.queryByText('Similar two')).not.toBeInTheDocument();
    expect(mutations()).toHaveLength(before);
  });

  it('shows a 409 and allows retry, and handles a deleted Memory', async () => {
    let conflict = true;
    const user = await createWithHints((u, i) => {
      if (u === '/api/global/memories/h1/supersede') return conflict ? json({ message: 'The Memory to supersede is not active' }, 409) : json(mem());
      if (u === '/api/global/memories/h2/supersede') return json({}, 404);
      return undefined;
    });
    const one = screen.getByRole('listitem', { name: 'Similar fact Memory' });
    await user.click(within(one).getByRole('button', { name: /Supersede/ }));
    expect(await within(one).findByRole('alert')).toHaveTextContent('not active');
    conflict = false;
    await user.click(within(one).getByRole('button', { name: /Supersede/ }));
    await within(one).findByText('Superseded by the new Memory.');
    const two = screen.getByRole('listitem', { name: 'Similar decision Memory' });
    await user.click(within(two).getByRole('button', { name: /Supersede/ }));
    expect(await within(two).findByText(/no longer exists/)).toBeInTheDocument();
  });

  it('reports session and network failures per hint', async () => {
    const user = await createWithHints((u) => (u.endsWith('h1/supersede') ? json({}, 401) : u.endsWith('h2/supersede') ? (Promise.reject(new Error('x')) as never) : undefined));
    await user.click(within(screen.getByRole('listitem', { name: 'Similar fact Memory' })).getByRole('button', { name: /Supersede/ }));
    expect(await screen.findByText(/session has expired/)).toBeInTheDocument();
    await user.click(within(screen.getByRole('listitem', { name: 'Similar decision Memory' })).getByRole('button', { name: /Supersede/ }));
    expect((await screen.findAllByText(/Could not reach the server/)).length).toBeGreaterThan(0);
  });

  it('does not send a second supersede while one is in flight', async () => {
    let release: (r: Response) => void = () => {};
    const user = await createWithHints((u) => (u.endsWith('h1/supersede') ? (new Promise<Response>((r) => (release = r)) as never) : undefined));
    const one = screen.getByRole('listitem', { name: 'Similar fact Memory' });
    await user.click(within(one).getByRole('button', { name: /Supersede/ }));
    expect(within(one).getByRole('button', { name: /Superseding/ })).toBeDisabled();
    expect(mutations().filter((c) => c.url.endsWith('/supersede'))).toHaveLength(1);
    release(json(mem()));
    await within(one).findByText('Superseded by the new Memory.');
  });
});

describe('edit', () => {
  const open = async (m: MemoryDto, put?: (i: RequestInit) => Response | Promise<Response>) => {
    server([m], (u, i) => {
      if (u === '/api/global/memories/m1' && i?.method === 'PUT') return put ? put(i) : json(mem({ ...m, title: null }));
      if (u === '/api/global/memories/m1' && !i?.method) return json(m);
    });
    const user = userEvent.setup();
    renderGlobal();
    await user.click(await screen.findByRole('button', { name: /open details/ }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByRole('form', { name: 'Edit Memory' });
    return user;
  };

  it('prefills, sends a full-replacement PUT with nulls and the existing metadata, and updates the detail', async () => {
    const user = await open(mem());
    expect(screen.getByLabelText('Content')).toHaveValue('The sky is blue');
    await user.clear(screen.getByLabelText('Title (optional)'));
    await user.clear(screen.getByLabelText('Confidence (optional)'));
    await user.clear(screen.getByLabelText('Source (optional)'));
    await user.clear(screen.getByLabelText('Tags (optional)'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Memory saved.')).toBeInTheDocument();
    const put = mutations()[0]!;
    expect(put.url).toBe('/api/global/memories/m1');
    expect(body(put)).toEqual({ type: 'fact', content: 'The sky is blue', title: null, metadata: { keep: { me: true } }, confidence: null, source: null, tags: [] });
  });

  it('turns a 409 into a pointer to the successor and keeps superseded Memories read-only', async () => {
    const m = mem();
    let superseded = false;
    server([m], (u, i) => {
      if (u === '/api/global/memories/m1' && i?.method === 'PUT') return ((superseded = true), json({ message: 'Memory is superseded' }, 409));
      if (u === '/api/global/memories/m1') return json(superseded ? mem({ status: 'superseded', supersededBy: 'm2' }) : m);
    });
    const user = userEvent.setup();
    renderGlobal();
    await user.click(await screen.findByRole('button', { name: /open details/ }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/can no longer be edited/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Open successor' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByText('Superseded Memories cannot be edited.')).toBeInTheDocument();
  });

  it('shows failures and keeps the form open', async () => {
    const user = await open(mem(), () => json({}, 500));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByRole('form', { name: 'Edit Memory' })).toBeInTheDocument();
  });
});

describe('embedding retry and polling', () => {
  it('retries a failed embedding, then polls the pending status until ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let state: MemoryDto['embeddingStatus'] = 'failed';
    server([mem({ embeddingStatus: 'failed' })], (u, i) => {
      if (u === '/api/global/memories/m1/retry-embedding' && i?.method === 'POST') return ((state = 'pending'), json(mem({ embeddingStatus: 'pending' }), 202));
      if (u === '/api/global/memories/m1') return json(mem({ embeddingStatus: state }));
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderGlobal();
    await user.click(await screen.findByRole('button', { name: /open details/ }));
    await user.click(await screen.findByRole('button', { name: 'Retry embedding' }));
    expect(await screen.findByText(/Embedding in progress/)).toBeInTheDocument();
    state = 'ready';
    await act(async () => { await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS + 10); });
    await waitFor(() => expect(screen.queryByText(/Embedding in progress/)).not.toBeInTheDocument());
    expect(screen.getAllByText('Embedding ready').length).toBeGreaterThan(0);
  });

  it('shows a retry failure and allows trying again', async () => {
    let fail = true;
    server([mem({ embeddingStatus: 'failed' })], (u, i) => {
      if (u.endsWith('retry-embedding')) return fail ? json({}, 500) : json(mem({ embeddingStatus: 'ready' }), 202);
      if (u === '/api/global/memories/m1') return json(mem({ embeddingStatus: 'failed' }));
    });
    const user = userEvent.setup();
    renderGlobal();
    await user.click(await screen.findByRole('button', { name: /open details/ }));
    await user.click(await screen.findByRole('button', { name: 'Retry embedding' }));
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry embedding' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry embedding' })).not.toBeInTheDocument());
  });

  it('stops polling on unmount and after the bound', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server([mem({ embeddingStatus: 'pending' })], (u) => (u === '/api/global/memories/m1' ? json(mem({ embeddingStatus: 'pending' })) : undefined));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = renderGlobal();
    await user.click(await screen.findByRole('button', { name: /open details/ }));
    await screen.findByText(/Embedding in progress/);
    const detailGets = () => calls().filter((c) => c.url === '/api/global/memories/m1').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS * 3 + 50); });
    expect(detailGets()).toBeGreaterThan(1);
    unmount();
    const n = detailGets();
    await act(async () => { await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS * 5); });
    expect(detailGets()).toBe(n);
  });

  it('gives up after the maximum number of polls', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server([mem({ embeddingStatus: 'pending' })], (u) => (u === '/api/global/memories/m1' ? json(mem({ embeddingStatus: 'pending' })) : undefined));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderGlobal();
    await user.click(await screen.findByRole('button', { name: /open details/ }));
    await screen.findByText(/Embedding in progress/);
    for (let i = 0; i < 25; i++) await act(async () => { await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS + 10); });
    expect(await screen.findByText(/still pending/)).toBeInTheDocument();
    const n = calls().length;
    await act(async () => { await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS * 10); });
    expect(calls().length).toBe(n);
  });
});

describe('forget', () => {
  async function openForget(handler: (i?: RequestInit) => Response | Promise<Response>) {
    const items = [mem()];
    server(items, (u, i) => {
      if (u === '/api/global/memories/m1' && i?.method === 'DELETE') {
        const r = handler(i);
        return r;
      }
      if (u === '/api/global/memories/m1') return json(mem());
    });
    const user = userEvent.setup();
    renderGlobal();
    await user.click(await screen.findByRole('button', { name: /open details/ }));
    await user.click(await screen.findByRole('button', { name: 'Forget' }));
    return { user, items };
  }

  it('does nothing on cancel', async () => {
    const { user } = await openForget(() => json({}, 204));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(mutations()).toHaveLength(0);
    expect(screen.getByRole('region', { name: 'Sky' })).toBeInTheDocument();
  });

  it('deletes on confirm, closes the detail and refreshes the list', async () => {
    const { user, items } = await openForget(() => ((items_.length = 0), new Response(null, { status: 204 })));
    const items_ = items;
    await user.click(await screen.findByRole('button', { name: 'Forget Memory' }));
    expect(await screen.findByText('Memory forgotten.')).toBeInTheDocument();
    expect(mutations()).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Sky' })).not.toBeInTheDocument();
    expect(await screen.findByText('No Memories yet.')).toBeInTheDocument();
  });

  it('keeps the dialog and data on failure so the user can retry', async () => {
    let fail = true;
    const { user } = await openForget(() => (fail ? json({}, 500) : new Response(null, { status: 204 })));
    await user.click(await screen.findByRole('button', { name: 'Forget Memory' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getAllByText('The sky is blue').length).toBeGreaterThan(0);
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Forget Memory' }));
    expect(await screen.findByText('Memory forgotten.')).toBeInTheDocument();
  });

  it('treats an already forgotten Memory as done, and reports network loss', async () => {
    let mode: 'net' | 'gone' = 'net';
    const { user } = await openForget(() => (mode === 'net' ? (Promise.reject(new Error('x')) as never) : json({}, 404)));
    await user.click(await screen.findByRole('button', { name: 'Forget Memory' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
    mode = 'gone';
    await user.click(screen.getByRole('button', { name: 'Forget Memory' }));
    expect(await screen.findByText('Memory forgotten.')).toBeInTheDocument();
  });

  it('sends one DELETE when confirmed twice quickly', async () => {
    let release: (r: Response) => void = () => {};
    const { user } = await openForget(() => new Promise<Response>((r) => (release = r)) as never);
    const confirm = await screen.findByRole('button', { name: 'Forget Memory' });
    await user.click(confirm);
    await user.click(screen.getByRole('button', { name: 'Working…' }));
    expect(mutations()).toHaveLength(1);
    release(new Response(null, { status: 204 }));
    await screen.findByText('Memory forgotten.');
  });
});
