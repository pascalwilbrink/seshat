'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { ResourceUsageDto } from '@/lib/api-types';
import { formatCount } from '@/lib/chart';
import { ErrorState } from '@/components/error-state';
import { RelativeTime } from '@/components/relative-time';
import { Sparkline } from '@/components/usage-charts';
import { Skeleton } from '@/components/ui/skeleton';

type State = { status: 'loading' } | { status: 'ready'; usage: ResourceUsageDto } | { status: 'missing' } | { status: 'error'; message: string };

/** "Never" for a resource without accesses; otherwise relative time with the exact UTC time on focus/hover. */
export function LastAccessed({ value }: { value: string | null | undefined }) {
  if (value === undefined) return null;
  if (value === null) return <span className="text-muted-foreground">Never</span>;
  return <RelativeTime value={value} />;
}

const CHANNELS = [['ui', 'UI'], ['api', 'API'], ['mcp', 'MCP']] as const;
const KINDS = [['read', 'Read'], ['retrieved', 'Retrieved']] as const;

/**
 * Usage of one File or Memory. Loads on its own, so a failure or a slow response never touches the resource detail
 * around it. `base` is the scoped collection URL (".../files" or ".../memories"); a change of base or id cancels the
 * request in flight and discards its answer.
 */
export function ResourceUsage({ base, id }: { base: string; id: string }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: 'loading' });
    (async () => {
      try {
        const res = await apiFetch(`${base}/${encodeURIComponent(id)}/usage?days=30`, { signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        if (res.ok) {
          const usage = (await res.json()) as ResourceUsageDto;
          if (!ctrl.signal.aborted) setState({ status: 'ready', usage });
        } else if (res.status === 404) setState({ status: 'missing' });
        else if (res.status === 401) setState({ status: 'error', message: 'Your session has expired. Log in again to continue.' });
        else setState({ status: 'error', message: 'Usage could not be loaded.' });
      } catch {
        if (!ctrl.signal.aborted) setState({ status: 'error', message: 'Could not reach the server. Check your connection and try again.' });
      }
    })();
    return () => ctrl.abort();
  }, [base, id, attempt]);

  return (
    <section aria-labelledby={`usage-${id}`} className="my-4 min-w-0">
      <h3 id={`usage-${id}`} className="mb-2 text-md font-semibold">
        Usage
      </h3>
      {state.status === 'loading' && (
        <div role="status" aria-label="Loading usage">
          <Skeleton className="h-16 w-full" />
        </div>
      )}
      {state.status === 'missing' && <p className="text-muted-foreground">Usage is not available: this resource no longer exists.</p>}
      {state.status === 'error' && <ErrorState title="Couldn't load usage" message={state.message} onRetry={retry} className="p-4" />}
      {state.status === 'ready' && <UsageBody usage={state.usage} />}
    </section>
  );
}

function UsageBody({ usage }: { usage: ResourceUsageDto }) {
  const { lifetime } = usage;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Accesses (lifetime)</dt>
        <dd className="m-0 tabular-nums">{formatCount(lifetime.total)}</dd>
        <dt className="text-muted-foreground">Last accessed</dt>
        <dd className="m-0">
          <LastAccessed value={usage.lastAccessedAt} />
        </dd>
        {CHANNELS.map(([key, label]) => (
          <Pair key={key} term={`${label} (lifetime)`} value={lifetime.byChannel[key]} />
        ))}
        {KINDS.map(([key, label]) => (
          <Pair key={key} term={`${label} (lifetime)`} value={lifetime.byKind[key]} />
        ))}
      </dl>
      <Sparkline
        title="Accesses, last 30 days"
        points={usage.daily.map((d) => ({ label: d.day, value: d.total }))}
        valueLabel="Accesses"
        unit="accesses"
        emptyTitle="No accesses in the last 30 days"
      />
    </div>
  );
}

function Pair({ term, value }: { term: string; value: number }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="m-0 tabular-nums">{formatCount(value)}</dd>
    </>
  );
}
