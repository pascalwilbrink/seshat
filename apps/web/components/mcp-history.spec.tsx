// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api-client', () => ({ apiFetch: (p: string, i?: RequestInit) => fetch(p, i) }));

import { McpHistory } from './mcp-history';
import { McpHistoryView } from './mcp-history-view';
import { json, ws } from './shell.fixture';
import type { McpCallDetailDto, McpCallDto } from '@/lib/api-types';

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

const alpha = ws('alpha', 'Alpha', 'uuid-1');
const beta = { id: 'uuid-2', slug: 'beta', name: 'Beta' };
const KEY_ID = '11111111-1111-4111-8111-111111111111';
const call = (id: string, over: Partial<McpCallDto> = {}): McpCallDto => ({
  id,
  occurredAt: '2026-03-02T10:00:00.000Z',
  keyId: KEY_ID,
  keyName: 'Agent key',
  clientName: 'claude-code',
  clientVersion: '1.2',
  tool: 'recall',
  outcome: 'ok',
  durationMs: 1234,
  resultChars: 5600,
  truncated: false,
  ...over,
});
const page = (items: McpCallDto[], nextCursor: string | null = null) => json({ scope: 'workspace', workspaceId: 'uuid-1', items, nextCursor, hasMore: nextCursor !== null, limit: 25 });
const detail = (over: Partial<McpCallDetailDto> = {}): McpCallDetailDto => ({
  ...call('c1'),
  workspace: { id: 'uuid-1', slug: 'alpha', name: 'Alpha' },
  argsSummary: { limit: 5 },
  resources: [],
  ...over,
});
const urls = () => fetchMock.mock.calls.map((c) => c[0] as string);
const wsScope = { kind: 'workspace' as const, workspace: alpha };
const LIST = '/api/workspaces/uuid-1/mcp-calls';

