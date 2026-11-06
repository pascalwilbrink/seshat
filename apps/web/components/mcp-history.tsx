'use client';

import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { History } from 'lucide-react';
import { MCP_TOOL_CATALOG } from '@seshat/domain';
import { apiFetch } from '@/lib/api-client';
import type { ApiKeyDto, McpCallDetailDto, McpCallDto, McpCallListDto, McpOutcome, WorkspaceDto } from '@/lib/api-types';
import { formatCount } from '@/lib/chart';
import { scopeHref } from '@/lib/scope';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable, type DataTableColumn } from './data-table';
import { EmptyState } from './empty-state';
import { ErrorState } from './error-state';
import { RelativeTime } from './relative-time';

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const FAILED = 'The call history could not be loaded.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OUTCOME_LABEL: Record<McpOutcome, string> = {
  ok: 'Succeeded',
  validation_error: 'Invalid arguments',
  forbidden: 'Forbidden',
  not_found: 'Not found',
  unknown_tool: 'Unknown tool',
  internal_error: 'Internal error',
};
const OUTCOME_VARIANT: Record<McpOutcome, 'success' | 'warning' | 'info' | 'secondary' | 'destructive'> = {
  ok: 'success',
  validation_error: 'warning',
  forbidden: 'warning',
  not_found: 'info',
  unknown_tool: 'secondary',
  internal_error: 'destructive',
};
const TOOLS = Object.keys(MCP_TOOL_CATALOG).sort();

export type HistoryScope = { kind: 'global' } | { kind: 'workspace'; workspace: WorkspaceDto };

interface Filters {
  tool: string;
  keyId: string;
  outcome: string;
  clientName: string;
  from: string;
  to: string;
}
const NO_FILTERS: Filters = { tool: '', keyId: '', outcome: '', clientName: '', from: '', to: '' };

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: McpCallDto[]; nextCursor: string | null; hasMore: boolean; loadingMore: boolean; moreError: string | null };

function queryString(f: Filters, cursor?: string | null): string {
  const p = new URLSearchParams();
  p.set('limit', '25');
  if (cursor) p.set('cursor', cursor);
  (['tool', 'keyId', 'outcome', 'clientName', 'from', 'to'] as const).forEach((k) => {
    if (f[k]) p.set(k, f[k]);
  });
  return p.toString();
}
const active = (f: Filters) => Object.values(f).some(Boolean);

