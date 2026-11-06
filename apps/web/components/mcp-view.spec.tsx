// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MCP_TOOL_CATALOG, catalogToolsFor, type Permission } from '@seshat/domain';

vi.mock('@/lib/api-client', () => ({ apiFetch: (p: string, i?: RequestInit) => fetch(p, i) }));

import { McpView } from './mcp-view';
import { WorkspacesProvider } from './workspaces-provider';
import { json, ws } from './shell.fixture';
import type { ApiKeyDto } from '@/lib/api-types';
import { DEFAULT_MCP_URL, resolveMcpEndpoint, toolsForPermissions } from '@/lib/mcp-config';

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockReset();
});

const alpha = ws('alpha', 'Alpha', 'uuid-1');
const KEYS = '/api/workspaces/uuid-1/api-keys';

const key = (id: string, name: string, permissions: Permission[], over: Partial<ApiKeyDto> = {}): ApiKeyDto => ({
  id,
  name,
  prefix: 'skp_abcd',
  permissions,
  createdAt: '2026-03-02T10:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  status: 'active',
  ...over,
});

const KEY_LIST = [
  key('ro', 'Reader', ['files:read', 'collections:read', 'memories:read', 'search']),
  key('rw', 'Writer', ['files:read', 'files:write', 'files:delete', 'memories:read', 'memories:write', 'memories:delete', 'search']),
  key('gl', 'Global reader', ['files:read', 'search', 'global:read']),
  key('none', 'Nothing', ['global:read']),
  key('rev', 'Old key', ['files:read'], { status: 'revoked', revokedAt: '2026-03-03T10:00:00.000Z' }),
  key('exp', 'Lapsed key', ['files:read'], { status: 'expired', expiresAt: '2026-03-03T10:00:00.000Z' }),
];

function setup(keysResponse: () => Response | Promise<Response> = () => json(KEY_LIST)) {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/global/workspaces') return Promise.resolve(json([alpha]));
    if (url === KEYS) return Promise.resolve(keysResponse());
    throw new Error(`Unexpected fetch ${url}`);
  });
  return render(
    <WorkspacesProvider>
      <McpView slug="alpha" />
    </WorkspacesProvider>,
  );
}

const toolNames = () => within(screen.getByRole('list', { name: /^Tools for/ })).getAllByRole('listitem').map((li) => within(li).getByText((_, el) => el?.tagName === 'CODE').textContent);

