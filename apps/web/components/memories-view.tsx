'use client';

import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import {
  MEMORY_LIST_STATUSES,
  MEMORY_TYPES,
  type MemoryDto,
  type MemoryListStatus,
  type MemoryPageDto,
  type CreateMemoryResultDto,
  type MemoryType,
  type TagDto,
  type WorkspaceDto,
} from '@/lib/api-types';
import { formatDate } from '@/lib/files';
import { readFormError } from '@/lib/form-errors';
import { GLOBAL_OVERVIEW_PATH, type Scope } from '@/lib/scope';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmbeddingBadge, MemoryStatusBadge, TypeBadge, provenanceText } from './memory-badges';
import { MemoryDetail } from './memory-detail';
import { MemoryForm, type MemoryFormResult } from './memory-form';
import { MemoryHints } from './memory-hints';
import { useWorkspaces } from './workspaces-provider';

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const SESSION = 'Your session has expired. Log in again to continue.';
const PREVIEW_CHARS = 160;

async function errorText(res: Response): Promise<string> {
  if (res.status === 401) return SESSION;
  return (await readFormError(res)).message;
}

function preview(m: MemoryDto): string {
  const text = m.content.replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** Memories of Global or one Workspace: list, create, edit, supersede, retry embedding and forget. All Memory text is untrusted and rendered as text only. */
export function MemoriesView({ scope, focusMemoryId = null }: { scope: Scope; focusMemoryId?: string | null }) {
  if (scope.kind === 'global') return <MemoriesPanel key={`global|${focusMemoryId ?? ''}`} base="/api/global" label="Global" focusMemoryId={focusMemoryId} />;
  return <WorkspaceMemories slug={scope.slug} focusMemoryId={focusMemoryId} />;
}

function WorkspaceMemories({ slug, focusMemoryId }: { slug: string; focusMemoryId: string | null }) {
  const { state, reload } = useWorkspaces();
  if (state.status === 'loading') {
    return (
      <section aria-busy="true">
        <h1 className="mb-4 text-2xl font-semibold tracking-tight break-words">Memories</h1>
        <p role="status" className="text-muted-foreground">
          Loading…
        </p>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section>
        <h1 className="mb-4 text-2xl font-semibold tracking-tight break-words">Memories</h1>
        <p role="alert">Could not load Workspaces.</p>
        <Button type="button" onClick={reload}>
          Retry
        </Button>
      </section>
    );
  }
  const workspace: WorkspaceDto | undefined = state.workspaces.find((w) => w.slug === slug);
  if (!workspace) {
    return (
      <section>
        <h1 className="mb-4 text-2xl font-semibold tracking-tight break-words">Workspace not found</h1>
        <p className="text-muted-foreground">This Workspace does not exist or is not available to you.</p>
        <Link href={GLOBAL_OVERVIEW_PATH} className="rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">Go to Global Overview</Link>
      </section>
    );
  }
  // Keyed by id: another Workspace never inherits a list, filters or an open detail.
  return <MemoriesPanel key={`${workspace.id}|${focusMemoryId ?? ''}`} base={`/api/workspaces/${encodeURIComponent(workspace.id)}`} label={`Workspace · ${workspace.name}`} focusMemoryId={focusMemoryId} />;
}

interface Filters {
  type: '' | MemoryType;
  tag: string;
  status: MemoryListStatus;
  text: string;
}
const NO_FILTERS: Filters = { type: '', tag: '', status: 'active', text: '' };

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string; session: boolean }
  | { status: 'ready'; items: MemoryDto[]; nextCursor: string | null };