/** Call history of one Workspace or, for Global, of all Workspaces. Re-keyed per scope by the caller. */
export function McpHistory({ scope }: { scope: HistoryScope }) {
  const base = scope.kind === 'global' ? '/api/global' : `/api/workspaces/${encodeURIComponent(scope.workspace.id)}`;
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const generation = useRef(0);
  const opener = useRef<HTMLElement | null>(null);

  // A new scope, filter set or retry starts a new generation: the cursor is dropped and older responses are ignored.
  useEffect(() => {
    const gen = ++generation.current;
    const ctrl = new AbortController();
    setList({ status: 'loading' });
    (async () => {
      try {
        const res = await apiFetch(`${base}/mcp-calls?${queryString(filters)}`, { signal: ctrl.signal });
        if (gen !== generation.current) return;
        if (!res.ok) {
          setList({ status: 'error', message: res.status === 401 ? 'Your session has expired. Log in again to continue.' : FAILED });
          return;
        }
        const page = (await res.json()) as McpCallListDto;
        if (gen !== generation.current) return;
        setList({ status: 'ready', items: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore, loadingMore: false, moreError: null });
      } catch {
        if (gen === generation.current) setList({ status: 'error', message: NETWORK });
      }
    })();
    return () => ctrl.abort();
  }, [base, filters, attempt]);

  const loadMore = useCallback(async () => {
    if (list.status !== 'ready' || !list.nextCursor || list.loadingMore) return;
    const gen = generation.current;
    const cursor = list.nextCursor;
    setList({ ...list, loadingMore: true, moreError: null });
    try {
      const res = await apiFetch(`${base}/mcp-calls?${queryString(filters, cursor)}`);
      if (gen !== generation.current) return;
      if (!res.ok) throw new Error('failed');
      const page = (await res.json()) as McpCallListDto;
      if (gen !== generation.current) return;
      setList((cur) => {
        if (cur.status !== 'ready') return cur;
        const seen = new Set(cur.items.map((i) => i.id));
        return { ...cur, items: [...cur.items, ...page.items.filter((i) => !seen.has(i.id))], nextCursor: page.nextCursor, hasMore: page.hasMore, loadingMore: false };
      });
    } catch {
      if (gen !== generation.current) return;
      setList((cur) => (cur.status === 'ready' ? { ...cur, loadingMore: false, moreError: 'Could not load more calls. Try again.' } : cur));
    }
  }, [base, filters, list]);

  const columns: DataTableColumn<McpCallDto>[] = [
    {
      id: 'time',
      header: 'Time',
      cell: (c) => (
        <button
          type="button"
          aria-label={`Open details for ${c.tool} call`}
          onClick={(e) => {
            opener.current = e.currentTarget;
            setOpenId(c.id);
          }}
          className="rounded-sm text-left text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          <RelativeTime value={c.occurredAt} tabIndex={-1} />
        </button>
      ),
    },
    ...(scope.kind === 'global'
      ? [{ id: 'workspace', header: 'Workspace', cell: (c: McpCallDto) => <span className="break-words">{c.workspace?.name ?? '—'}</span> }]
      : []),
    { id: 'tool', header: 'Tool', cell: (c) => <code className="font-mono text-sm break-all">{c.tool}</code> },
    { id: 'key', header: 'Key', cell: (c) => <span className="break-words">{c.keyName}</span> },
    {
      id: 'client',
      header: 'Client',
      cell: (c) => <span className="break-words">{c.clientName ? `${c.clientName}${c.clientVersion ? ` ${c.clientVersion}` : ''}` : 'Unknown'}</span>,
    },
    { id: 'outcome', header: 'Outcome', cell: (c) => <Badge variant={OUTCOME_VARIANT[c.outcome]}>{OUTCOME_LABEL[c.outcome]}</Badge> },
    { id: 'duration', header: 'Duration', className: 'text-right tabular-nums', cell: (c) => `${formatCount(c.durationMs)} ms` },
    {
      id: 'size',
      header: 'Result size',
      className: 'text-right tabular-nums',
      cell: (c) => (
        <span className="inline-flex flex-wrap items-center justify-end gap-1">
          {formatCount(c.resultChars)} chars
          {c.truncated && <Badge variant="outline">Truncated</Badge>}
        </span>
      ),
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <FilterForm key={`${base}`} scope={scope} applied={filters} onApply={setFilters} />
      <div aria-live="polite" className="min-w-0">
        {list.status === 'loading' && (
          <div aria-busy="true" className="flex flex-col gap-2">
            <p role="status" className="sr-only">Loading call history</p>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        )}
        {list.status === 'error' && <ErrorState title="Couldn't load call history" message={list.message} onRetry={() => setAttempt((a) => a + 1)} />}
        {list.status === 'ready' && (
          <>
            <DataTable
              label="MCP call history"
              columns={columns}
              rows={list.items}
              getRowId={(c) => c.id}
              hasMore={list.hasMore}
              onLoadMore={loadMore}
              loadingMore={list.loadingMore}
              empty={
                active(filters) ? (
                  <EmptyState
                    icon={History}
                    title="No calls match these filters"
                    description="Change or reset the filters to see more calls."
                    action={<Button variant="outline" onClick={() => setFilters(NO_FILTERS)}>Reset filters</Button>}
                  />
                ) : (
                  <EmptyState
                    icon={History}
                    title="No MCP calls yet"
                    description={scope.kind === 'global' ? 'Calls from agents in any Workspace appear here.' : 'Calls made with this Workspace’s API keys appear here.'}
                  />
                )
              }
            />
            {list.moreError && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {list.moreError}
              </p>
            )}
          </>
        )}
      </div>
      <CallSheet
        base={base}
        callId={openId}
        onClose={() => setOpenId(null)}
        returnFocus={() => opener.current?.focus()}
      />
    </div>
  );
}

