'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useState } from 'react';
import { Activity, AlertTriangle, Brain, FileText, Gauge, Archive } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { USAGE_WINDOWS, type McpOutcome, type UsageOverviewDto, type UsageWindowDays } from '@/lib/api-types';
import { formatCount, type ChartSeries } from '@/lib/chart';
import { scopeHref, type Scope } from '@/lib/scope';
import { ChartPanel } from './chart-panel';
import { ErrorState } from './error-state';
import { StatCard } from './stat-card';
import { BarListChart, TimeSeriesChart } from './usage-charts';

const OUTCOME_SERIES: ChartSeries[] = [
  { key: 'ok', label: 'Succeeded', token: 'success' },
  { key: 'validation_error', label: 'Invalid arguments', token: 'warning' },
  { key: 'forbidden', label: 'Forbidden', token: 'primary' },
  { key: 'not_found', label: 'Not found', token: 'info' },
  { key: 'unknown_tool', label: 'Unknown tool', token: 'muted-foreground' },
  { key: 'internal_error', label: 'Internal error', token: 'destructive' },
];
const OUTCOMES = OUTCOME_SERIES.map((s) => s.key as McpOutcome);
const CHANNEL_SERIES: ChartSeries[] = [
  { key: 'ui', label: 'UI' },
  { key: 'api', label: 'API' },
  { key: 'mcp', label: 'MCP' },
];

type Load = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: UsageOverviewDto };

const percent = (rate: number) => `${(Math.round(rate * 1000) / 10).toLocaleString('en-US')}%`;
const shortId = (id: string) => id.slice(0, 8);

