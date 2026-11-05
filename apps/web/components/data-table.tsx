'use client';
import * as React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export type SortDirection = 'asc' | 'desc';
export interface SortState {
  columnId: string;
  direction: SortDirection;
}

export interface DataTableColumn<T> {
  /** Stable column id, also used as the sort key reported to the caller. */
  id: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  sortable?: boolean;
  /** Extra classes for the header and body cells. */
  className?: string;
}

export interface BulkActionsContext<T> {
  selectedRows: T[];
  selectedIds: string[];
  clearSelection: () => void;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  /** Stable, unique identifier per row. Never use the array index. */
  getRowId: (row: T) => string;
  /** Accessible name of the table. */
  label: string;
  /** Controlled sort state; the caller sorts or refetches. Cycles asc, desc, none. */
  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  /**
   * Controlled selection by row id. Only ids of the supplied `rows` count: when `rows` is replaced
   * ids that are no longer present are dropped through `onSelectedIdsChange`; appended rows keep the selection.
   */
  selectedIds?: string[];
  onSelectedIdsChange?: (ids: string[]) => void;
  /** Accessible name of a row checkbox, e.g. `Select report.pdf`. */
  getRowLabel?: (row: T) => string;
  /** Content of the bulk-action bar, shown while rows are selected. */
  bulkActions?: (ctx: BulkActionsContext<T>) => React.ReactNode;
  loading?: boolean;
  skeletonRows?: number;
  /** Rendered instead of the table body when there are no rows and nothing is loading. */
  empty?: React.ReactNode;
  /** Cursor paging is owned by the caller: show "Load more" while `hasMore`. */
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  label,
  sort = null,
  onSortChange,
  selectedIds,
  onSelectedIdsChange,
  getRowLabel,
  bulkActions,
  loading = false,
  skeletonRows = 5,
  empty,
  hasMore = false,
  onLoadMore,
  loadingMore = false,
  className,
}: DataTableProps<T>) {
  const selectable = selectedIds !== undefined && onSelectedIdsChange !== undefined;
  const rowIds = React.useMemo(() => rows.map(getRowId), [rows, getRowId]);
  const rowIdSet = React.useMemo(() => new Set(rowIds), [rowIds]);
  const selected = React.useMemo(() => new Set((selectedIds ?? []).filter((id) => rowIdSet.has(id))), [selectedIds, rowIdSet]);
  const selectedRows = rows.filter((row) => selected.has(getRowId(row)));

  // Selection is scoped to the supplied rows: drop ids that left the data (replaced or filtered out).
  React.useEffect(() => {
    if (!selectable || loading) return;
    const kept = (selectedIds ?? []).filter((id) => rowIdSet.has(id));
    if (kept.length !== (selectedIds ?? []).length) onSelectedIdsChange(kept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowIdSet, loading]);

  const setSelected = (ids: Iterable<string>) => onSelectedIdsChange?.([...ids]);
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = () => setSelected(allSelected ? [] : rowIds);
  const toggleRow = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const nextSort = (columnId: string): SortState | null => {
    if (!sort || sort.columnId !== columnId) return { columnId, direction: 'asc' };
    return sort.direction === 'asc' ? { columnId, direction: 'desc' } : null;
  };

  // Guards a second click before the caller has flipped `loadingMore`.
  const loadRequested = React.useRef(false);
  React.useEffect(() => {
    loadRequested.current = false;
  }, [rows, loadingMore, hasMore]);
  const loadMore = () => {
    if (loadingMore || loadRequested.current || !onLoadMore) return;
    loadRequested.current = true;
    onLoadMore();
  };

  const colCount = columns.length + (selectable ? 1 : 0);
  const showEmpty = !loading && rows.length === 0;

  return (
    <div className={cn('flex min-w-0 max-w-full flex-col gap-3', className)}>
      {selectable && selected.size > 0 && bulkActions ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2" data-testid="bulk-bar">
          <span role="status" className="text-sm font-medium">
            {selected.size} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {bulkActions({ selectedRows, selectedIds: [...selected], clearSelection: () => setSelected([]) })}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
            Clear selection
          </Button>
        </div>
      ) : null}
      {showEmpty && empty ? (
        empty
      ) : (
        <Table aria-label={label} aria-busy={loading || undefined}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {selectable ? (
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="Select all rows"
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    disabled={loading || rows.length === 0}
                    onCheckedChange={toggleAll}
                  />
                </TableHead>
              ) : null}
              {columns.map((col) => {
                const active = sort?.columnId === col.id ? sort.direction : null;
                const canSort = col.sortable && onSortChange;
                return (
                  <TableHead
                    key={col.id}
                    scope="col"
                    className={col.className}
                    aria-sort={col.sortable ? (active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none') : undefined}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        onClick={() => onSortChange(nextSort(col.id))}
                        className="-mx-1 inline-flex items-center gap-1 rounded-sm px-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        {col.header}
                        {active === 'asc' ? (
                          <ArrowUp className="size-3.5" aria-hidden="true" />
                        ) : active === 'desc' ? (
                          <ArrowDown className="size-3.5" aria-hidden="true" />
                        ) : (
                          <ChevronsUpDown className="size-3.5" aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ? Array.from({ length: skeletonRows }, (_, i) => (
                  <TableRow key={`skeleton-${i}`} data-testid="skeleton-row" className="hover:bg-transparent">
                    {Array.from({ length: colCount }, (_, c) => (
                      <TableCell key={c}>
                        <Skeleton className="h-4 w-full max-w-40" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : rows.map((row) => {
                  const id = getRowId(row);
                  return (
                    <TableRow key={id} data-state={selected.has(id) ? 'selected' : undefined}>
                      {selectable ? (
                        <TableCell className="w-10">
                          <Checkbox
                            aria-label={getRowLabel ? getRowLabel(row) : 'Select row'}
                            checked={selected.has(id)}
                            onCheckedChange={() => toggleRow(id)}
                          />
                        </TableCell>
                      ) : null}
                      {columns.map((col) => (
                        <TableCell key={col.id} className={col.className}>
                          {col.cell(row)}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
          </TableBody>
        </Table>
      )}
      {hasMore && onLoadMore && !loading ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore} aria-busy={loadingMore || undefined}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
