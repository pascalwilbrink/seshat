// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api-client', () => ({ apiFetch: (p: string, i?: RequestInit) => fetch(p, i), handleUnauthorized: vi.fn() }));

import { ResourceUsage } from './resource-usage';
import { usageFixture } from './resource-usage.fixture';
import { json } from './shell.fixture';

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const populated = () =>
  usageFixture(
    {
      lifetime: { total: 1234, byChannel: { ui: 4, api: 30, mcp: 1200 }, byKind: { read: 34, retrieved: 1200 } },
      lastAccessedAt: '2026-11-06T09:00:00.000Z',
    },
    7,
  );

describe('ResourceUsage', () => {
  it('shows loading, then lifetime total, last access, channel/kind totals and a 30-day sparkline', async () => {
    fetchMock.mockResolvedValue(json(populated()));
    render(<ResourceUsage base="/api/global/files" id="f1" />);
    expect(screen.getByRole('status', { name: 'Loading usage' })).toBeInTheDocument();
    expect(await screen.findByText('1,234')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/global/files/f1/usage?days=30');
    const dl = screen.getByText('Accesses (lifetime)').closest('dl')!;
    expect(within(dl).getByText('MCP (lifetime)').nextSibling).toHaveTextContent('1,200');
    expect(within(dl).getByText('Retrieved (lifetime)').nextSibling).toHaveTextContent('1,200');
    expect(within(dl).getByText('API (lifetime)').nextSibling).toHaveTextContent('30');
    const time = screen.getByText('Last accessed').nextElementSibling!.querySelector('time')!;
    expect(time).toHaveAttribute('datetime', '2026-11-06T09:00:00.000Z');
    expect(time).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('figure', { name: 'Accesses, last 30 days' })).toBeInTheDocument();
    expect(screen.getByText(/7 accesses over 30 days/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /table/i }));
    expect(screen.getAllByRole('row')).toHaveLength(31);
  });

  it('shows zero totals, Never and an empty sparkline for a never-accessed resource', async () => {
    fetchMock.mockResolvedValue(json(usageFixture()));
    render(<ResourceUsage base="/api/global/files" id="f1" />);
    expect(await screen.findByText('Never')).toBeInTheDocument();
    expect(screen.getByText('Accesses (lifetime)').nextSibling).toHaveTextContent('0');
    expect(screen.getByText('No accesses in the last 30 days')).toBeInTheDocument();
  });

  it('shows an error with retry that reloads only the usage', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'x' }, 500)).mockResolvedValueOnce(json(populated()));
    render(<ResourceUsage base="/api/workspaces/w1/memories" id="m1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Usage could not be loaded.');
    await userEvent.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(await screen.findByText('1,234')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says so for a deleted or unknown resource', async () => {
    fetchMock.mockResolvedValue(json({ message: 'nf' }, 404));
    render(<ResourceUsage base="/api/global/files" id="gone" />);
    expect(await screen.findByText(/no longer exists/)).toBeInTheDocument();
  });

  it('cancels the old request and never shows stale data when the resource or scope changes', async () => {
    const signals: AbortSignal[] = [];
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce((_u: string, init?: RequestInit) => {
      signals.push(init!.signal!);
      return new Promise<Response>((resolve) => (release = resolve));
    });
    fetchMock.mockResolvedValueOnce(json(usageFixture({ id: 'f2' }, 3)));
    const { rerender } = render(<ResourceUsage base="/api/global/files" id="f1" />);
    rerender(<ResourceUsage base="/api/workspaces/w1/files" id="f2" />);
    expect(signals[0]!.aborted).toBe(true);
    expect(await screen.findByText(/3 accesses over 30 days/)).toBeInTheDocument();
    release(json(populated()));
    await waitFor(() => expect(screen.queryByText('1,234')).not.toBeInTheDocument());
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/workspaces/w1/files/f2/usage?days=30');
  });
});
