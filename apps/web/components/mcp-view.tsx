'use client';

import Link from 'next/link';
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Plug } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import type { ApiKeyDto, WorkspaceDto } from '@/lib/api-types';
import { claudeCodeConfig, describeRequirement, gildeConfig, KIND_LABEL, toolsForPermissions, type McpEndpoint } from '@/lib/mcp-config';
import { GLOBAL_OVERVIEW_PATH } from '@/lib/scope';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { CodeSnippet } from './code-snippet';
import { CopyField } from './copy-field';
import { McpHistory } from './mcp-history';
import { EmptyState } from './empty-state';
import { ErrorState } from './error-state';
import { PageHeader } from './page-header';
import { StatusBadge } from './status-badge';
import { useWorkspaces } from './workspaces-provider';
import { Button } from '@/components/ui/button';

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const SESSION = 'Your session has expired. Log in again to continue.';

/** Workspace MCP page. There is no Global variant: MCP clients always connect with a Workspace key. */
export function McpView({ slug, endpoint }: { slug: string; endpoint: McpEndpoint }) {
  const { state, reload } = useWorkspaces();
  if (state.status === 'loading') {
    return (
      <section aria-busy="true" className="flex flex-col gap-4">
        <PageHeader title="MCP" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="flex flex-col gap-4">
        <PageHeader title="MCP" />
        <ErrorState title="Couldn't load Workspaces" message="Try again in a moment." onRetry={reload} />
      </section>
    );
  }
  const workspace = state.workspaces.find((w) => w.slug === slug);
  if (!workspace) {
    return (
      <section className="flex flex-col gap-4">
        <PageHeader title="Workspace not found" description="This Workspace does not exist or is not available to you." />
        <Link href={GLOBAL_OVERVIEW_PATH} className="w-fit rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
          Go to Global Overview
        </Link>
      </section>
    );
  }
  return <McpPanel key={workspace.id} workspace={workspace} endpoint={endpoint} />;
}