/** Segmented 7/30/90-day choice built on native radios, so arrow keys and the group label come for free. */
function WindowSelector({ value, onChange }: { value: UsageWindowDays; onChange: (d: UsageWindowDays) => void }) {
  const name = useId();
  return (
    <fieldset className="flex min-w-0 flex-wrap items-center gap-2">
      <legend className="sr-only">Time window</legend>
      <span aria-hidden="true" className="text-sm text-muted-foreground">
        Period
      </span>
      <div className="inline-flex rounded-md border border-border p-0.5">
        {USAGE_WINDOWS.map((d) => (
          <label key={d} className="relative cursor-pointer rounded-sm px-3 py-1 text-sm has-[:checked]:bg-primary has-[:checked]:text-primary-foreground has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring">
            <input type="radio" name={name} className="absolute inset-0 size-full cursor-pointer opacity-0" checked={value === d} onChange={() => onChange(d)} aria-label={`Last ${d} days`} />
            {d} days
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function TopResources({ title, kind, scope, items, loading }: { title: string; kind: 'file' | 'memory'; scope: Scope; items: { id: string; count: number }[]; loading: boolean }) {
  const noun = kind === 'file' ? 'File' : 'Memory';
  const href = (id: string) => `${scopeHref(scope, kind === 'file' ? 'files' : 'memories')}?${new URLSearchParams({ [kind]: id }).toString()}`;
  const total = items.reduce((a, i) => a + i.count, 0);
  return (
    <ChartPanel
      title={title}
      summary={items.length === 0 ? 'No accesses in this period.' : `${formatCount(total)} accesses across ${items.length} ${items.length === 1 ? 'item' : 'items'}. Most accessed: ${noun} ${shortId(items[0]!.id)} with ${formatCount(items[0]!.count)}.`}
      empty={items.length === 0}
      loading={loading}
      emptyTitle="No accesses in this period"
      table={null}
    >
      <ol className="flex min-w-0 flex-col divide-y divide-border">
        {items.map((i) => (
          <li key={i.id} className="flex min-w-0 items-center justify-between gap-3 py-2 text-sm">
            <Link href={href(i.id)} aria-label={`${noun} ${i.id}`} className="min-w-0 truncate rounded-sm font-mono text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
              {noun} {shortId(i.id)}
            </Link>
            <span className="shrink-0 tabular-nums">{formatCount(i.count)}</span>
          </li>
        ))}
      </ol>
    </ChartPanel>
  );
}

/** Stat row and charts of one scope from the single `usage/overview` aggregate. Re-keyed per scope by the caller. */
export function UsageDashboard({ scope, base }: { scope: Scope; base: string }) {
  const [days, setDays] = useState<UsageWindowDays>(30);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoad({ status: 'loading' });
    (async () => {
      try {
        const res = await apiFetch(`${base}/usage/overview?days=${days}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error('failed');
        const data = (await res.json()) as UsageOverviewDto;
        if (!ctrl.signal.aborted) setLoad({ status: 'ready', data });
      } catch {
        if (!ctrl.signal.aborted) setLoad({ status: 'error' });
      }
    })();
    return () => ctrl.abort();
  }, [base, days, attempt]);

  const loading = load.status === 'loading';
  const d = load.status === 'ready' ? load.data : null;
  const val = (v: number | null | undefined, fmt: (n: number) => string = formatCount) => (v === null || v === undefined ? '…' : fmt(v));

  return (
    <section aria-label="Usage" aria-busy={loading || undefined} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Usage</h2>
        <WindowSelector value={days} onChange={setDays} />
      </div>
      {scope.kind === 'global' ? (
        <p className="text-sm">
          <Link href="/global/mcp-history" className="rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            View MCP call history across all Workspaces
          </Link>
        </p>
      ) : null}
      {load.status === 'error' ? (
        <ErrorState title="Could not load usage" message="Check your connection and try again." retryLabel="Retry" onRetry={retry} />
      ) : (
        <>
          {loading ? (
            <p role="status" className="sr-only">
              Loading usage…
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard label="Files" value={val(d?.files.total)} icon={FileText} hint={d ? `${formatCount(d.files.indexed)} indexed · ${formatCount(d.files.failed)} failed` : undefined} />
            <StatCard label="Memories" value={val(d?.memories.total)} icon={Brain} hint={d ? `${formatCount(d.memories.active)} active · ${formatCount(d.memories.superseded)} superseded` : undefined} />
            <StatCard label="MCP calls" value={val(d?.mcp.calls)} icon={Activity} hint={d ? `Last ${d.window.days} days` : undefined} />
            <StatCard label="MCP error rate" value={val(d?.mcp.errorRate, percent)} icon={AlertTriangle} hint={d ? `${formatCount(d.mcp.errors)} of ${formatCount(d.mcp.calls)} calls failed` : undefined} />
            <StatCard label="Unused Files" value={val(d?.unused.files)} icon={Archive} hint={d ? `Not accessed in ${d.window.days} days` : undefined} />
            <StatCard label="Unused Memories" value={val(d?.unused.memories)} icon={Gauge} hint={d ? `Active, not accessed in ${d.window.days} days` : undefined} />
          </div>
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <TimeSeriesChart
              title="Accesses per day"
              description="Files and Memories read or retrieved, by channel"
              kind="stacked"
              xKey="day"
              series={CHANNEL_SERIES}
              unit="accesses"
              loading={loading}
              data={(d?.accessesDaily ?? []).map((p) => ({ day: p.day, ui: p.byChannel.ui, api: p.byChannel.api, mcp: p.byChannel.mcp }))}
            />
            <TimeSeriesChart
              title="MCP calls per day"
              description="Tool calls by outcome"
              kind="stacked"
              xKey="day"
              series={OUTCOME_SERIES}
              unit="calls"
              loading={loading}
              data={(d?.callsDaily ?? []).map((p) => ({ day: p.day, ...Object.fromEntries(OUTCOMES.map((o) => [o, p.byOutcome[o] ?? 0])) }))}
            />
            <BarListChart title="Top tools" description="Ten most called MCP tools" data={(d?.topTools ?? []).slice(0, 10).map((t) => ({ label: t.tool, value: t.calls }))} labelHeader="Tool" valueLabel="Calls" unit="calls" loading={loading} />
            {scope.kind === 'global' ? (
              <BarListChart
                title="MCP calls per Workspace"
                data={(d?.callsByWorkspace ?? []).map((w) => ({ label: w.name, value: w.calls }))}
                labelHeader="Workspace"
                valueLabel="Calls"
                unit="calls"
                loading={loading}
              />
            ) : null}
            <TopResources title="Most accessed Files" kind="file" scope={scope} items={d?.topFiles ?? []} loading={loading} />
            <TopResources title="Most accessed Memories" kind="memory" scope={scope} items={d?.topMemories ?? []} loading={loading} />
          </div>
        </>
      )}
    </section>
  );
}
