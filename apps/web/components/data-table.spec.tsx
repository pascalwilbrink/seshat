// @vitest-environment jsdom
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn, type SortState } from './data-table';

interface Row {
  id: string;
  name: string;
  size: number;
}
const columns: DataTableColumn<Row>[] = [
  { id: 'name', header: 'Name', cell: (r) => r.name, sortable: true },
  { id: 'size', header: 'Size', cell: (r) => `${r.size} B` },
];
const rows: Row[] = [
  { id: 'a', name: 'alpha', size: 1 },
  { id: 'b', name: 'beta', size: 2 },
  { id: 'c', name: 'gamma', size: 3 },
];
const getRowId = (r: Row) => r.id;

function Harness(props: { initial?: string[]; rows?: Row[]; onBulk?: (ids: string[]) => void; onSelect?: (ids: string[]) => void }) {
  const [ids, setIds] = React.useState<string[]>(props.initial ?? []);
  return (
    <DataTable
      label="Files"
      columns={columns}
      rows={props.rows ?? rows}
      getRowId={getRowId}
      getRowLabel={(r) => `Select ${r.name}`}
      selectedIds={ids}
      onSelectedIdsChange={(next) => {
        props.onSelect?.(next);
        setIds(next);
      }}
      bulkActions={({ selectedIds }) => <Button onClick={() => props.onBulk?.(selectedIds)}>Delete</Button>}
    />
  );
}

describe('DataTable', () => {
  it('renders typed columns and rows', () => {
    render(<DataTable label="Files" columns={columns} rows={rows} getRowId={getRowId} />);
    expect(screen.getByRole('table', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(screen.getByText('3 B')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('exposes sort state and cycles asc, desc, none by keyboard', async () => {
    const onSort = vi.fn();
    const { rerender } = render(<DataTable label="Files" columns={columns} rows={rows} getRowId={getRowId} sort={null} onSortChange={onSort} />);
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: 'Size' })).not.toHaveAttribute('aria-sort');
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    expect(onSort).toHaveBeenLastCalledWith({ columnId: 'name', direction: 'asc' });

    const asc: SortState = { columnId: 'name', direction: 'asc' };
    rerender(<DataTable label="Files" columns={columns} rows={rows} getRowId={getRowId} sort={asc} onSortChange={onSort} />);
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(onSort).toHaveBeenLastCalledWith({ columnId: 'name', direction: 'desc' });

    rerender(<DataTable label="Files" columns={columns} rows={rows} getRowId={getRowId} sort={{ columnId: 'name', direction: 'desc' }} onSortChange={onSort} />);
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'descending');
    await userEvent.keyboard(' ');
    expect(onSort).toHaveBeenLastCalledWith(null);
  });

  it('selects rows by keyboard, shows the bulk bar and runs bulk callbacks', async () => {
    const onBulk = vi.fn();
    render(<Harness onBulk={onBulk} />);
    expect(screen.queryByTestId('bulk-bar')).toBeNull();
    screen.getByRole('checkbox', { name: 'Select beta' }).focus();
    await userEvent.keyboard(' ');
    expect(screen.getByRole('checkbox', { name: 'Select beta' })).toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent('1 selected');
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onBulk).toHaveBeenCalledWith(['b']);
    await userEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByTestId('bulk-bar')).toBeNull();
  });

  it('select-all has an indeterminate state and toggles every supplied row', async () => {
    render(<Harness />);
    const all = screen.getByRole('checkbox', { name: 'Select all rows' });
    expect(all).not.toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select alpha' }));
    expect(all).toHaveAttribute('aria-checked', 'mixed');
    await userEvent.click(all);
    expect(all).toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent('3 selected');
    await userEvent.click(all);
    expect(screen.queryByTestId('bulk-bar')).toBeNull();
  });

  it('keeps selection when rows are appended and drops ids when rows are replaced', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<Harness initial={['a', 'b']} onSelect={onSelect} />);
    expect(screen.getByRole('status')).toHaveTextContent('2 selected');
    rerender(<Harness initial={['a', 'b']} onSelect={onSelect} rows={[...rows, { id: 'd', name: 'delta', size: 4 }]} />);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('2 selected');
    // replaced data: only "b" survives
    rerender(<Harness initial={['a', 'b']} onSelect={onSelect} rows={[{ id: 'b', name: 'beta', size: 2 }, { id: 'z', name: 'zeta', size: 9 }]} />);
    expect(onSelect).toHaveBeenLastCalledWith(['b']);
    expect(screen.getByRole('status')).toHaveTextContent('1 selected');
  });

  it('shows skeleton rows while loading and no selection pruning', () => {
    const onSelect = vi.fn();
    render(
      <DataTable label="Files" columns={columns} rows={[]} getRowId={getRowId} loading skeletonRows={4} selectedIds={['a']} onSelectedIdsChange={onSelect} empty={<p>Nothing</p>} />,
    );
    expect(screen.getAllByTestId('skeleton-row')).toHaveLength(4);
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Nothing')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders the caller-supplied empty content', () => {
    render(<DataTable label="Files" columns={columns} rows={[]} getRowId={getRowId} empty={<p>No files yet</p>} />);
    expect(screen.getByText('No files yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('Load more calls back once, and is disabled while pending', async () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<DataTable label="Files" columns={columns} rows={rows} getRowId={getRowId} hasMore onLoadMore={onLoadMore} />);
    const btn = screen.getByRole('button', { name: 'Load more' });
    await userEvent.dblClick(btn);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    rerender(<DataTable label="Files" columns={columns} rows={rows} getRowId={getRowId} hasMore onLoadMore={onLoadMore} loadingMore />);
    const pending = screen.getByRole('button', { name: 'Loading…' });
    expect(pending).toBeDisabled();
    await userEvent.click(pending);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    // finished (e.g. failed): can request again
    rerender(<DataTable label="Files" columns={columns} rows={rows} getRowId={getRowId} hasMore onLoadMore={onLoadMore} />);
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });

  it('hides Load more without a next cursor', () => {
    render(<DataTable label="Files" columns={columns} rows={rows} getRowId={getRowId} hasMore={false} onLoadMore={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('bounds overflow to the table container', () => {
    const { container } = render(<DataTable label="Files" columns={columns} rows={rows} getRowId={getRowId} />);
    expect(container.firstElementChild?.className).toContain('min-w-0');
    expect(within(container).getByRole('table').parentElement?.className).toContain('overflow-x-auto');
  });
});
