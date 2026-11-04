'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { OverviewDto } from '@/lib/api-types';
import { GLOBAL_OVERVIEW_PATH, scopeHref, type Scope } from '@/lib/scope';
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
      <section>
        <h1>Overview</h1>
        <p role="alert">Could not load Workspaces.</p>
        <button type="button" onClick={reload}>
          Retry
        </button>
      </section>
    );
  }
  if (unknownSlug || load.status === 'not-found') {
    return (
      <section>
        <h1>Workspace not found</h1>
        <p className="muted">This Workspace does not exist or is not available to you.</p>
        <Link href={GLOBAL_OVERVIEW_PATH}>Go to Global Overview</Link>
      </section>
    );
  }
  if (load.status === 'error') {
    return (
      <section>
        <h1>Overview</h1>
        <p role="alert">Could not load the Overview.</p>
        <button type="button" onClick={retry}>
          Retry
        </button>
      </section>
    );
  }
  if (load.status === 'loading' || (slug !== null && collection.status === 'loading')) {
    return (
      <section aria-busy="true">
        <h1>Overview</h1>
        <p role="status" className="muted">
          Loading…
        </p>
      </section>
    );
  }

  const data = load.data;
  const noWorkspaces = data.scope === 'global' && collection.status === 'ready' && collection.workspaces.length === 0;
  return (
    <section>
      <p className="scope-label">{data.scope === 'global' ? 'Global' : 'Workspace'}</p>
      <h1>{data.name}</h1>
      {data.scope === 'workspace' && (
        <dl className="meta">
          <dt>Slug</dt>
          <dd>{data.slug}</dd>
          <dt>Description</dt>
          <dd>{data.description ?? <span className="muted">No description</span>}</dd>
          <dt>Created</dt>
          <dd>
            <time dateTime={data.createdAt}>{new Date(data.createdAt).toLocaleDateString('en-GB', { dateStyle: 'long', timeZone: 'UTC' })}</time>
          </dd>
        </dl>
      )}
      {noWorkspaces && (
        <p>
          <Link href="/global/settings" className="cta">
            Create your first Workspace
          </Link>
        </p>
      )}
    </section>
  );
}