function FilterForm({ scope, applied, onApply }: { scope: HistoryScope; applied: Filters; onApply: (f: Filters) => void }) {
  const id = useId();
  const [draft, setDraft] = useState<Filters>(applied);
  const [keys, setKeys] = useState<ApiKeyDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const wsId = scope.kind === 'workspace' ? scope.workspace.id : null;

  useEffect(() => {
    if (!wsId) return;
    let live = true;
    (async () => {
      try {
        const res = await apiFetch(`/api/workspaces/${encodeURIComponent(wsId)}/api-keys`);
        if (res.ok && live) setKeys((await res.json()) as ApiKeyDto[]);
      } catch {
        // The key filter then stays empty; the history itself is unaffected.
      }
    })();
    return () => {
      live = false;
    };
  }, [wsId]);

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  function submit(e: FormEvent) {
    e.preventDefault();
    if (draft.keyId && !UUID.test(draft.keyId.trim())) return setError('Key ID must be a UUID.');
    if (draft.from && draft.to && draft.from > draft.to) return setError('The start date must not be after the end date.');
    setError(null);
    onApply({ ...draft, keyId: draft.keyId.trim(), clientName: draft.clientName.trim() });
  }
  function reset() {
    setDraft(NO_FILTERS);
    setError(null);
    onApply(NO_FILTERS);
  }

  return (
    <form onSubmit={submit} aria-label="Filter call history" className="flex min-w-0 flex-col gap-3">
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={`${id}-tool`}>Tool</Label>
          <Select id={`${id}-tool`} value={draft.tool} onChange={set('tool')}>
            <option value="">All tools</option>
            {TOOLS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={`${id}-key`}>{wsId ? 'Key' : 'Key ID'}</Label>
          {wsId ? (
            <Select id={`${id}-key`} value={draft.keyId} onChange={set('keyId')}>
              <option value="">All keys</option>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                  {k.status !== 'active' ? ` (${k.status})` : ''}
                </option>
              ))}
            </Select>
          ) : (
            <Input id={`${id}-key`} value={draft.keyId} onChange={set('keyId')} placeholder="Key UUID" autoComplete="off" spellCheck={false} />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={`${id}-outcome`}>Outcome</Label>
          <Select id={`${id}-outcome`} value={draft.outcome} onChange={set('outcome')}>
            <option value="">All outcomes</option>
            {(Object.keys(OUTCOME_LABEL) as McpOutcome[]).map((o) => (
              <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>
            ))}
          </Select>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={`${id}-client`}>Client</Label>
          <Input id={`${id}-client`} value={draft.clientName} onChange={set('clientName')} maxLength={200} autoComplete="off" />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={`${id}-from`}>From (UTC)</Label>
          <Input id={`${id}-from`} type="date" value={draft.from} onChange={set('from')} />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={`${id}-to`}>To (UTC)</Label>
          <Input id={`${id}-to`} type="date" value={draft.to} onChange={set('to')} />
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit">Apply filters</Button>
        <Button type="button" variant="outline" onClick={reset} disabled={!active(draft) && !active(applied)}>Reset filters</Button>
      </div>
    </form>
  );
}

type DetailState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; call: McpCallDetailDto };