function McpPanel({ workspace, endpoint }: { workspace: WorkspaceDto; endpoint: McpEndpoint }) {
  return (
    <section className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title="MCP"
        description={`Connect agents to ${workspace.name} over the Model Context Protocol. Each API key sees only the tools its permissions allow.`}
      />

      <div className="flex min-w-0 flex-col gap-2">
        <h2 className="text-lg font-semibold">Endpoint</h2>
        <CopyField value={endpoint.url} label="MCP endpoint" />
        <p className="text-sm text-muted-foreground">
          MCP clients connect to the API port directly, not through this web app. Use the address under which the API is reachable from the client.
        </p>
        {endpoint.invalid && (
          <p role="status" className="text-sm text-muted-foreground">
            SESHAT_MCP_URL is not a valid http(s) URL ending in /mcp, so the development default is shown.
          </p>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <h2 className="text-lg font-semibold">Client configuration</h2>
        <ConfigTabs url={endpoint.url} />
        <p className="text-sm text-muted-foreground">Replace the placeholder with a Workspace API key. Keys are shown once, when you create them.</p>
      </div>

      <ToolPreview workspace={workspace} />

      <div className="flex min-w-0 flex-col gap-2">
        <h2 className="text-lg font-semibold">Call history</h2>
        <p className="text-sm text-muted-foreground">Recent MCP calls made with this Workspace’s keys. Key names are shown as they were at call time.</p>
        <McpHistory scope={{ kind: 'workspace', workspace }} />
      </div>
    </section>
  );
}

function ConfigTabs({ url }: { url: string }) {
  const tabs = [
    { id: 'gilde', label: 'Gilde', code: gildeConfig(url), caption: 'Gilde project MCP server' },
    { id: 'claude-code', label: 'Claude Code', code: claudeCodeConfig(url), caption: 'Claude Code .mcp.json' },
  ] as const;
  const [active, setActive] = useState<(typeof tabs)[number]['id']>('gilde');
  const base = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    setActive(tabs[next]!.id);
    refs.current[tabs[next]!.id]?.focus();
  }

  const current = tabs.find((t) => t.id === active)!;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div role="tablist" aria-label="Client configuration" className="flex flex-wrap gap-1">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={active === t.id}
            aria-controls={`${base}-panel`}
            tabIndex={active === t.id ? 0 : -1}
            onClick={() => setActive(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-2 outline-ring ${active === t.id ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${current.id}`} className="min-w-0">
        <CodeSnippet code={current.code} label={`${current.caption} configuration`} />
      </div>
    </div>
  );
}

type KeysState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; keys: ApiKeyDto[] };

function ToolPreview({ workspace }: { workspace: WorkspaceDto }) {
  const [keys, setKeys] = useState<KeysState>({ status: 'loading' });
  const [selected, setSelected] = useState('');
  const selectId = useId();

  const load = useCallback(async () => {
    setKeys({ status: 'loading' });
    try {
      const res = await apiFetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/api-keys`);
      if (!res.ok) {
        setKeys({ status: 'error', message: res.status === 401 ? SESSION : 'Could not load API keys.' });
        return;
      }
      setKeys({ status: 'ready', keys: (await res.json()) as ApiKeyDto[] });
    } catch {
      setKeys({ status: 'error', message: NETWORK });
    }
  }, [workspace.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const keysHref = `/w/${encodeURIComponent(workspace.slug)}/api-keys`;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h2 className="text-lg font-semibold">Tools for a key</h2>
      {keys.status === 'loading' && (
        <div aria-busy="true" className="flex flex-col gap-2">
          <p role="status" className="sr-only">Loading API keys</p>
          <Skeleton className="h-9 w-full max-w-sm" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      {keys.status === 'error' && <ErrorState title="Couldn't load API keys" message={keys.message} onRetry={load} />}
      {keys.status === 'ready' && keys.keys.length === 0 && (
        <EmptyState
          icon={Plug}
          title="No API keys yet"
          description="Create a Workspace API key to connect an agent and see the tools it gets."
          action={
            <Link href={keysHref} className="rounded-sm text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">
              Go to API Keys
            </Link>
          }
        />
      )}
      {keys.status === 'ready' && keys.keys.length > 0 && (
        <>
          <div className="flex max-w-sm min-w-0 flex-col gap-1.5">
            <Label htmlFor={selectId}>API key</Label>
            <Select id={selectId} value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">Select a key</option>
              {keys.keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                  {k.status !== 'active' ? ` (${k.status})` : ''}
                </option>
              ))}
            </Select>
          </div>
          <div aria-live="polite" className="min-w-0">
            <KeyTools apiKey={keys.keys.find((k) => k.id === selected) ?? null} keysHref={keysHref} />
          </div>
        </>
      )}
    </div>
  );
}

function KeyTools({ apiKey, keysHref }: { apiKey: ApiKeyDto | null; keysHref: string }) {
  if (!apiKey) return <p className="text-sm text-muted-foreground">Select a key to see the tools it would get.</p>;
  if (apiKey.status !== 'active') {
    return (
      <div className="flex flex-col items-start gap-2 text-sm">
        <StatusBadge status={apiKey.status} />
        <p className="text-muted-foreground">
          {apiKey.status === 'revoked' ? 'This key is revoked.' : 'This key has expired.'} MCP clients using it are refused, so it gets no tools.
        </p>
      </div>
    );
  }
  const tools = toolsForPermissions(apiKey.permissions);
  if (tools.length === 0) {
    return (
      <EmptyState
        icon={Plug}
        title="This key gets no tools"
        description="Its permissions don't unlock any MCP tool. Create a key with file, memory or search permissions."
        action={
          <Link href={keysHref} className="rounded-sm text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">
            Go to API Keys
          </Link>
        }
      />
    );
  }
  const hasGlobal = apiKey.permissions.includes('global:read');
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        {tools.length} {tools.length === 1 ? 'tool' : 'tools'} for {apiKey.name}.
        {hasGlobal ? ' Read and search tools can also reach Global.' : ' Tools act in this Workspace only.'}
      </p>
      <ul aria-label={`Tools for ${apiKey.name}`} className="flex min-w-0 flex-col divide-y divide-border rounded-md border border-border">
        {tools.map((t) => (
          <li key={t.name} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <code className="font-mono text-sm break-all">{t.name}</code>
            <Badge variant={t.kind === 'destructive' ? 'destructive' : t.kind === 'write' ? 'warning' : 'secondary'}>{KIND_LABEL[t.kind]}</Badge>
            {t.global && <Badge variant="outline">Global</Badge>}
            <span className="min-w-0 basis-full text-sm text-muted-foreground break-words sm:basis-auto sm:flex-1 sm:text-right">
              Requires <span className="font-mono">{describeRequirement(t.requires)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