describe('McpView endpoint and configuration', () => {
  it('shows the default endpoint as a copy field with the API-port hint', async () => {
    setup();
    expect(await screen.findByLabelText('MCP endpoint')).toHaveTextContent(DEFAULT_MCP_URL);
    expect(screen.getByRole('button', { name: 'Copy mcp endpoint' })).toBeInTheDocument();
    expect(screen.getByText(/connect to the API port directly/i)).toBeInTheDocument();
  });

  it('uses only a placeholder key in the Gilde and Claude Code snippets', async () => {
    setup();
    const user = userEvent.setup();
    const gilde = await screen.findByLabelText('Gilde project MCP server configuration');
    expect(gilde).toHaveTextContent('Bearer <YOUR_SESHAT_API_KEY>');
    expect(gilde).toHaveTextContent(DEFAULT_MCP_URL);
    await user.click(screen.getByRole('tab', { name: 'Claude Code' }));
    const cc = screen.getByLabelText('Claude Code .mcp.json configuration');
    expect(JSON.parse(cc.textContent ?? '')).toEqual({
      mcpServers: { seshat: { type: 'http', url: DEFAULT_MCP_URL, headers: { Authorization: 'Bearer <YOUR_SESHAT_API_KEY>' } } },
    });
    for (const text of [gilde.textContent, cc.textContent]) expect(text).not.toMatch(/sk_seshat|skp_/);
    expect(screen.getByRole('button', { name: /copy claude code/i })).toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys', async () => {
    setup();
    const user = userEvent.setup();
    const first = await screen.findByRole('tab', { name: 'Gilde' });
    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Claude Code' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('resolveMcpEndpoint', () => {
  it('defaults when unset and normalizes valid URLs', () => {
    expect(resolveMcpEndpoint(undefined)).toEqual({ url: DEFAULT_MCP_URL, invalid: false });
    expect(resolveMcpEndpoint('  ')).toEqual({ url: DEFAULT_MCP_URL, invalid: false });
    expect(resolveMcpEndpoint('https://seshat.example.com/mcp/')).toEqual({ url: 'https://seshat.example.com/mcp', invalid: false });
  });
  it('rejects non-http(s), credentials, query and garbage', () => {
    for (const bad of ['ftp://x/mcp', 'javascript:alert(1)', 'https://u:p@x/mcp', 'https://x/mcp?token=1', 'not a url', 'https://x/mcp#a']) {
      expect(resolveMcpEndpoint(bad)).toEqual({ url: DEFAULT_MCP_URL, invalid: true });
    }
  });
});

describe('McpView tool preview', () => {
  it('lists exactly the catalog tools for a read-only key, all marked read-only', async () => {
    setup();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('API key'), 'ro');
    const names = toolNames();
    expect(names).toEqual(catalogToolsFor(['files:read', 'collections:read', 'memories:read', 'search']));
    expect(names).not.toContain('upload_file');
    const list = screen.getByRole('list', { name: 'Tools for Reader' });
    expect(within(list).queryByText('Writing')).toBeNull();
    expect(within(list).queryByText('Destructive')).toBeNull();
    expect(within(list).getAllByText('Read-only')).toHaveLength(names.length);
  });

  it('lists read, writing and destructive tools for a read-and-write key', async () => {
    setup();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('API key'), 'rw');
    const names = toolNames();
    expect(names).toEqual(catalogToolsFor(['files:read', 'files:write', 'files:delete', 'memories:read', 'memories:write', 'memories:delete', 'search']));
    const row = (n: string) => screen.getByText(n).closest('li')!;
    expect(within(row('upload_file')).getByText('Writing')).toBeInTheDocument();
    expect(within(row('delete_file')).getByText('Destructive')).toBeInTheDocument();
    expect(within(row('forget')).getByText('Destructive')).toBeInTheDocument();
    expect(within(row('recall')).getByText('Read-only')).toBeInTheDocument();
    expect(within(row('forget')).getByText('memories:delete')).toBeInTheDocument();
    expect(within(row('search_knowledge')).getByText(/search \+ files:read or memories:read/)).toBeInTheDocument();
    expect(names).toContain('remember');
  });

  it('marks read tools as reaching Global only for a Global-grant key', async () => {
    setup();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('API key'), 'gl');
    expect(screen.getByText(/can also reach Global/)).toBeInTheDocument();
    const row = (n: string) => screen.getByText(n).closest('li')!;
    expect(within(row('list_files')).getByText('Global')).toBeInTheDocument();
    expect(toolNames()).toEqual(catalogToolsFor(['files:read', 'search', 'global:read']));
    await user.selectOptions(screen.getByLabelText('API key'), 'ro');
    expect(screen.queryByText('Global')).toBeNull();
  });

  it('never lets global:read alone grant tools, and shows an empty state linking to API Keys', async () => {
    expect(toolsForPermissions(['global:read'])).toEqual([]);
    setup();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('API key'), 'none');
    expect(screen.getByText('This key gets no tools')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to API Keys' })).toHaveAttribute('href', '/w/alpha/api-keys');
  });

  it('shows revoked and expired keys as such, without tools', async () => {
    setup();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('API key'), 'rev');
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /^Tools for/ })).toBeNull();
    await user.selectOptions(screen.getByLabelText('API key'), 'exp');
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /^Tools for/ })).toBeNull();
  });

  it('shows an empty state when the Workspace has no keys', async () => {
    setup(() => json([]));
    expect(await screen.findByText('No API keys yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to API Keys' })).toHaveAttribute('href', '/w/alpha/api-keys');
  });

  it('shows a loading state, then an error with retry that recovers', async () => {
    let fail = true;
    setup(() => (fail ? json({ message: 'boom' }, 500) : json(KEY_LIST)));
    const user = userEvent.setup();
    expect(await screen.findByText("Couldn't load API keys")).toBeInTheDocument();
    expect(screen.queryByText('boom')).toBeNull();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByLabelText('API key')).toBeInTheDocument());
  });

  it('catalog drives the list: every catalog tool appears for a key holding every permission', () => {
    const all: Permission[] = ['files:read', 'files:write', 'files:delete', 'collections:read', 'collections:write', 'memories:read', 'memories:write', 'memories:delete', 'search'];
    expect(toolsForPermissions(all).map((t) => t.name)).toEqual(Object.keys(MCP_TOOL_CATALOG));
  });
});
