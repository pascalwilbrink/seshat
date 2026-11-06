'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { OverviewDto } from '@/lib/api-types';
import { GLOBAL_OVERVIEW_PATH, scopeHref, type Scope } from '@/lib/scope';
import { Boxes } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from './empty-state';
import { ErrorState } from './error-state';
import { PageHeader } from './page-header';
import { RelativeTime } from './relative-time';
import { StatCard } from './stat-card';
import { UsageDashboard } from './usage-dashboard';
import { useWorkspaces } from './workspaces-provider';

type Load = { status: 'loading' } | { status: 'error' } | { status: 'not-found' } | { status: 'ready'; data: OverviewDto };

/** Scope Overview. A Workspace slug is only a UI key: it is resolved to the UUID through the authorized collection. */
export function OverviewView({ scope }: { scope: Scope }) {
  const { state: collection, reload } = useWorkspaces();
  const slug = scope.kind === 'workspace' ? scope.slug : null;
  const workspaceId =
    slug !== null && collection.status === 'ready' ? (collection.workspaces.find((w) => w.slug === slug)?.id ?? null) : null;
  const unknownSlug = slug !== null && collection.status === 'ready' && workspaceId === null;

  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setLoad({ status: 'loading' });
    setAttempt((a) => a + 1);
  }, []);

  const target = slug === null ? '/api/global/overview' : workspaceId ? `/api/workspaces/${encodeURIComponent(workspaceId)}/overview` : null;

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setLoad({ status: 'loading' });
    (async () => {
      try {
        const res = await apiFetch(target);
        if (res.status === 404) return !cancelled && setLoad({ status: 'not-found' });
        if (!res.ok) throw new Error('failed');
        const data = (await res.json()) as OverviewDto;
        if (!cancelled) setLoad({ status: 'ready', data });
      } catch {
        if (!cancelled) setLoad({ status: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, attempt]);

  if (slug !== null && collection.status === 'error') {
    return (
      <section className="flex flex-col gap-6">
        <PageHeader title="Overview" />
        <ErrorState title="Could not load Workspaces" message="Check your connection and try again." retryLabel="Retry" onRetry={reload} />
      </section>
    );
  }
  if (unknownSlug || load.status === 'not-found') {
    return (
      <section className="flex flex-col gap-6">
        <PageHeader title="Workspace not found" description="This Workspace does not exist or is not available to you." />
        <div>
          <Button asChild variant="outline">
            <Link href={GLOBAL_OVERVIEW_PATH}>Go to Global Overview</Link>
          </Button>
        </div>
      </section>
    );
  }
  if (load.status === 'error') {
    return (
      <section className="flex flex-col gap-6">
        <PageHeader title="Overview" />
        <ErrorState title="Could not load the Overview" message="Check your connection and try again." retryLabel="Retry" onRetry={retry} />
      </section>
    );
  }
  if (load.status === 'loading' || (slug !== null && collection.status === 'loading')) {
    return (
      <section aria-busy="true" className="flex flex-col gap-6">
        <PageHeader title="Overview" />
        <p role="status" className="sr-only">
          Loading…
        </p>
        <Skeleton className="h-24 w-full max-w-md" />
      </section>
    );
  }

  const data = load.data;
  const workspaceCount = collection.status === 'ready' ? collection.workspaces.length : null;
  if (data.scope === 'global') {
    return (
      <section className="flex flex-col gap-6">
        <PageHeader title={data.name} description="Knowledge shared across the account." />
        {workspaceCount === 0 ? (
          <EmptyState
            title="No Workspaces yet"
            description="Workspaces keep knowledge separate. Create one to get started."
            icon={Boxes}
            action={
              <Button asChild>
                <Link href="/global/settings">Create your first Workspace</Link>
              </Button>
            }
          />
        ) : workspaceCount !== null ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard label="Workspaces" value={workspaceCount} icon={Boxes} hint="Available to you" />
          </div>
        ) : null}
        <UsageDashboard scope={scope} base="/api/global" />
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-6">
      <PageHeader title={data.name} />
      <Card className="min-w-0 p-4">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Slug</dt>
          <dd className="min-w-0 break-words font-mono">{data.slug}</dd>
          <dt className="text-muted-foreground">Description</dt>
          <dd className="min-w-0 break-words">{data.description ?? <span className="text-muted-foreground">No description</span>}</dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd className="min-w-0">
            {new Date(data.createdAt).toLocaleDateString('en-GB', { dateStyle: 'long', timeZone: 'UTC' })} · <RelativeTime value={data.createdAt} />
          </dd>
        </dl>
      </Card>
      <UsageDashboard key={data.id} scope={scope} base={`/api/workspaces/${encodeURIComponent(data.id)}`} />
    </section>
  );
}
