'use client';
import * as React from 'react';
import { ChartNoAxesColumn, Table2 } from 'lucide-react';
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCount, type ChartRow, type ChartSeries } from '@/lib/chart';
import { cn } from '@/lib/utils';

export interface ChartStateProps {
  loading?: boolean;
  /** Set when loading failed; the message must already be safe to show. */
  error?: string | boolean | null;
  onRetry?: () => void;
  /** Heading of the empty state. */
  emptyTitle?: string;
}

/** The data table every chart offers as its keyboard-operable text alternative. Values use the same formatter as tooltips. */
export function ChartDataTable({ label, rows, xKey, xHeader, series }: { label: string; rows: ChartRow[]; xKey: string; xHeader: string; series: ChartSeries[] }) {
  const columns: DataTableColumn<ChartRow>[] = [
    { id: xKey, header: xHeader, cell: (r) => String(r[xKey]) },
    ...series.map((s) => ({ id: s.key, header: s.label, className: 'text-right tabular-nums', cell: (r: ChartRow) => formatCount(Number(r[s.key] ?? 0)) })),
  ];
  return <DataTable label={label} columns={columns} rows={rows} getRowId={(r) => String(r[xKey])} />;
}

/** Button that shows or hides the data table; `aria-expanded` and `aria-controls` tie it to the region. */
export function TableToggle({ open, onToggle, controls }: { open: boolean; onToggle: () => void; controls: string }) {
  return (
    <Button type="button" variant="outline" size="sm" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      <Table2 aria-hidden="true" />
      {open ? 'Hide data table' : 'Show data table'}
    </Button>
  );
}

export interface ChartPanelProps extends ChartStateProps {
  title: string;
  description?: string;
  /** Text summary of the data, always visible; the plot is hidden from assistive technology. */
  summary: string;
  /** True when there is nothing to plot. */
  empty: boolean;
  /** The plot and its legend. */
  children: React.ReactNode;
  /** Table alternative; pass `null` to omit it (never for real data). */
  table: React.ReactNode;
  className?: string;
}

/** Frame for every chart: title, summary, loading/empty/error states and the data-table toggle. */
export function ChartPanel({ title, description, summary, empty, children, table, loading, error, onRetry, emptyTitle = 'No data in this period', className }: ChartPanelProps) {
  const id = React.useId();
  const titleId = `${id}-title`;
  const summaryId = `${id}-summary`;
  const tableId = `${id}-table`;
  const [open, setOpen] = React.useState(false);
  const failed = Boolean(error) && !loading;

  return (
    <section aria-labelledby={titleId} aria-describedby={loading || failed ? undefined : summaryId} aria-busy={loading || undefined} className={cn('flex min-w-0 max-w-full flex-col gap-3 rounded-xl border border-border bg-surface p-4 text-surface-foreground', className)}>
      <div className="min-w-0">
        <h3 id={titleId} className="text-base font-semibold break-words">
          {title}
        </h3>
        {description ? <p className="text-sm text-muted-foreground break-words">{description}</p> : null}
      </div>
      {loading ? (
        <div role="status" aria-label={`Loading ${title}`} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : failed ? (
        <ErrorState title="Couldn't load this chart" message={typeof error === 'string' ? error : 'Try again in a moment.'} onRetry={onRetry} />
      ) : empty ? (
        <EmptyState icon={ChartNoAxesColumn} title={emptyTitle} description={summary} />
      ) : (
        <>
          <p id={summaryId} className="text-sm text-muted-foreground break-words">
            {summary}
          </p>
          {children}
          {table ? (
            <div className="flex min-w-0 flex-col gap-2">
              <div>
                <TableToggle open={open} onToggle={() => setOpen((o) => !o)} controls={tableId} />
              </div>
              <div id={tableId} hidden={!open} className="min-w-0 max-w-full overflow-x-auto">
                {open ? table : null}
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
