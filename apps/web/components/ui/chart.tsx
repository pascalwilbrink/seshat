'use client';
import * as React from 'react';
import { ResponsiveContainer, type TooltipProps } from 'recharts';
import { cn } from '@/lib/utils';
import { formatCount, type ChartPattern, type ResolvedSeries } from '@/lib/chart';

/**
 * Repo-owned chart wrappers around Recharts, the only chart library (`docs/ui.md`, "Charts").
 * Charts are decorative: the text summary and the data table next to them carry the information,
 * so the plot itself is `aria-hidden`. Animation is always off (reduced-motion safe).
 */
export function ChartContainer({ className, children, ...props }: Omit<React.ComponentProps<'div'>, 'children'> & { children: React.ReactElement }) {
  return (
    <div aria-hidden="true" data-slot="chart" className={cn('h-56 w-full min-w-0 max-w-full overflow-hidden text-xs [&_svg]:max-w-full', className)} {...props}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        {children}
      </ResponsiveContainer>
    </div>
  );
}

/** SVG `<defs>` with one fill pattern per series (`<prefix>-<key>`), drawn in the series token plus `background` strokes. */
export function ChartPatternDefs({ series, prefix }: { series: ResolvedSeries[]; prefix: string }) {
  return (
    <defs>
      {series.map((s) => (
        <pattern key={s.key} id={`${prefix}-${s.key}`} width="6" height="6" patternUnits="userSpaceOnUse">
          <PatternShapes pattern={s.pattern} color={s.color} />
        </pattern>
      ))}
    </defs>
  );
}

function PatternShapes({ pattern, color }: { pattern: ChartPattern; color: string }) {
  const bg = 'var(--background)';
  return (
    <>
      <rect width="6" height="6" fill={color} />
      {pattern === 'diagonal' ? <path d="M-1,1 l2,-2 M0,6 l6,-6 M5,7 l2,-2" stroke={bg} strokeWidth="1.5" /> : null}
      {pattern === 'dots' ? <circle cx="3" cy="3" r="1.2" fill={bg} /> : null}
      {pattern === 'cross' ? <path d="M0,3 h6 M3,0 v6" stroke={bg} strokeWidth="1" /> : null}
    </>
  );
}

/** Small legend/tooltip swatch that repeats the series pattern, so colour is never the only signal. */
export function ChartSwatch({ series }: { series: ResolvedSeries }) {
  const id = React.useId();
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" className="shrink-0 rounded-sm">
      <defs>
        <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse">
          <PatternShapes pattern={series.pattern} color={series.color} />
        </pattern>
      </defs>
      <rect width="12" height="12" fill={`url(#${id})`} />
    </svg>
  );
}

/** Legend rendered as HTML so it wraps at 375 px. */
export function ChartLegend({ series, className }: { series: ResolvedSeries[]; className?: string }) {
  return (
    <ul aria-label="Legend" className={cn('flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground', className)}>
      {series.map((s) => (
        <li key={s.key} className="flex min-w-0 items-center gap-1.5">
          <ChartSwatch series={s} />
          <span className="break-words">{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** Tooltip body shared by all charts: x label, then each series with swatch, label and formatted value. */
export function ChartTooltipContent({ series, active, payload, label }: TooltipProps<number, string> & { series: ResolvedSeries[] }) {
  if (!active || !payload?.length) return null;
  const byKey = new Map(series.map((s) => [s.key, s]));
  return (
    <div className="max-w-[16rem] rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1 font-medium break-words">{String(label ?? payload[0]?.payload?.label ?? '')}</p>
      <ul className="space-y-0.5">
        {payload.map((p) => {
          const s = byKey.get(String(p.dataKey));
          if (!s) return null;
          return (
            <li key={s.key} className="flex items-center gap-1.5">
              <ChartSwatch series={s} />
              <span className="min-w-0 flex-1 break-words text-muted-foreground">{s.label}</span>
              <span className="font-mono tabular-nums">{formatCount(Number(p.value ?? 0))}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
