'use client';
import * as React from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartDataTable, ChartPanel, TableToggle, type ChartStateProps } from '@/components/chart-panel';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { ChartContainer, ChartLegend, ChartPatternDefs, ChartTooltipContent } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCount, isEmptyData, resolveSeries, summarizeSeries, type ChartRow, type ChartSeries } from '@/lib/chart';

export type TimeSeriesKind = 'line' | 'stacked' | 'bar';

export interface TimeSeriesChartProps extends ChartStateProps {
  title: string;
  description?: string;
  /** `line`: trends; `stacked`: parts of a total per day; `bar`: grouped comparison. See docs/ui.md, "Charts". */
  kind: TimeSeriesKind;
  data: ChartRow[];
  /** Key of the x value (a date label or category) in each row. */
  xKey: string;
  xHeader?: string;
  series: ChartSeries[];
  /** What is counted, for the summary ("calls"). */
  unit?: string;
  /** Overrides the generated summary. */
  summary?: string;
  className?: string;
}

const axisTick = { fill: 'var(--muted-foreground)', fontSize: 12 };

/** Line, stacked or grouped bar chart over a time axis or categories, with summary, legend, tooltip and table alternative. */
export function TimeSeriesChart({ title, description, kind, data, xKey, xHeader = 'Date', series, unit = 'events', summary, className, ...state }: TimeSeriesChartProps) {
  const prefix = React.useId().replace(/:/g, '');
  const resolved = React.useMemo(() => resolveSeries(series), [series]);
  const empty = isEmptyData(data, series);
  const text = summary ?? summarizeSeries(data, series, xKey, unit);
  const common = { data, margin: { top: 4, right: 8, bottom: 0, left: 0 } };
  const axes = (
    <>
      <CartesianGrid vertical={false} stroke="var(--border)" />
      <XAxis dataKey={xKey} tick={axisTick} tickLine={false} axisLine={{ stroke: 'var(--border)' }} minTickGap={24} />
      <YAxis tick={axisTick} tickLine={false} axisLine={false} allowDecimals={false} width={40} tickFormatter={(v: number) => formatCount(v)} />
      <Tooltip cursor={{ stroke: 'var(--border)' }} content={<ChartTooltipContent series={resolved} />} isAnimationActive={false} />
    </>
  );
  return (
    <ChartPanel
      title={title}
      description={description}
      summary={text}
      empty={empty}
      className={className}
      table={<ChartDataTable label={`${title} data`} rows={data} xKey={xKey} xHeader={xHeader} series={series} />}
      {...state}
    >
      <ChartContainer>
        {kind === 'line' ? (
          <LineChart {...common}>
            {axes}
            {resolved.map((s) => (
              <Line key={s.key} dataKey={s.key} name={s.label} type="monotone" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} dot={false} isAnimationActive={false} />
            ))}
          </LineChart>
        ) : (
          <BarChart {...common}>
            <ChartPatternDefs series={resolved} prefix={prefix} />
            {axes}
            {resolved.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} stackId={kind === 'stacked' ? 'total' : undefined} fill={`url(#${prefix}-${s.key})`} stroke={s.color} isAnimationActive={false} />
            ))}
          </BarChart>
        )}
      </ChartContainer>
      <ChartLegend series={resolved} />
    </ChartPanel>
  );
}

export interface BarListChartProps extends ChartStateProps {
  title: string;
  description?: string;
  /** Rows already ranked by the caller, e.g. the top ten tools. */
  data: { label: string; value: number }[];
  valueLabel?: string;
  labelHeader?: string;
  unit?: string;
  className?: string;
}

