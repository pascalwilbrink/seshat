// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { resolveSeries, SERIES_TOKENS, summarizeSeries } from '@/lib/chart';
import { BarListChart, Sparkline, TimeSeriesChart } from './usage-charts';

const data = [
  { day: '2026-11-01', ui: 2, api: 0, mcp: 5 },
  { day: '2026-11-02', ui: 1, api: 3, mcp: 0 },
];
const series = [
  { key: 'ui', label: 'UI' },
  { key: 'api', label: 'API' },
  { key: 'mcp', label: 'MCP' },
];

describe('TimeSeriesChart', () => {
  it('exposes a title, a text summary and a toggled data table with matching values', async () => {
    render(<TimeSeriesChart title="Accesses per day" kind="stacked" data={data} xKey="day" series={series} unit="accesses" />);
    const region = screen.getByRole('region', { name: 'Accesses per day' });
    expect(region).toHaveAccessibleDescription(/11 accesses across 2 points: UI 3, API 3, MCP 5\. Highest: 2026-11-01 with 7\./);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Show data table' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.setup().click(toggle);
    expect(screen.getByRole('button', { name: 'Hide data table' })).toHaveAttribute('aria-expanded', 'true');
    const table = screen.getByRole('table', { name: 'Accesses per day data' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(data.length);
    rows.forEach((row, i) => {
      const cells = within(row).getAllByRole('cell').map((c) => c.textContent);
      expect(cells).toEqual([data[i]!.day, String(data[i]!.ui), String(data[i]!.api), String(data[i]!.mcp)]);
    });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Date', 'UI', 'API', 'MCP']);
  });

  it('is operable with the keyboard', async () => {
    const user = userEvent.setup();
    render(<TimeSeriesChart title="Calls" kind="line" data={data} xKey="day" series={series} />);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Show data table' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('shows a legend entry per series', () => {
    render(<TimeSeriesChart title="Calls" kind="bar" data={data} xKey="day" series={series} />);
    expect(within(screen.getByRole('list', { name: 'Legend' })).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['UI', 'API', 'MCP']);
  });

  it('renders loading, empty and error states', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<TimeSeriesChart title="Calls" kind="line" data={[]} xKey="day" series={series} loading />);
    expect(screen.getByRole('status', { name: 'Loading Calls' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Calls' })).toHaveAttribute('aria-busy', 'true');
    rerender(<TimeSeriesChart title="Calls" kind="line" data={[]} xKey="day" series={series} unit="calls" />);
    expect(screen.getByText('No data in this period')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /data table/ })).not.toBeInTheDocument();
    rerender(<TimeSeriesChart title="Calls" kind="line" data={[{ day: 'a', ui: 0, api: 0, mcp: 0 }]} xKey="day" series={series} />);
    expect(screen.getByText('No data in this period')).toBeInTheDocument();
    rerender(<TimeSeriesChart title="Calls" kind="line" data={data} xKey="day" series={series} error="Server said secret-stack" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('contains the plot: hidden from assistive technology and width-bound', () => {
    const { container } = render(<TimeSeriesChart title="Calls" kind="line" data={data} xKey="day" series={series} />);
    const chart = container.querySelector('[data-slot="chart"]')!;
    expect(chart).toHaveAttribute('aria-hidden', 'true');
    expect(chart.className).toMatch(/min-w-0/);
    expect(chart.className).toMatch(/max-w-full/);
    expect(chart.className).toMatch(/overflow-hidden/);
    expect(container.querySelector('section')!.className).toMatch(/min-w-0/);
  });
});

describe('BarListChart', () => {
  it('summarises and tabulates ranked items', async () => {
    render(<BarListChart title="Top tools" data={[{ label: 'recall', value: 9 }, { label: 'remember', value: 1 }]} unit="calls" labelHeader="Tool" valueLabel="Calls" />);
    expect(screen.getByRole('region', { name: 'Top tools' })).toHaveAccessibleDescription('10 calls across 2 items. Highest: recall with 9.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show data table' }));
    const rows = within(screen.getByRole('table', { name: 'Top tools data' })).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([['recall', '9'], ['remember', '1']]);
  });
  it('shows the empty state', () => {
    render(<BarListChart title="Top tools" data={[]} />);
    expect(screen.getByText('No data in this period')).toBeInTheDocument();
  });
});

describe('Sparkline', () => {
  const points = Array.from({ length: 30 }, (_, i) => ({ label: `2026-10-${String(i + 1).padStart(2, '0')}`, value: i % 3 }));
  it('supports a 30-day series with a text and table equivalent', async () => {
    render(<Sparkline title="Accesses, last 30 days" points={points} valueLabel="Accesses" unit="accesses" />);
    expect(screen.getByRole('figure', { name: 'Accesses, last 30 days' })).toBeInTheDocument();
    expect(screen.getByText('30 accesses over 30 days, from 2026-10-01 to 2026-10-30.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show data table' }));
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(30);
    expect(within(rows[29]!).getAllByRole('cell').map((c) => c.textContent)).toEqual(['2026-10-30', '2']);
  });
  it('renders loading, empty and error states', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<Sparkline title="S" points={[]} loading />);
    expect(screen.getByRole('status', { name: 'Loading S' })).toBeInTheDocument();
    rerender(<Sparkline title="S" points={points.map((p) => ({ ...p, value: 0 }))} />);
    expect(screen.getByText('No activity in this period')).toBeInTheDocument();
    rerender(<Sparkline title="S" points={points} error onRetry={onRetry} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('series tokens', () => {
  it('maps channels and outcomes to semantic tokens and differentiates by pattern', () => {
    const r = resolveSeries(series);
    expect(r.map((s) => s.color)).toEqual(['var(--primary)', 'var(--info)', 'var(--success)']);
    expect(new Set(r.map((s) => s.pattern)).size).toBe(3);
    expect(SERIES_TOKENS.internal_error).toBe('destructive');
  });
  it('summarises empty data', () => {
    expect(summarizeSeries([], series, 'day', 'calls')).toBe('No calls in this period.');
  });
  it('uses no raw colours in the chart sources', () => {
    for (const f of ['components/ui/chart.tsx', 'components/usage-charts.tsx', 'components/chart-panel.tsx', 'lib/chart.ts']) {
      const src = readFileSync(resolve(__dirname, '..', f), 'utf8');
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|\b(?:bg|text|border|fill|stroke)-(?:zinc|slate|gray|red|green|blue|white|black)\b/);
    }
  });
});
