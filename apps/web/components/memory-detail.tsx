'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { MemoryDto } from '@/lib/api-types';
import { formatDate } from '@/lib/files';
import { readFormError } from '@/lib/form-errors';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from './confirm-dialog';
import { ResourceUsage } from './resource-usage';
import { MemoryForm, type MemoryFormResult } from './memory-form';
import { EmbeddingBadge, MemoryStatusBadge, TypeBadge, provenanceText } from './memory-badges';

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const SESSION = 'Your session has expired. Log in again to continue.';

/** While an embedding is pending the detail re-reads the Memory this often, at most MAX_POLLS times. */
export const MEMORY_POLL_MS = 3000;
export const MAX_POLLS = 20;

type State =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string; session: boolean }
  | { status: 'ready'; memory: MemoryDto };

/**
 * Full Memory. Everything is rendered as text (React escapes it); the record is read again by id, so a successor link
 * works the same way as an opened row. `base` is the scope's memories URL, so a successor can never be another scope's.
 */
export function MemoryDetail({
  base,
  memoryId,
  onSelect,
  onClose,
  onChanged,
  onForgotten,
  onReplace,
}: {
  base: string;
  memoryId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** A mutation succeeded: the scoped list should be read again. */
  onChanged: () => void;
  /** The Memory was forgotten (or was already gone). */
  onForgotten: () => void;
  /** Open creation with this Memory as the one to supersede. */
  onReplace: (id: string) => void;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState<{ pending: boolean; error: string | null }>({ pending: false, error: null });
  const [forget, setForget] = useState<{ open: boolean; pending: boolean; error: string | null }>({ open: false, pending: false, error: null });
  const [pollsExhausted, setPollsExhausted] = useState(false);
  const retrying = useRef(false);
  const forgetting = useRef(false);
  const latest = useRef(0);
  const mounted = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (silent = false) => {
    const id = ++latest.current;
    const current = () => mounted.current && id === latest.current;
    if (!silent) setState({ status: 'loading' });
    try {
      const res = await apiFetch(`${base}/${encodeURIComponent(memoryId)}`);
      if (!current()) return;
      if (res.status === 404) return setState({ status: 'missing' });
      if (!res.ok && silent) return;
      if (!res.ok) {
        const message = res.status === 401 ? SESSION : (await readFormError(res)).message;
        if (current()) setState({ status: 'error', message, session: res.status === 401 });
        return;
      }
      const memory = (await res.json()) as MemoryDto;
      if (current()) setState({ status: 'ready', memory });
    } catch {
      if (current() && !silent) setState({ status: 'error', message: NETWORK, session: false });
    }
  }, [base, memoryId]);

  const embeddingStatus = state.status === 'ready' ? state.memory.embeddingStatus : null;
  const polls = useRef(0);
  // Bounded polling, only while the embedding is pending; the timer is cleared on unmount, id/scope change and status change.
  useEffect(() => {
    if (embeddingStatus !== 'pending') {
      polls.current = 0;
      setPollsExhausted(false);
      return;
    }
    if (polls.current >= MAX_POLLS) {
      setPollsExhausted(true);
      return;
    }
    const timer = setTimeout(() => {
      polls.current += 1;
      void load(true);
    }, MEMORY_POLL_MS);
    return () => clearTimeout(timer);
  }, [embeddingStatus, state, load]);
  // A status change away from pending also changes the list row.
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    if (lastStatus.current === 'pending' && embeddingStatus && embeddingStatus !== 'pending') onChanged();
    lastStatus.current = embeddingStatus;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embeddingStatus]);

  function onFormDone(r: MemoryFormResult) {
    setEditing(false);
    if (r.kind === 'updated') {
      setState({ status: 'ready', memory: r.memory });
      setNotice('Memory saved.');
      onChanged();
    } else if (r.kind === 'conflict') {
      setNotice('This Memory was superseded in the meantime and can no longer be edited. Open its successor instead.');
      void load(true);
      onChanged();
    }
  }

  async function retryEmbedding() {
    if (retrying.current) return;
    retrying.current = true;
    setRetry({ pending: true, error: null });
    try {
      const res = await apiFetch(`${base}/${encodeURIComponent(memoryId)}/retry-embedding`, { method: 'POST' });
      if (!mounted.current) return;
      if (res.ok) {
        const memory = (await res.json()) as MemoryDto;
        if (!mounted.current) return;
        polls.current = 0;
        setState({ status: 'ready', memory });
        setRetry({ pending: false, error: null });
        onChanged();
      } else {
        const message = res.status === 401 ? SESSION : res.status === 404 ? 'This Memory no longer exists.' : (await readFormError(res)).message;
        if (mounted.current) setRetry({ pending: false, error: message });
      }
    } catch {
      if (mounted.current) setRetry({ pending: false, error: NETWORK });
    } finally {
      retrying.current = false;
    }
  }

  async function forgetMemory() {
    if (forgetting.current) return;
    forgetting.current = true;
    setForget((f) => ({ ...f, pending: true, error: null }));
    try {
      const res = await apiFetch(`${base}/${encodeURIComponent(memoryId)}`, { method: 'DELETE' });
      if (!mounted.current) return;
      // 404: already forgotten elsewhere; the outcome the user wanted holds.
      if (res.ok || res.status === 404) {
        onForgotten();
        return;
      }
      const message = res.status === 401 ? SESSION : (await readFormError(res)).message;
      if (mounted.current) setForget({ open: true, pending: false, error: message });
    } catch {
      if (mounted.current) setForget({ open: true, pending: false, error: NETWORK });
    } finally {
      forgetting.current = false;
    }
  }

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (state.status !== 'loading') headingRef.current?.focus();
  }, [state.status]);

  return (
    <section aria-labelledby="memory-detail-heading" className="mt-6 rounded-md border border-border p-4">
      <h2 id="memory-detail-heading" tabIndex={-1} ref={headingRef} className="mb-2 text-lg font-semibold break-words">
        {state.status === 'ready' ? (state.memory.title ?? 'Memory') : 'Memory'}
      </h2>
      {state.status === 'loading' && (
        <p role="status" aria-busy="true" className="text-muted-foreground">
          Loading Memory…
        </p>
      )}
      {state.status === 'missing' && <p role="alert">This Memory no longer exists.</p>}
      {state.status === 'error' && (
        <div>
          <p role="alert">{state.message}</p>
          {!state.session && (
            <Button type="button" onClick={() => void load()}>
              Retry
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="mb-3">
          {notice}
        </p>
      )}
      {state.status === 'ready' && <DetailBody memory={state.memory} onSelect={onSelect} />}
      {state.status === 'ready' && <ResourceUsage key={state.memory.id} base={base} id={state.memory.id} />}
      {state.status === 'ready' && state.memory.embeddingStatus === 'pending' && (
        <p role="status" className="mb-3 text-muted-foreground">
          {pollsExhausted ? 'Embedding is still pending.' : 'Embedding in progress; this updates automatically.'}
          {pollsExhausted && (
            <Button type="button" variant="link" size="sm" onClick={() => { polls.current = 0; setPollsExhausted(false); void load(true); }}>
              Check again
            </Button>
          )}
        </p>
      )}
      {state.status === 'ready' && state.memory.embeddingStatus === 'failed' && (
        <div className="mb-3">
          <p>Embedding failed. The Memory is saved but not yet searchable.</p>
          {retry.error && <p role="alert" className="break-words text-sm text-destructive">{retry.error}</p>}
          <Button type="button" onClick={() => void retryEmbedding()} disabled={retry.pending} aria-busy={retry.pending}>
            {retry.pending ? 'Retrying…' : 'Retry embedding'}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {state.status === 'ready' && state.memory.status === 'active' && (
          <>
            <Button type="button" onClick={() => { setNotice(null); setEditing(true); }}>
              Edit
            </Button>
            <Button type="button" variant="outline" onClick={() => onReplace(state.memory.id)}>
              Create replacement
            </Button>
          </>
        )}
        {state.status === 'ready' && (
          <Button type="button" variant="destructive" onClick={() => setForget({ open: true, pending: false, error: null })}>
            Forget
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onClose}>
          Close details
        </Button>
      </div>
      {state.status === 'ready' && state.memory.status === 'superseded' && (
        <p className="mt-2 text-sm text-muted-foreground">Superseded Memories cannot be edited.</p>
      )}
      {editing && state.status === 'ready' && state.memory.status === 'active' && (
        <MemoryForm base={base} mode={{ kind: 'edit', memory: state.memory }} onDone={onFormDone} onClose={() => setEditing(false)} />
      )}
      <ConfirmDialog
        open={forget.open}
        onOpenChange={(open) => setForget({ open, pending: false, error: null })}
        title="Forget Memory"
        consequence="This permanently deletes the Memory and its embedding. Memories it superseded stay superseded but lose their link to it. This cannot be undone."
        confirmLabel="Forget Memory"
        onConfirm={forgetMemory}
        pending={forget.pending}
        error={forget.error}
      />
    </section>
  );
}

function DetailBody({ memory: m, onSelect }: { memory: MemoryDto; onSelect: (id: string) => void }) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <TypeBadge type={m.type} />
        <MemoryStatusBadge status={m.status} />
        <EmbeddingBadge status={m.embeddingStatus} />
      </div>
      {m.status === 'superseded' &&
        (m.supersededBy ? (
          <p className="mb-3">
            Superseded by a newer Memory.{' '}
            <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => onSelect(m.supersededBy!)}>
              Open successor
            </Button>
          </p>
        ) : (
          <p className="mb-3 text-muted-foreground">Superseded; the successor was forgotten, so there is no link.</p>
        ))}
      <h3 className="mb-1 text-sm font-medium">Content</h3>
      <pre className="mb-3 whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">{m.content}</pre>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">Tags</dt>
        <dd className="break-words">{m.tags.length > 0 ? m.tags.join(', ') : '—'}</dd>
        <dt className="text-muted-foreground">Source</dt>
        <dd className="break-words">{m.source ?? '—'}</dd>
        <dt className="text-muted-foreground">Confidence</dt>
        <dd>{m.confidence === null ? '—' : m.confidence}</dd>
        <dt className="text-muted-foreground">Created by</dt>
        <dd className="break-words">{provenanceText(m)}</dd>
        <dt className="text-muted-foreground">Embedding</dt>
        <dd className="break-words">
          {m.embeddingStatus}
          {m.embeddingModel ? ` · ${m.embeddingModel}` : ''}
        </dd>
        <dt className="text-muted-foreground">Created</dt>
        <dd>{formatDate(m.createdAt)}</dd>
        <dt className="text-muted-foreground">Updated</dt>
        <dd>{formatDate(m.updatedAt)}</dd>
        <dt className="text-muted-foreground">Metadata</dt>
        <dd>{m.metadata ? <pre className="whitespace-pre-wrap break-words text-sm">{JSON.stringify(m.metadata, null, 2)}</pre> : '—'}</dd>
      </dl>
    </div>
  );
}
