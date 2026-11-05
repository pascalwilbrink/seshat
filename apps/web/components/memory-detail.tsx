'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { MemoryDto } from '@/lib/api-types';
import { formatDate } from '@/lib/files';
import { readFormError } from '@/lib/form-errors';
import { Button } from '@/components/ui/button';
import { EmbeddingBadge, MemoryStatusBadge, TypeBadge, provenanceText } from './memory-badges';

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const SESSION = 'Your session has expired. Log in again to continue.';

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
}: {
  base: string;
  memoryId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const latest = useRef(0);
  const mounted = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const id = ++latest.current;
    const current = () => mounted.current && id === latest.current;
    setState({ status: 'loading' });
    try {
      const res = await apiFetch(`${base}/${encodeURIComponent(memoryId)}`);
      if (!current()) return;
      if (res.status === 404) return setState({ status: 'missing' });
      if (!res.ok) {
        const message = res.status === 401 ? SESSION : (await readFormError(res)).message;
        if (current()) setState({ status: 'error', message, session: res.status === 401 });
        return;
      }
      const memory = (await res.json()) as MemoryDto;
      if (current()) setState({ status: 'ready', memory });
    } catch {
      if (current()) setState({ status: 'error', message: NETWORK, session: false });
    }
  }, [base, memoryId]);

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
      {state.status === 'ready' && <DetailBody memory={state.memory} onSelect={onSelect} />}
      <Button type="button" onClick={onClose}>
        Close details
      </Button>
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