function route(handlers: Record<string, () => Response | Promise<Response>>) {
  fetchMock.mockImplementation((url: string) => {
    const key = Object.keys(handlers).find((k) => url.startsWith(k));
    if (!key) throw new Error(`Unexpected fetch ${url}`);
    return Promise.resolve(handlers[key]!());
  });
}
const keysResp = () =>
  json([
    { id: KEY_ID, name: 'Agent key', prefix: 'p', permissions: [], createdAt: '', lastUsedAt: null, expiresAt: null, revokedAt: null, status: 'active' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Old key', prefix: 'q', permissions: [], createdAt: '', lastUsedAt: null, expiresAt: null, revokedAt: 'x', status: 'revoked' },
  ]);

describe('McpHistory (Workspace)', () => {
  it('shows every column, loading state and the key-name snapshot of a revoked key', async () => {
    route({ [LIST]: () => page([call('c1', { keyName: 'Old key', truncated: true, clientName: null, clientVersion: null })]), '/api/workspaces/uuid-1/api-keys': keysResp });
    render(<McpHistory scope={wsScope} />);
    expect(screen.getByText('Loading call history')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'MCP call history' });
    for (const h of ['Time', 'Tool', 'Key', 'Client', 'Outcome', 'Duration', 'Result size']) expect(within(table).getByRole('columnheader', { name: h })).toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: 'Workspace' })).toBeNull();
    const row = within(table).getAllByRole('row')[1]!;
    expect(row).toHaveTextContent('recall');
    expect(row).toHaveTextContent('Old key');
    expect(row).toHaveTextContent('Unknown');
    expect(row).toHaveTextContent('Succeeded');
    expect(row).toHaveTextContent('1,234 ms');
    expect(row).toHaveTextContent('5,600 chars');
    expect(row).toHaveTextContent('Truncated');
    expect(urls().find((u) => u.startsWith(LIST))).toBe(`${LIST}?limit=25`);
    expect(await screen.findByRole('option', { name: 'Old key (revoked)' })).toBeInTheDocument();
  });

  it('paginates with a stable cursor and keeps rows on a load-more failure', async () => {
    const user = userEvent.setup();
    let more = 0;
    route({
      [`${LIST}?limit=25&cursor=CUR1`]: () => (more++ === 0 ? json({}, 500) : page([call('c3', { tool: 'remember' })])),
      [LIST]: () => page([call('c1'), call('c2')], 'CUR1'),
      '/api/workspaces/uuid-1/api-keys': keysResp,
    });
    render(<McpHistory scope={wsScope} />);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Could not load more calls. Try again.')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(4));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(urls().filter((u) => u.includes('cursor=CUR1'))).toHaveLength(2);
  });

  it('applies filters, drops the cursor, and resets', async () => {
    const user = userEvent.setup();
    route({ [LIST]: () => page([call('c1')], 'CUR1'), '/api/workspaces/uuid-1/api-keys': keysResp });
    render(<McpHistory scope={wsScope} />);
    await screen.findByRole('table');
    await screen.findByRole('option', { name: 'Old key (revoked)' });
    await user.selectOptions(screen.getByLabelText('Tool'), 'forget');
    await user.selectOptions(screen.getByLabelText('Key'), KEY_ID);
    await user.selectOptions(screen.getByLabelText('Outcome'), 'forbidden');
    await user.type(screen.getByLabelText('Client'), 'gilde');
    await user.type(screen.getByLabelText('From (UTC)'), '2026-03-01');
    await user.type(screen.getByLabelText('To (UTC)'), '2026-03-05');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(urls().at(-1)).toBe(`${LIST}?limit=25&tool=forget&keyId=${KEY_ID}&outcome=forbidden&clientName=gilde&from=2026-03-01&to=2026-03-05`));
    expect(urls().at(-1)).not.toContain('cursor');
    await user.click(screen.getAllByRole('button', { name: 'Reset filters' })[0]!);
    await waitFor(() => expect(urls().at(-1)).toBe(`${LIST}?limit=25`));
  });

  it('rejects an inverted date range without fetching', async () => {
    const user = userEvent.setup();
    route({ [LIST]: () => page([call('c1')]), '/api/workspaces/uuid-1/api-keys': keysResp });
    render(<McpHistory scope={wsScope} />);
    await screen.findByRole('table');
    const before = urls().length;
    await user.type(screen.getByLabelText('From (UTC)'), '2026-03-05');
    await user.type(screen.getByLabelText('To (UTC)'), '2026-03-01');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(screen.getByRole('alert')).toHaveTextContent('start date');
    expect(urls()).toHaveLength(before);
  });

  it('ignores a stale response that arrives after a newer filter result', async () => {
    const user = userEvent.setup();
    let release!: (r: Response) => void;
    const slow = new Promise<Response>((r) => (release = r));
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api-keys')) return Promise.resolve(keysResp());
      if (url.includes('outcome=forbidden')) return Promise.resolve(page([call('fresh', { tool: 'forget' })]));
      if (url === `${LIST}?limit=25`) return fetchMock.mock.calls.filter((c) => c[0] === url).length === 1 ? Promise.resolve(page([call('first')])) : slow;
      return Promise.reject(new Error(url));
    });
    render(<McpHistory scope={wsScope} />);
    await screen.findByRole('table');
    await user.selectOptions(screen.getByLabelText('Outcome'), 'forbidden');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByRole('cell', { name: 'forget' })).toBeInTheDocument();
    release(page([call('stale', { tool: 'upload_file' })]));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole('cell', { name: 'upload_file' })).toBeNull();
  });

  it('shows empty, filtered-empty, error and retry states', async () => {
    const user = userEvent.setup();
    let fail = true;
    route({
      [`${LIST}?limit=25&outcome=forbidden`]: () => page([]),
      [LIST]: () => (fail ? json({}, 500) : page([])),
      '/api/workspaces/uuid-1/api-keys': keysResp,
    });
    render(<McpHistory scope={wsScope} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The call history could not be loaded.');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No MCP calls yet')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Outcome'), 'forbidden');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText('No calls match these filters')).toBeInTheDocument();
  });

  it('opens a keyboard-reachable detail sheet with scope-correct links and Deleted resources', async () => {
    const user = userEvent.setup();
    const FILE = 'f1';
    route({
      [`${LIST}/c1`]: () =>
        json(
          detail({
            argsSummary: { limit: 5, types: ['files'] },
            truncated: true,
            resources: [
              { kind: 'file', id: FILE, action: 'retrieved', scope: 'workspace', workspaceId: 'uuid-1', deleted: false },
              { kind: 'memory', id: 'm-global', action: 'retrieved', scope: 'global', workspaceId: null, deleted: false },
              { kind: 'file', id: 'gone', action: 'read', scope: 'workspace', workspaceId: 'uuid-1', deleted: true },
            ],
          }),
        ),
      [LIST]: () => page([call('c1')]),
      '/api/workspaces/uuid-1/api-keys': keysResp,
    });
    render(<McpHistory scope={wsScope} />);
    const opener = await screen.findByRole('button', { name: 'Open details for recall call' });
    opener.focus();
    await user.keyboard('{Enter}');
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('Argument summary')).toBeInTheDocument();
    expect(sheet).toHaveTextContent('limit');
    expect(sheet).toHaveTextContent('Yes, the result was cut');
    expect(within(sheet).getByRole('link', { name: `File ${FILE}` })).toHaveAttribute('href', `/w/alpha/files?file=${FILE}`);
    expect(within(sheet).getByRole('link', { name: 'Memory m-global' })).toHaveAttribute('href', '/global/memories?memory=m-global');
    expect(within(sheet).queryByRole('link', { name: /gone/ })).toBeNull();
    expect(within(sheet).getByText(/Deleted/)).toHaveTextContent('Deleted gone');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(opener).toHaveFocus();
  });

  it('shows a detail error with retry', async () => {
    const user = userEvent.setup();
    let fail = true;
    route({ [`${LIST}/c1`]: () => (fail ? json({}, 404) : json(detail())), [LIST]: () => page([call('c1')]), '/api/workspaces/uuid-1/api-keys': keysResp });
    render(<McpHistory scope={wsScope} />);
    await user.click(await screen.findByRole('button', { name: 'Open details for recall call' }));
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('This call is no longer available.')).toBeInTheDocument();
    fail = false;
    await user.click(within(sheet).getByRole('button', { name: 'Try again' }));
    expect(await within(sheet).findByText('Argument summary')).toBeInTheDocument();
  });
});

