// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsageDashboard } from './usage-dashboard';
import { json } from './shell.fixture';
import { emptyUsage, FILE_A, MEM_A, sampleUsage } from './usage-dashboard.fixture';

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});
const urls = () => fetchMock.mock.calls.map((c) => c[0]);
const stat = (label: string) => screen.getByText(label).closest('div')!.parentElement!;

describe('UsageDashboard in a Workspace', () => {
  const ws = { kind: 'workspace' as const, slug: 'alpha' };
  it('defaults to 30 days and shows every stat label and value', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(sampleUsage('workspace'))));
    render(<UsageDashboard scope={ws} base="/api/workspaces/uuid-1" />);
    expect(screen.getByText('Loading usage…')).toBeInTheDocument();
    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(urls()).toEqual(['/api/workspaces/uuid-1/usage/overview?days=30']);
    expect(screen.getByRole('radio', { name: 'Last 30 days' })).toBeChecked();
    expect(stat('Files')).toHaveTextContent('10 indexed · 2 failed');
    expect(stat('Memories')).toHaveTextContent('7');
    expect(stat('Memories')).toHaveTextContent('5 active · 2 superseded');
    expect(stat('MCP calls')).toHaveTextContent('10');
    expect(stat('MCP error rate')).toHaveTextContent('20%');
    expect(stat('MCP error rate')).toHaveTextContent('2 of 10 calls failed');
    expect(stat('Unused Files')).toHaveTextContent('4');
    expect(stat('Unused Memories')).toHaveTextContent('3');
  });

  it('shows every chart with title, summary and the exact data table', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(sampleUsage('workspace'))));
    render(<UsageDashboard scope={ws} base="/api/workspaces/uuid-1" />);
    await screen.findByText('12');
    const acc = screen.getByRole('region', { name: 'Accesses per day' });
    expect(acc).toHaveAccessibleDescription(/8 accesses across 30 points: UI 2, API 4, MCP 2\./);
    await userEvent.click(within(acc).getByRole('button', { name: 'Show data table' }));
    const rows = within(within(acc).getByRole('table')).getAllByRole('row');
    expect(rows[0]).toHaveTextContent('DateUIAPIMCP');
    expect(rows[rows.length - 1]).toHaveTextContent(/2026-11-06\s*0\s*3\s*0/);
    const calls = screen.getByRole('region', { name: 'MCP calls per day' });
    expect(calls).toHaveAccessibleDescription(/10 calls across 30 points: Succeeded 8, Invalid arguments 1, Forbidden 0, Not found 0, Unknown tool 0, Internal error 1\./);
    const tools = screen.getByRole('region', { name: 'Top tools' });
    expect(tools).toHaveAccessibleDescription(/10 calls across 2 items\. Highest: recall with 6\./);
    expect(screen.queryByRole('region', { name: 'MCP calls per Workspace' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /call history/i })).not.toBeInTheDocument();
  });

  it('links resources in their own scope using their ids', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(sampleUsage('workspace'))));
    render(<UsageDashboard scope={ws} base="/api/workspaces/uuid-1" />);
    expect(await screen.findByRole('link', { name: `File ${FILE_A}` })).toHaveAttribute('href', `/w/alpha/files?file=${FILE_A}`);
    expect(screen.getByRole('link', { name: `Memory ${MEM_A}` })).toHaveAttribute('href', `/w/alpha/memories?memory=${MEM_A}`);
    expect(screen.getByRole('link', { name: `File ${FILE_A}` })).toHaveTextContent('File 11111111');
  });

  it.each([7, 90] as const)('requests %i days when selected', async (days) => {
    fetchMock.mockImplementation((u: string) => Promise.resolve(json(u.endsWith('days=30') ? sampleUsage('workspace') : emptyUsage('workspace', days))));
    render(<UsageDashboard scope={ws} base="/api/workspaces/uuid-1" />);
    await screen.findByText('12');
    await userEvent.click(screen.getByRole('radio', { name: `Last ${days} days` }));
    await waitFor(() => expect(urls()).toContain(`/api/workspaces/uuid-1/usage/overview?days=${days}`));
    expect(screen.getByRole('radio', { name: `Last ${days} days` })).toBeChecked();
    expect(await screen.findByRole('region', { name: 'Accesses per day' })).toHaveTextContent(/No accesses in this period/);
    expect(screen.getByRole('group', { name: 'Time window' })).toBeInTheDocument();
  });

  it('ignores a stale response that arrives after the window changed', async () => {
    const pending: Record<string, (r: Response) => void> = {};
    fetchMock.mockImplementation((u: string) => new Promise((res) => (pending[u] = res)));
    render(<UsageDashboard scope={ws} base="/api/workspaces/uuid-1" />);
    await userEvent.click(screen.getByRole('radio', { name: 'Last 7 days' }));
    pending['/api/workspaces/uuid-1/usage/overview?days=7']!(json(emptyUsage('workspace', 7)));
    await waitFor(() => expect(stat('Files')).toHaveTextContent('0'));
    pending['/api/workspaces/uuid-1/usage/overview?days=30']!(json(sampleUsage('workspace')));
    await new Promise((r) => setTimeout(r, 20));
    expect(stat('Files')).toHaveTextContent('0');
    expect(screen.getByRole('radio', { name: 'Last 7 days' })).toBeChecked();
  });

  it('renders zero data as zeros and empty chart states', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(emptyUsage('workspace'))));
    render(<UsageDashboard scope={ws} base="/api/workspaces/uuid-1" />);
    await waitFor(() => expect(stat('MCP error rate')).toHaveTextContent('0%'));
    expect(stat('Unused Files')).toHaveTextContent('0');
    for (const name of ['Accesses per day', 'MCP calls per day', 'Top tools', 'Most accessed Files', 'Most accessed Memories']) {
      expect(screen.getByRole('region', { name })).toHaveTextContent(/No (accesses|calls|data|activity)/i);
    }
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows a loading state with no numbers, then an error that retries', async () => {
    let fail = true;
    fetchMock.mockImplementation(() => Promise.resolve(fail ? json({}, 500) : json(sampleUsage('workspace'))));
    render(<UsageDashboard scope={ws} base="/api/workspaces/uuid-1" />);
    expect(screen.getByRole('region', { name: 'Usage' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByRole('status').length).toBeGreaterThan(1);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load usage');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('12')).toBeInTheDocument();
  });
});

describe('UsageDashboard in Global', () => {
  const g = { kind: 'global' as const };
  it('adds calls per Workspace and the cross-Workspace history link, with Global resource links', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(sampleUsage('global'))));
    render(<UsageDashboard scope={g} base="/api/global" />);
    expect(await screen.findByRole('link', { name: `File ${FILE_A}` })).toHaveAttribute('href', `/global/files?file=${FILE_A}`);
    expect(screen.getByRole('link', { name: `Memory ${MEM_A}` })).toHaveAttribute('href', `/global/memories?memory=${MEM_A}`);
    expect(screen.getByRole('link', { name: 'View MCP call history across all Workspaces' })).toHaveAttribute('href', '/global/mcp-history');
    expect(screen.getByRole('region', { name: 'MCP calls per Workspace' })).toHaveAccessibleDescription(/10 calls across 1 item\. Highest: Alpha with 10\./);
    expect(urls()).toEqual(['/api/global/usage/overview?days=30']);
  });
});
