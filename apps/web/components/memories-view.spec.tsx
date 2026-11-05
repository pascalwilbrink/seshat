// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api-client', () => ({ apiFetch: (p: string, i?: RequestInit) => fetch(p, i), handleUnauthorized: vi.fn() }));

import { MemoriesView } from './memories-view';
import { WorkspacesProvider } from './workspaces-provider';
import { json, ws } from './shell.fixture';
import type { MemoryDto } from '@/lib/api-types';

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

const alpha = ws('alpha', 'Alpha', 'uuid-1');
const beta = ws('beta', 'Beta', 'uuid-2');
const mem = (over: Partial<MemoryDto> = {}): MemoryDto => ({
  id: 'm1',
  scope: 'global',
  workspaceId: null,
  type: 'fact',
  content: 'The sky is blue',
  title: 'Sky',
  metadata: null,
  confidence: null,
  source: null,
  tags: ['nature'],
  status: 'active',
  supersededBy: null,
  provenance: { createdBy: { kind: 'admin', keyId: null, keyName: null }, client: null },
  embeddingStatus: 'ready',
  embeddingModel: 'text-embedding-3-small',
  createdAt: '2026-03-02T10:00:00.000Z',
  updatedAt: '2026-03-03T10:00:00.000Z',
  ...over,
});
const page = (items: MemoryDto[], nextCursor: string | null = null) => json({ items, nextCursor, hasMore: nextCursor !== null, limit: 25 });

type Route = (url: string) => Response | Promise<Response> | undefined;
function routes(...handlers: Route[]) {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/global/workspaces') return Promise.resolve(json([alpha, beta]));
    if (url.endsWith('/tags')) return Promise.resolve(json([{ id: 't1', name: 'nature' }]));
    for (const h of handlers) {
      const r = h(url);
      if (r) return Promise.resolve(r);
    }
    throw new Error(`Unexpected fetch ${url}`);
  });
}
const renderGlobal = () => render(<WorkspacesProvider><MemoriesView scope={{ kind: 'global' }} /></WorkspacesProvider>);
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