describe('McpHistoryView (Global)', () => {
  it('lists cross-Workspace calls with a Workspace column and loads details from the Global route', async () => {
    const user = userEvent.setup();
    route({
      '/api/global/mcp-calls/c9': () => json(detail({ id: 'c9', workspace: beta, resources: [{ kind: 'file', id: 'fb', action: 'read', scope: 'workspace', workspaceId: 'uuid-2', deleted: false }] })),
      '/api/global/mcp-calls': () =>
        json({ scope: 'global', workspaceId: null, items: [call('c9', { workspace: beta }), call('c8', { workspace: { id: 'uuid-1', slug: 'alpha', name: 'Alpha' } })], nextCursor: null, hasMore: false, limit: 25 }),
    });
    render(<McpHistoryView />);
    expect(screen.getByRole('heading', { name: 'MCP call history' })).toBeInTheDocument();
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Workspace' })).toBeInTheDocument();
    expect(within(table).getByText('Beta')).toBeInTheDocument();
    expect(within(table).getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByLabelText('Key ID')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Open details for recall call' })[0]!);
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByRole('link', { name: 'File fb' })).toHaveAttribute('href', '/w/beta/files?file=fb');
  });

  it('validates the key id and shows an empty state', async () => {
    const user = userEvent.setup();
    route({ '/api/global/mcp-calls': () => json({ scope: 'global', workspaceId: null, items: [], nextCursor: null, hasMore: false, limit: 25 }) });
    render(<McpHistoryView />);
    expect(await screen.findByText('No MCP calls yet')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Key ID'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Key ID must be a UUID.');
    expect(urls()).toHaveLength(1);
  });
});
