'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { MemoryHintDto } from '@/lib/api-types';
import { readFormError } from '@/lib/form-errors';
import { Button } from '@/components/ui/button';

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const SESSION = 'Your session has expired. Log in again to continue.';

type HintState = { status: 'idle' } | { status: 'pending' } | { status: 'done' } | { status: 'gone' } | { status: 'error'; message: string };

/**
 * Similar-Memory choices after a create. Supersede calls the lifecycle endpoint on the chosen existing Memory with the
 * already saved Memory as successor; Keep both only dismisses the hint (no request). Nothing is merged automatically.
 */
export function MemoryHints({
  base,
  successorId,
  hints,
  deduplicated,
  onSuperseded,
  onDismiss,
}: {
  base: string;
  successorId: string;
  hints: MemoryHintDto[];
  deduplicated: boolean;
  onSuperseded: () => void;
  onDismiss: () => void;
}) {
  const [states, setStates] = useState<Record<string, HintState>>({});
  const [kept, setKept] = useState<Set<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const set = (id: string, s: HintState) => mounted.current && setStates((p) => ({ ...p, [id]: s }));

  async function supersede(id: string) {
    if (inFlight.current.has(id)) return;
    inFlight.current.add(id);
    set(id, { status: 'pending' });
    try {
      const res = await apiFetch(`${base}/${encodeURIComponent(id)}/supersede`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ successorId }),
      });
      if (res.ok) {
        set(id, { status: 'done' });
        if (mounted.current) onSuperseded();
      } else if (res.status === 404) {
        // Deleted (or no longer reachable) meanwhile: nothing to supersede any more.
        set(id, { status: 'gone' });
        if (mounted.current) onSuperseded();
      } else if (res.status === 401) set(id, { status: 'error', message: SESSION });
      else set(id, { status: 'error', message: (await readFormError(res)).message });
    } catch {
      set(id, { status: 'error', message: NETWORK });
    } finally {
      inFlight.current.delete(id);
    }
  }

  const open = hints.filter((h) => !kept.has(h.id));
  return (
    <section aria-labelledby="memory-hints-heading" className="mt-4 rounded-md border border-border p-4">
      <h2 id="memory-hints-heading" className="mb-2 text-lg font-semibold">
        Memory saved
      </h2>
      {deduplicated && (
        <p role="status" className="mb-2">
          An identical active Memory already existed, so it was reused instead of creating another. Any tags you entered were added to it.
        </p>
      )}
      {!deduplicated && <p role="status" className="mb-2">The Memory was created.</p>}
      {open.length > 0 && (
        <>
          <p className="mb-2 text-muted-foreground">
            Similar active Memories were found. Supersede marks the older one as replaced by the Memory you just saved; Keep both leaves everything as it is.
          </p>
          <ul className="flex flex-col gap-3">
            {open.map((h) => {
              const s = states[h.id] ?? { status: 'idle' };
              return (
                <li key={h.id} className="rounded-md border border-border p-3" aria-label={`Similar ${h.type} Memory`}>
                  <p className="text-xs uppercase text-muted-foreground">{h.type}</p>
                  <p className="mb-2 break-words">{h.preview}</p>
                  {s.status === 'done' && <p role="status">Superseded by the new Memory.</p>}
                  {s.status === 'gone' && <p role="status">This Memory no longer exists, so nothing was changed.</p>}
                  {s.status === 'error' && <p role="alert" className="break-words text-sm text-destructive">{s.message}</p>}
                  {s.status !== 'done' && s.status !== 'gone' && (
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" disabled={s.status === 'pending'} aria-busy={s.status === 'pending'} onClick={() => void supersede(h.id)}>
                        {s.status === 'pending' ? 'Superseding…' : 'Supersede'}
                        <span className="sr-only"> this Memory</span>
                      </Button>
                      <Button type="button" size="sm" variant="outline" disabled={s.status === 'pending'} onClick={() => setKept((k) => new Set(k).add(h.id))}>
                        Keep both
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <Button type="button" variant="outline" className="mt-3" onClick={onDismiss}>
        Done
      </Button>
    </section>
  );
}