describe('MemoriesView', () => {
  it('shows loading, then rows with badge, preview, tags, provenance, embedding and updated time', async () => {
    routes((u) => (u.startsWith('/api/global/memories?') ? page([mem({ provenance: { createdBy: { kind: 'api_key', keyId: 'k', keyName: 'Agent' }, client: { name: 'Claude', version: '1.2' } } })]) : undefined));
    renderGlobal();
    expect(screen.getByText('Loading Memories…')).toBeInTheDocument();
    const row = (await screen.findByText('The sky is blue')).closest('tr')!;
    expect(within(row).getByText('fact')).toBeInTheDocument();
    expect(within(row).getByText('nature')).toBeInTheDocument();
    expect(within(row).getByText('Active')).toBeInTheDocument();
    expect(within(row).getByText('API key Agent via Claude 1.2')).toBeInTheDocument();
    expect(within(row).getByText('Embedding ready')).toBeInTheDocument();
    expect(within(row).getByText('2026-03-03 10:00 UTC')).toBeInTheDocument();
    expect(urls()).toContain('/api/global/memories?status=active');
  });

  it('renders hostile text as text', async () => {
    const evil = '<img src=x onerror=alert(1)><script>boom()</script>';
    routes((u) => (u.startsWith('/api/global/memories?') ? page([mem({ title: evil, content: evil, tags: [evil] })]) : undefined));
    const { container } = renderGlobal();
    await screen.findAllByText(evil, { exact: false });
    expect(container.querySelector('img, script')).toBeNull();
  });

  it('shows the initial empty state and the filtered empty state with a reset', async () => {
    routes((u) => (u.startsWith('/api/global/memories?') ? page([]) : undefined));
    const user = userEvent.setup();
    renderGlobal();
    expect(await screen.findByText('No Memories yet.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Type'), 'decision');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText('No Memories match these filters.')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Clear filters' }).at(-1)!);
    expect(await screen.findByText('No Memories yet.')).toBeInTheDocument();
  });

  it('sends filters to the API and restarts from the first page', async () => {
    routes((u) => {
      if (u === '/api/global/memories?status=active') return page([mem()], 'cur1');
      if (u.startsWith('/api/global/memories?')) return page([mem({ id: 'm9', title: 'Other' })]);
    });
    const user = userEvent.setup();
    renderGlobal();
    await screen.findByText('Sky');
    await user.selectOptions(screen.getByLabelText('Type'), 'decision');
    await user.selectOptions(screen.getByLabelText('Tag'), 'nature');
    await user.selectOptions(screen.getByLabelText('Status'), 'all');
    await user.type(screen.getByLabelText('Text contains'), ' hello ');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await screen.findByText('Other');
    const last = urls().at(-1)!;
    const p = new URL(last, 'http://x').searchParams;
    expect([p.get('type'), p.get('tag'), p.get('status'), p.get('text'), p.get('cursor')]).toEqual(['decision', 'nature', 'all', 'hello', null]);
    expect(screen.queryByText('Sky')).not.toBeInTheDocument();
  });

  it('loads more with the cursor, appends, and offers retry on failure', async () => {
    let fail = true;
    routes((u) => {
      if (u === '/api/global/memories?status=active') return page([mem()], 'cur 1');
      if (u === '/api/global/memories?status=active&cursor=cur+1') {
        if (fail) return json({}, 500);
        return page([mem({ id: 'm2', title: 'Second' })]);
      }
    });
    const user = userEvent.setup();
    renderGlobal();
    await screen.findByText('Sky');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry loading more' }));
    await screen.findByText('Second');
    expect(screen.getByText('Sky')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('shows a request failure with retry', async () => {
    let ok = false;
    routes((u) => (u.startsWith('/api/global/memories?') ? (ok ? page([mem()]) : json({}, 500)) : undefined));
    const user = userEvent.setup();
    renderGlobal();
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    ok = true;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Sky')).toBeInTheDocument();
  });

  it('reports a network failure and an expired session (no retry)', async () => {
    routes((u) => (u.startsWith('/api/global/memories?') ? Promise.reject(new Error('down')) as never : undefined));
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/global/workspaces') return Promise.resolve(json([]));
      if (url.endsWith('/tags')) return Promise.resolve(json([]));
      return Promise.reject(new Error('down'));
    });
    const { unmount } = renderGlobal();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
    unmount();
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.startsWith('/api/global/memories?') ? json({}, 401) : json([])));
    renderGlobal();
    expect(await screen.findByRole('alert')).toHaveTextContent('Your session has expired');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows an unavailable Workspace without requesting Memories', async () => {
    routes();
    render(<WorkspacesProvider><MemoriesView scope={{ kind: 'workspace', slug: 'nope' }} /></WorkspacesProvider>);
    expect(await screen.findByText('Workspace not found')).toBeInTheDocument();
    expect(urls().some((u) => u.includes('/memories'))).toBe(false);
  });

  it('uses the Workspace id in the URL', async () => {
    routes((u) => (u.startsWith('/api/workspaces/uuid-1/memories?') ? page([mem({ title: 'In alpha', scope: 'workspace', workspaceId: 'uuid-1' })]) : undefined));
    render(<WorkspacesProvider><MemoriesView scope={{ kind: 'workspace', slug: 'alpha' }} /></WorkspacesProvider>);
    expect(await screen.findByText('In alpha')).toBeInTheDocument();
  });

  it('never shows the previous scope’s data after a scope switch, and ignores its late response', async () => {
    let releaseAlpha: (r: Response) => void = () => {};
    routes(
      (u) => (u.startsWith('/api/workspaces/uuid-1/memories?') ? (new Promise<Response>((r) => (releaseAlpha = r)) as never) : undefined),
      (u) => (u.startsWith('/api/workspaces/uuid-2/memories?') ? page([mem({ title: 'Beta one' })]) : undefined),
    );
    const view = (slug: string) => (
      <WorkspacesProvider>
        <MemoriesView scope={{ kind: 'workspace', slug }} />
      </WorkspacesProvider>
    );
    const { rerender } = render(view('alpha'));
    await waitFor(() => expect(urls().some((u) => u.startsWith('/api/workspaces/uuid-1/memories'))).toBe(true));
    rerender(view('beta'));
    expect(await screen.findByText('Beta one')).toBeInTheDocument();
    releaseAlpha(page([mem({ title: 'Alpha leak' })]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Alpha leak')).not.toBeInTheDocument();
    expect(screen.getByText('Beta one')).toBeInTheDocument();
  });

  it('drops a stale first-page response when filters change quickly', async () => {
    let releaseOld: (r: Response) => void = () => {};
    routes((u) => {
      if (u === '/api/global/memories?status=active') return page([mem()]);
      if (u === '/api/global/memories?type=fact&status=active') return new Promise<Response>((r) => (releaseOld = r)) as never;
      if (u === '/api/global/memories?type=decision&status=active') return page([mem({ id: 'm5', title: 'Fresh' })]);
    });
    const user = userEvent.setup();
    renderGlobal();
    await screen.findByText('Sky');
    await user.selectOptions(screen.getByLabelText('Type'), 'fact');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await user.selectOptions(screen.getByLabelText('Type'), 'decision');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await screen.findByText('Fresh');
    releaseOld(page([mem({ id: 'm6', title: 'Stale' })]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
  });
});

describe('Memory detail', () => {
  const open = async (items: MemoryDto[], extra: Route) => {
    routes((u) => (u.startsWith('/api/global/memories?') ? page(items) : undefined), extra);
    const user = userEvent.setup();
    renderGlobal();
    await user.click(await screen.findByRole('button', { name: /open details/ }));
    return user;
  };

  it('shows full escaped text, metadata and provenance', async () => {
    const full = mem({ content: `<b>bold</b>\n${'x'.repeat(300)}`, metadata: { k: '<i>v</i>' }, source: 'doc', confidence: 0.5, provenance: { createdBy: { kind: 'admin', keyId: null, keyName: null }, client: null } });
    await open([full], (u) => (u === '/api/global/memories/m1' ? json(full) : undefined));
    const detail = await screen.findByRole('region', { name: 'Sky' });
    expect(within(detail).getByText(/<b>bold<\/b>/)).toBeInTheDocument();
    expect(detail.querySelector('b, i')).toBeNull();
    expect(within(detail).getByText('Admin')).toBeInTheDocument();
    expect(within(detail).getByText('doc')).toBeInTheDocument();
  });

  it('navigates to the same-scope successor of a superseded Memory', async () => {
    const old = mem({ status: 'superseded', supersededBy: 'm2' });
    const next = mem({ id: 'm2', title: 'Newer' });
    const user = await open([old], (u) => (u === '/api/global/memories/m1' ? json(old) : u === '/api/global/memories/m2' ? json(next) : undefined));
    await user.click(await screen.findByRole('button', { name: 'Open successor' }));
    expect(await screen.findByRole('region', { name: 'Newer' })).toBeInTheDocument();
    expect(urls()).toContain('/api/global/memories/m2');
  });

  it('handles a cleared successor link and a missing successor', async () => {
    const cleared = mem({ status: 'superseded', supersededBy: null });
    await open([cleared], (u) => (u === '/api/global/memories/m1' ? json(cleared) : undefined));
    expect(await screen.findByText(/successor was forgotten/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open successor' })).not.toBeInTheDocument();
  });

  it('says so when the successor no longer exists', async () => {
    const old = mem({ status: 'superseded', supersededBy: 'gone' });
    const user = await open([old], (u) => (u === '/api/global/memories/m1' ? json(old) : u === '/api/global/memories/gone' ? json({}, 404) : undefined));
    await user.click(await screen.findByRole('button', { name: 'Open successor' }));
    expect(await screen.findByText('This Memory no longer exists.')).toBeInTheDocument();
  });

  it('shows a failed load with retry', async () => {
    let ok = false;
    const m = mem();
    const user = await open([m], (u) => (u === '/api/global/memories/m1' ? (ok ? json(m) : json({}, 500)) : undefined));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    ok = true;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Content')).toBeInTheDocument();
  });
});
