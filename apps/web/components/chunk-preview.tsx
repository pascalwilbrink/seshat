'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { ChunkDto, ChunkPageDto } from '@/lib/api-types';
import { Button } from '@/components/ui/button';

const PAGE_SIZE = 10;
/** Upper bound of pages read automatically while looking for a cited chunk. */
const MAX_FOCUS_PAGES = 100;

/** A chunk to show: by id, or by ordinal when only that is known. */
export interface ChunkFocus {
  chunkId: string | null;
  ordinal: number | null;
}
const NETWORK = 'Could not reach the server. Check your connection and try again.';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: ChunkDto[]; nextCursor: string | null; more: { pending: boolean; error: string | null } };

function message(status: number): string {
  if (status === 401) return 'Your session has expired. Log in again to continue.';
  if (status === 403) return 'You are not allowed to preview this file.';
  if (status === 404) return 'This file no longer exists.';
  return 'Could not load the preview. Please try again.';
}

function describe(c: ChunkDto): string {
  const l = c.location;
  const path = l.headingPath && l.headingPath.length > 0 ? l.headingPath.join(' › ') : (l.section ?? null);
  const lines = l.startLine === l.endLine ? `line ${l.startLine}` : `lines ${l.startLine}–${l.endLine}`;
  return path ? `${path} · ${lines}` : lines;
}

/**
 * Paged preview of a file's extracted chunks. Content is untrusted: it is rendered only as text nodes (inside `<pre>`),
 * never as Markdown or HTML, and is never logged. `reloadKey` restarts the preview when the file is re-indexed.
 */
export function ChunkPreview({ base, fileId, reloadKey, focus = null }: { base: string; fileId: string; reloadKey: string; focus?: ChunkFocus | null }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const latest = useRef(0);
  const pages = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const url = useCallback((cursor: string | null) => {
    const p = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor) p.set('cursor', cursor);
    return `${base}/${encodeURIComponent(fileId)}/chunks?${p.toString()}`;
  }, [base, fileId]);

  const loadFirst = useCallback(async () => {
    const id = ++latest.current;
    const current = () => alive.current && id === latest.current;
    setState({ status: 'loading' });
    pages.current = 1;
    try {
      const res = await apiFetch(url(null));
      if (!current()) return;
      if (!res.ok) {
        setState({ status: 'error', message: message(res.status) });
        return;
      }
      const page = (await res.json()) as ChunkPageDto;
      if (current()) setState({ status: 'ready', items: page.items, nextCursor: page.hasMore ? page.nextCursor : null, more: { pending: false, error: null } });
    } catch {
      if (current()) setState({ status: 'error', message: NETWORK });
    }
  }, [url]);

  useEffect(() => {
    void loadFirst();
    return () => {
      latest.current++; // Drop any in-flight response of the previous file, scope or index run.
    };
  }, [loadFirst, reloadKey]);

  async function loadMore() {
    if (state.status !== 'ready' || !state.nextCursor || state.more.pending) return;
    const id = latest.current;
    const cursor = state.nextCursor;
    pages.current++;
    setState({ ...state, more: { pending: true, error: null } });
    const fail = (error: string) => setState((s) => (s.status === 'ready' ? { ...s, more: { pending: false, error } } : s));
    try {
      const res = await apiFetch(url(cursor));
      if (!alive.current || id !== latest.current) return;
      if (!res.ok) return fail(message(res.status));
      const page = (await res.json()) as ChunkPageDto;
      if (!alive.current || id !== latest.current) return;
      setState((s) =>
        s.status === 'ready'
          ? { status: 'ready', items: [...s.items, ...page.items.filter((n) => !s.items.some((o) => o.id === n.id))], nextCursor: page.hasMore ? page.nextCursor : null, more: { pending: false, error: null } }
          : s,
      );
    } catch {
      if (alive.current && id === latest.current) fail(NETWORK);
    }
  }

  const isTarget = (c: ChunkDto) => (focus?.chunkId ? c.id === focus.chunkId : focus?.ordinal != null && c.ordinal === focus.ordinal);
  const items = state.status === 'ready' ? state.items : [];
  const target = focus ? items.find(isTarget) : undefined;
  const lastOrdinal = items.length > 0 ? items[items.length - 1]!.ordinal : -1;
  const searching = Boolean(focus && state.status === 'ready' && !target && state.nextCursor && !state.more.pending && !state.more.error && pages.current < MAX_FOCUS_PAGES && (focus.ordinal == null || lastOrdinal < focus.ordinal));
  const missing = Boolean(focus && state.status === 'ready' && !target && !searching && !(state.nextCursor && state.more.pending));

  // Keep reading pages until the cited chunk is loaded (bounded by its ordinal and a page cap).
  useEffect(() => {
    if (searching) void loadMore();
  });
  const targetId = target?.id;
  useEffect(() => {
    if (targetId) document.getElementById(`chunk-${targetId}`)?.scrollIntoView?.({ block: 'center' });
  }, [targetId]);

  return (
    <section aria-labelledby={`chunks-title-${fileId}`} className="my-4">
      <h3 id={`chunks-title-${fileId}`} className="mb-2 text-base font-semibold">
        Content preview
      </h3>
      {state.status === 'loading' && (
        <p role="status" aria-busy="true" className="text-muted-foreground">
          Loading preview…
        </p>
      )}
      {state.status === 'error' && (
        <div>
          <p role="alert">{state.message}</p>
          <Button type="button" onClick={() => void loadFirst()}>
            Retry
          </Button>
        </div>
      )}
      {state.status === 'ready' && state.items.length === 0 && <p className="text-muted-foreground">No content has been indexed for this file yet.</p>}
      {missing && (
        <p role="status" className="mb-2 text-sm text-muted-foreground">
          The cited chunk is no longer available. The file may have been re-indexed.
        </p>
      )}
      {state.status === 'ready' && state.items.length > 0 && (
        <>
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {state.items.map((c) => (
              <li key={c.id} id={`chunk-${c.id}`} aria-current={target?.id === c.id ? 'true' : undefined} className={target?.id === c.id ? 'min-w-0 rounded-md border-2 border-primary p-3' : 'min-w-0 rounded-md border border-border p-3'}>
                <p className="mb-1 text-sm text-muted-foreground break-words">
                  <span className="font-mono">#{c.ordinal + 1}</span> · {describe(c)}
                  {target?.id === c.id && <strong className="ml-2 text-foreground">Cited chunk</strong>}
                </p>
                <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-sm">{c.content}</pre>
              </li>
            ))}
          </ol>
          {state.more.error && <p role="alert">{state.more.error}</p>}
          {state.nextCursor && (
            <Button type="button" onClick={() => void loadMore()} disabled={state.more.pending}>
              {state.more.pending ? 'Loading…' : state.more.error ? 'Retry loading more' : 'Load more chunks'}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