function CallSheet({ base, callId, onClose, returnFocus }: { base: string; callId: string | null; onClose: () => void; returnFocus: () => void }) {
  const [detail, setDetail] = useState<DetailState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!callId) return;
    const ctrl = new AbortController();
    setDetail({ status: 'loading' });
    (async () => {
      try {
        const res = await apiFetch(`${base}/mcp-calls/${encodeURIComponent(callId)}`, { signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        if (!res.ok) {
          setDetail({ status: 'error', message: res.status === 404 ? 'This call is no longer available.' : 'The call details could not be loaded.' });
          return;
        }
        const call = (await res.json()) as McpCallDetailDto;
        if (!ctrl.signal.aborted) setDetail({ status: 'ready', call });
      } catch {
        if (!ctrl.signal.aborted) setDetail({ status: 'error', message: NETWORK });
      }
    })();
    return () => ctrl.abort();
  }, [base, callId, attempt]);

  return (
    <Sheet open={callId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-[28rem] max-w-full overflow-y-auto sm:max-w-[90vw]"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          returnFocus();
        }}
      >
        <SheetHeader>
          <SheetTitle>Call details</SheetTitle>
          <SheetDescription>Safe fields only: no queries or content are recorded.</SheetDescription>
        </SheetHeader>
        {detail.status === 'loading' && (
          <div aria-busy="true" className="flex flex-col gap-2">
            <p role="status" className="sr-only">Loading call details</p>
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
        {detail.status === 'error' && <ErrorState title="Couldn't load call" message={detail.message} onRetry={() => setAttempt((a) => a + 1)} />}
        {detail.status === 'ready' && <CallDetail call={detail.call} />}
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

function resourceHref(call: McpCallDetailDto, r: McpCallDetailDto['resources'][number]): string {
  const scope = r.scope === 'global' ? ({ kind: 'global' } as const) : ({ kind: 'workspace', slug: call.workspace.slug } as const);
  return `${scopeHref(scope, r.kind === 'file' ? 'files' : 'memories')}?${new URLSearchParams({ [r.kind === 'file' ? 'file' : 'memory']: r.id }).toString()}`;
}

function CallDetail({ call }: { call: McpCallDetailDto }) {
  const summary = Object.entries(call.argsSummary);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <dl className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Time"><RelativeTime value={call.occurredAt} /></Field>
        <Field label="Workspace">{call.workspace.name}</Field>
        <Field label="Tool"><code className="font-mono">{call.tool}</code></Field>
        <Field label="Outcome"><Badge variant={OUTCOME_VARIANT[call.outcome]}>{OUTCOME_LABEL[call.outcome]}</Badge></Field>
        <Field label="Key (name at call time)">{call.keyName}</Field>
        <Field label="Client">{call.clientName ? `${call.clientName}${call.clientVersion ? ` ${call.clientVersion}` : ''}` : 'Unknown'}</Field>
        <Field label="Duration">{formatCount(call.durationMs)} ms</Field>
        <Field label="Result size">{formatCount(call.resultChars)} chars</Field>
        <Field label="Truncated">{call.truncated ? 'Yes, the result was cut to the size limit' : 'No'}</Field>
      </dl>
      <section aria-labelledby="args-h" className="flex flex-col gap-1.5">
        <h3 id="args-h" className="text-sm font-semibold">Argument summary</h3>
        {summary.length === 0 ? (
          <p className="text-sm text-muted-foreground">No arguments were summarised for this call.</p>
        ) : (
          <dl className="flex flex-col divide-y divide-border rounded-md border border-border">
            {summary.map(([k, v]) => (
              <div key={k} className="flex min-w-0 flex-wrap justify-between gap-2 px-3 py-1.5 text-sm">
                <dt className="font-mono text-muted-foreground">{k}</dt>
                <dd className="min-w-0 break-all">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <section aria-labelledby="touched-h" className="flex flex-col gap-1.5">
        <h3 id="touched-h" className="text-sm font-semibold">Touched Files and Memories</h3>
        {call.resources.length === 0 ? (
          <p className="text-sm text-muted-foreground">This call touched no Files or Memories.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {call.resources.map((r) => {
              const noun = r.kind === 'file' ? 'File' : 'Memory';
              return (
                <li key={`${r.kind}:${r.id}:${r.action}`} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm">
                  <Badge variant="outline">{noun}</Badge>
                  {r.scope === 'global' && <Badge variant="secondary">Global</Badge>}
                  {r.deleted ? (
                    <span className="min-w-0 break-all">
                      Deleted <span className="font-mono text-muted-foreground">{r.id}</span>
                    </span>
                  ) : (
                    <Link
                      href={resourceHref(call, r)}
                      aria-label={`${noun} ${r.id}`}
                      className="min-w-0 break-all rounded-sm font-mono text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {r.id}
                    </Link>
                  )}
                  <span className="text-muted-foreground">{r.action}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
