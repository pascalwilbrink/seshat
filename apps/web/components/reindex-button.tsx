'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { FileDto } from '@/lib/api-types';
import { Button } from '@/components/ui/button';

const NETWORK = 'Could not reach the server. Check your connection and try again.';

function reindexError(status: number): string {
  if (status === 401) return 'Your session has expired. Log in again to continue.';
  if (status === 403) return 'You are not allowed to re-index this file.';
  if (status === 404) return 'This file no longer exists.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  return 'Could not start re-indexing. Please try again.';
}

/** Queues one file for re-indexing and reports the new (pending) file to the caller. */
export function ReindexButton({ base, file, onQueued }: { base: string; file: FileDto; onQueued: (file: FileDto) => void }) {
  const [state, setState] = useState<{ pending: boolean; error: string | null; done: boolean }>({ pending: false, error: null, done: false });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function run() {
    if (state.pending) return;
    setState({ pending: true, error: null, done: false });
    try {
      const res = await apiFetch(`${base}/${encodeURIComponent(file.id)}/reindex`, { method: 'POST' });
      if (!alive.current) return;
      if (!res.ok) {
        setState({ pending: false, error: reindexError(res.status), done: false });
        return;
      }
      const next = (await res.json()) as FileDto;
      if (!alive.current) return;
      setState({ pending: false, error: null, done: true });
      onQueued(next);
    } catch {
      if (alive.current) setState({ pending: false, error: NETWORK, done: false });
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => void run()} disabled={state.pending} aria-busy={state.pending}>
        {state.pending ? 'Re-indexing…' : 'Re-index'}
        <span className="sr-only"> {file.name}</span>
      </Button>
      {state.error && (
        <span role="alert" className="text-sm text-destructive break-words">
          {state.error}
        </span>
      )}
      <span role="status" className="sr-only">
        {state.done ? `Re-index of ${file.name} queued.` : ''}
      </span>
    </span>
  );
}