function MemoriesPanel({ base, label, focusMemoryId }: { base: string; label: string; focusMemoryId: string | null }) {
  const memoriesBase = `${base}/memories`;
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [more, setMore] = useState<{ pending: boolean; error: string | null }>({ pending: false, error: null });
  const [tags, setTags] = useState<TagDto[]>([]);
  // A search link opens the Memory by id in this scope; it need not be on the loaded list page.
  const [selected, setSelected] = useState<string | null>(focusMemoryId);
  const [compose, setCompose] = useState<{ supersedes: string | null } | null>(null);
  const [created, setCreated] = useState<CreateMemoryResultDto | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const latest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const query = useCallback(
    (f: Filters, cursor: string | null) => {
      const p = new URLSearchParams();
      if (f.type) p.set('type', f.type);
      if (f.tag) p.set('tag', f.tag);
      p.set('status', f.status);
      if (f.text.trim()) p.set('text', f.text.trim());
      if (cursor) p.set('cursor', cursor);
      return `${memoriesBase}?${p.toString()}`;
    },
    [memoriesBase],
  );

  // Only the newest first-page request may write state; an unmounted panel (scope change) writes nothing.
  const loadFirst = useCallback(
    async (f: Filters) => {
      const id = ++latest.current;
      const current = () => mounted.current && id === latest.current;
      setList({ status: 'loading' });
      setMore({ pending: false, error: null });
      try {
        const res = await apiFetch(query(f, null));
        if (!current()) return;
        if (!res.ok) {
          const message = await errorText(res);
          if (current()) setList({ status: 'error', message, session: res.status === 401 });
          return;
        }
        const page = (await res.json()) as MemoryPageDto;
        if (current()) setList({ status: 'ready', items: page.items, nextCursor: page.hasMore ? page.nextCursor : null });
      } catch {
        if (current()) setList({ status: 'error', message: NETWORK, session: false });
      }
    },
    [query],
  );

  useEffect(() => {
    void loadFirst(applied);
  }, [applied, loadFirst]);
  const loadTags = useCallback(async () => {
    try {
      const res = await apiFetch(`${base}/tags`);
      if (mounted.current && res.ok) setTags((await res.json()) as TagDto[]);
    } catch {
      // Tags only feed the filter; the list still works without them.
    }
  }, [base]);
  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  // After a successful mutation the list and the tag filter are read again; the open detail keeps its own state.
  const refresh = useCallback(() => {
    void loadFirst(applied);
    void loadTags();
  }, [loadFirst, applied, loadTags]);

  function onCreateDone(r: MemoryFormResult) {
    if (r.kind !== 'created') return;
    setCompose(null);
    setFlash(null);
    setCreated(r.result);
    setSelected(r.result.id);
    refresh();
  }

  async function loadMore() {
    if (list.status !== 'ready' || !list.nextCursor || more.pending) return;
    const id = latest.current;
    const cursor = list.nextCursor;
    setMore({ pending: true, error: null });
    try {
      const res = await apiFetch(query(applied, cursor));
      if (!mounted.current || id !== latest.current) return;
      if (!res.ok) {
        const message = await errorText(res);
        if (mounted.current && id === latest.current) setMore({ pending: false, error: message });
        return;
      }
      const page = (await res.json()) as MemoryPageDto;
      if (!mounted.current || id !== latest.current) return;
      setList((l) =>
        l.status === 'ready'
          ? { status: 'ready', items: [...l.items, ...page.items.filter((n) => !l.items.some((o) => o.id === n.id))], nextCursor: page.hasMore ? page.nextCursor : null }
          : l,
      );
      setMore({ pending: false, error: null });
    } catch {
      if (mounted.current && id === latest.current) setMore({ pending: false, error: NETWORK });
    }
  }

  function applyFilters(e: FormEvent) {
    e.preventDefault();
    // New filters start from the first page; the cursor is never carried over.
    setSelected(null);
    setApplied({ ...draft });
  }
  function clearFilters() {
    setDraft(NO_FILTERS);
    setSelected(null);
    setApplied(NO_FILTERS);
  }

  const filtered = applied.type !== '' || applied.tag !== '' || applied.status !== 'active' || applied.text.trim() !== '';

  return (
    <section>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <h1 className="mb-4 text-2xl font-semibold tracking-tight break-words">Memories</h1>
      <p className="mb-3 text-muted-foreground">Persistent knowledge records, newest first. Superseded Memories are hidden unless you ask for them.</p>

      <div className="mb-3">
        <Button type="button" onClick={() => { setFlash(null); setCompose({ supersedes: null }); }}>
          New Memory
        </Button>
      </div>
      {flash && (
        <p role="status" className="mb-3">
          {flash}
        </p>
      )}
      {created && (
        <MemoryHints
          key={`hints-${created.id}`}
          base={memoriesBase}
          successorId={created.id}
          hints={created.hints}
          deduplicated={created.deduplicated}
          onSuperseded={refresh}
          onDismiss={() => setCreated(null)}
        />
      )}

      <form onSubmit={applyFilters} aria-label="Filter Memories" className="flex flex-row flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="filter-text">Text contains</Label>
          <Input id="filter-text" type="text" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="filter-type">Type</Label>
          <Select id="filter-type" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as Filters['type'] })}>
            <option value="">All types</option>
            {MEMORY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="filter-tag">Tag</Label>
          <Select id="filter-tag" value={draft.tag} onChange={(e) => setDraft({ ...draft, tag: e.target.value })}>
            <option value="">All tags</option>
            {tags.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="filter-status">Status</Label>
          <Select id="filter-status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as MemoryListStatus })}>
            {MEMORY_LIST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit">Apply filters</Button>{' '}
          <Button type="button" onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      </form>

      <h2 className="mt-6 mb-2 text-lg font-semibold break-words">All Memories</h2>
      {list.status === 'loading' && (
        <p role="status" aria-busy="true" className="text-muted-foreground">
          Loading Memories…
        </p>
      )}
      {list.status === 'error' && (
        <div>
          <p role="alert">{list.message}</p>
          {!list.session && (
            <Button type="button" onClick={() => void loadFirst(applied)}>
              Retry
            </Button>
          )}
        </div>
      )}
      {list.status === 'ready' && list.items.length === 0 && !filtered && <p className="text-muted-foreground">No Memories yet.</p>}
      {list.status === 'ready' && list.items.length === 0 && filtered && (
        <div>
          <p className="text-muted-foreground">No Memories match these filters.</p>
          <Button type="button" onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      )}
      {list.status === 'ready' && list.items.length > 0 && (
        <>
          <Table>
            <TableCaption className="sr-only">Memories in this scope, newest first</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Type</TableHead>
                <TableHead scope="col">Memory</TableHead>
                <TableHead scope="col">Tags</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Created by</TableHead>
                <TableHead scope="col">Embedding</TableHead>
                <TableHead scope="col">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.items.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <TypeBadge type={m.type} />
                  </TableCell>
                  <TableHead scope="row" className="max-w-md text-foreground">
                    <Button type="button" variant="link" size="sm" className="h-auto whitespace-normal px-0 text-left font-semibold" onClick={() => setSelected(m.id)}>
                      {m.title ?? 'Untitled'}
                      <span className="sr-only"> (open details)</span>
                    </Button>
                    <p className="font-normal text-muted-foreground break-words">{preview(m)}</p>
                  </TableHead>
                  <TableCell>{m.tags.length > 0 ? m.tags.join(', ') : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>
                    <MemoryStatusBadge status={m.status} />
                  </TableCell>
                  <TableCell className="break-words">{provenanceText(m)}</TableCell>
                  <TableCell>
                    <EmbeddingBadge status={m.embeddingStatus} />
                  </TableCell>
                  <TableCell>{formatDate(m.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {more.error && <p role="alert">{more.error}</p>}
          {list.nextCursor && (
            <Button type="button" onClick={() => void loadMore()} disabled={more.pending}>
              {more.pending ? 'Loading…' : more.error ? 'Retry loading more' : 'Load more'}
            </Button>
          )}
        </>
      )}

      {selected && (
        <MemoryDetail
          key={`detail-${selected}`}
          base={memoriesBase}
          memoryId={selected}
          onSelect={setSelected}
          onClose={() => setSelected(null)}
          onChanged={refresh}
          onForgotten={() => {
            setSelected(null);
            setFlash('Memory forgotten.');
            refresh();
          }}
          onReplace={(id) => setCompose({ supersedes: id })}
        />
      )}
      {compose && <MemoryForm base={memoriesBase} mode={{ kind: 'create', supersedes: compose.supersedes }} onDone={onCreateDone} onClose={() => setCompose(null)} />}
    </section>
  );
}