/** Horizontal ranking (top tools, top resources). One series, so no legend. */
export function BarListChart({ title, description, data, valueLabel = 'Count', labelHeader = 'Name', unit = 'events', className, ...state }: BarListChartProps) {
  const prefix = React.useId().replace(/:/g, '');
  const series: ChartSeries[] = [{ key: 'value', label: valueLabel, token: 'primary' }];
  const resolved = resolveSeries(series);
  const rows: ChartRow[] = data.map((d) => ({ label: d.label, value: d.value }));
  const empty = isEmptyData(rows, series);
  const summary = empty ? `No ${unit} in this period.` : `${formatCount(data.reduce((a, d) => a + d.value, 0))} ${unit} across ${data.length} ${data.length === 1 ? 'item' : 'items'}. Highest: ${data[0]!.label} with ${formatCount(Math.max(...data.map((d) => d.value)))}.`;
  return (
    <ChartPanel
      title={title}
      description={description}
      summary={summary}
      empty={empty}
      className={className}
      table={<ChartDataTable label={`${title} data`} rows={rows} xKey="label" xHeader={labelHeader} series={series} />}
      {...state}
    >
      <ChartContainer style={{ height: Math.max(120, data.length * 32 + 24) }}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <ChartPatternDefs series={resolved} prefix={prefix} />
          <CartesianGrid horizontal={false} stroke="var(--border)" />
          <XAxis type="number" tick={axisTick} tickLine={false} axisLine={false} allowDecimals={false} tickFormatter={(v: number) => formatCount(v)} />
          <YAxis type="category" dataKey="label" tick={axisTick} tickLine={false} axisLine={false} width={96} interval={0} />
          <Tooltip cursor={{ fill: 'var(--accent)' }} content={<ChartTooltipContent series={resolved} />} isAnimationActive={false} />
          <Bar dataKey="value" name={valueLabel} fill={`url(#${prefix}-value)`} stroke={resolved[0]!.color} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>
    </ChartPanel>
  );
}

export interface SparklinePoint {
  /** Label shown in the table, e.g. an ISO date. */
  label: string;
  value: number;
}

export interface SparklineProps extends ChartStateProps {
  /** Accessible name and caption, e.g. "Accesses, last 30 days". */
  title: string;
  points: SparklinePoint[];
  valueLabel?: string;
  labelHeader?: string;
  unit?: string;
  className?: string;
}

/** Compact trend line for a detail view (for example 30 daily points) with a text summary and a table alternative. */
export function Sparkline({ title, points, valueLabel = 'Count', labelHeader = 'Date', unit = 'events', className, loading, error, onRetry, emptyTitle = 'No activity in this period' }: SparklineProps) {
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  const series: ChartSeries[] = [{ key: 'value', label: valueLabel, token: 'primary' }];
  const resolved = resolveSeries(series);
  const rows: ChartRow[] = points.map((p) => ({ label: p.label, value: p.value }));
  const empty = isEmptyData(rows, series);
  const total = points.reduce((a, p) => a + p.value, 0);
  const summary = empty ? `No ${unit} in this period.` : `${formatCount(total)} ${unit} over ${points.length} days, from ${points[0]!.label} to ${points[points.length - 1]!.label}.`;
  const failed = Boolean(error) && !loading;
  return (
    <figure aria-label={title} aria-busy={loading || undefined} className={className ?? 'flex min-w-0 max-w-full flex-col gap-2'}>
      <figcaption className="text-sm font-medium break-words">{title}</figcaption>
      {loading ? (
        <div role="status" aria-label={`Loading ${title}`}>
          <Skeleton className="h-10 w-full" />
        </div>
      ) : failed ? (
        <ErrorState title="Couldn't load this chart" message={typeof error === 'string' ? error : 'Try again in a moment.'} onRetry={onRetry} className="p-4" />
      ) : empty ? (
        <EmptyState title={emptyTitle} description={summary} className="p-4" />
      ) : (
        <>
          <ChartContainer className="h-10">
            <LineChart data={rows} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
              <Line dataKey="value" name={valueLabel} type="monotone" stroke={resolved[0]!.color} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ChartContainer>
          <p className="text-sm text-muted-foreground break-words">{summary}</p>
          <div>
            <TableToggle open={open} onToggle={() => setOpen((o) => !o)} controls={`${id}-table`} />
          </div>
          <div id={`${id}-table`} hidden={!open} className="min-w-0 max-w-full overflow-x-auto">
            {open ? <ChartDataTable label={`${title} data`} rows={rows} xKey="label" xHeader={labelHeader} series={series} /> : null}
          </div>
        </>
      )}
    </figure>
  );
}
