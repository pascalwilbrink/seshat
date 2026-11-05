'use client';

import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import {
  INGESTION_STATUSES,
  type CollectionDto,
  type FileDto,
  type FilePageDto,
  type IngestionStatus,
  type TagDto,
  type WorkspaceDto,
} from '@/lib/api-types';
import { formatDate, formatSize } from '@/lib/files';
import { readFormError } from '@/lib/form-errors';
import { GLOBAL_OVERVIEW_PATH, type Scope } from '@/lib/scope';
import type { FileFocus } from '@/lib/search';
import { FileDetail } from './file-detail';
import { ReindexButton } from './reindex-button';
import { StatusBadge } from './status-badge';
import { FileUploader } from './file-uploader';
import { useWorkspaces } from './workspaces-provider';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const SESSION = 'Your session has expired. Log in again to continue.';
/** How often files that are pending or processing are re-read. */
export const POLL_INTERVAL_MS = 3000;
const POLL_MAX_FILES = 25;

async function errorText(res: Response): Promise<string> {
  if (res.status === 401) return SESSION;
  return (await readFormError(res)).message;
}

/** Files of Global or one Workspace. Names, tags and types are untrusted text; originals are only ever downloaded. */
export function FilesView({ scope, focus = null }: { scope: Scope; focus?: FileFocus | null }) {
  if (scope.kind === 'global') return <FilesPanel key={`global|${focusKey(focus)}`} base="/api/global" label="Global" focus={focus} />;
  return <WorkspaceFiles slug={scope.slug} focus={focus} />;
}

/** A search link opens one file (and chunk): each distinct target starts a fresh panel with that file selected. */
const focusKey = (f: FileFocus | null) => (f ? `${f.fileId}|${f.chunkId ?? ''}|${f.ordinal ?? ''}` : '');

function WorkspaceFiles({ slug, focus }: { slug: string; focus: FileFocus | null }) {
  const { state, reload } = useWorkspaces();
  if (state.status === 'loading') {
    return (
      <section aria-busy="true">
        <h1 className="mb-4 text-2xl font-semibold tracking-tight break-words">Files</h1>
        <p role="status" className="text-muted-foreground">
          Loading…
        </p>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section>
        <h1 className="mb-4 text-2xl font-semibold tracking-tight break-words">Files</h1>
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
  // Keyed by id: another Workspace never inherits a list, an upload queue or an open panel.
  return <FilesPanel key={`${workspace.id}|${focusKey(focus)}`} base={`/api/workspaces/${encodeURIComponent(workspace.id)}`} label={`Workspace · ${workspace.name}`} focus={focus} />;
}

interface Filters {
  collectionId: string;
  tag: string;
  status: '' | IngestionStatus;
  name: string;
}
const NO_FILTERS: Filters = { collectionId: '', tag: '', status: '', name: '' };

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string; session: boolean }
  | { status: 'ready'; items: FileDto[]; nextCursor: string | null };

function FilesPanel({ base, label, focus }: { base: string; label: string; focus: FileFocus | null }) {
  const filesBase = `${base}/files`;
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [more, setMore] = useState<{ pending: boolean; error: string | null }>({ pending: false, error: null });
  const [collections, setCollections] = useState<CollectionDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [selected, setSelected] = useState<string | null>(focus?.fileId ?? null);
  // The file a search result points at may not be on the loaded page; it is read by id from this scope only.
  const [focusedFile, setFocusedFile] = useState<FileDto | null>(null);
  const [deleting, setDeleting] = useState<FileDto | null>(null);
  const [notice, setNotice] = useState('');
  const latest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const query = useCallback((f: Filters, cursor: string | null) => {
    const p = new URLSearchParams();
    if (f.collectionId) p.set('collectionId', f.collectionId);
    if (f.tag) p.set('tag', f.tag);
    if (f.status) p.set('status', f.status);
    if (f.name.trim()) p.set('name', f.name.trim());
    if (cursor) p.set('cursor', cursor);
    const s = p.toString();
    return s ? `${filesBase}?${s}` : filesBase;
  }, [filesBase]);

  // Only the newest first-page request may write state; an unmounted panel (scope change) writes nothing.
  const loadFirst = useCallback(
    async (f: Filters, silent = false) => {
      const id = ++latest.current;
      const current = () => mounted.current && id === latest.current;
      if (!silent) setList({ status: 'loading' });
      setMore({ pending: false, error: null });
      try {
        const res = await apiFetch(query(f, null));
        if (!current()) return;
        if (!res.ok) {
          const message = await errorText(res);
          if (current()) setList({ status: 'error', message, session: res.status === 401 });
          return;
        }
        const page = (await res.json()) as FilePageDto;
        if (current()) setList({ status: 'ready', items: page.items, nextCursor: page.hasMore ? page.nextCursor : null });
      } catch {
        if (current()) setList({ status: 'error', message: NETWORK, session: false });
      }
    },
    [query],
  );

  const loadOptions = useCallback(async () => {
    try {
      const [c, t] = await Promise.all([apiFetch(`${base}/collections`), apiFetch(`${base}/tags`)]);
      if (!mounted.current) return;
      if (c.ok) setCollections((await c.json()) as CollectionDto[]);
      if (t.ok) setTags((await t.json()) as TagDto[]);
    } catch {
      // Options are a convenience; filters and forms still work without them.
    }
  }, [base]);

  useEffect(() => {
    void loadFirst(applied);
  }, [applied, loadFirst]);
  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);
  const focusFileId = focus?.fileId;
  useEffect(() => {
    if (!focusFileId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(`${filesBase}/${encodeURIComponent(focusFileId)}`);
        if (cancelled || !mounted.current) return;
        if (res.ok) setFocusedFile((await res.json()) as FileDto);
        else setNotice(res.status === 404 ? 'The file you opened no longer exists or is not available here.' : await errorText(res));
      } catch {
        if (!cancelled && mounted.current) setNotice(NETWORK);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [focusFileId, filesBase]);

  // Poll only the visible files that are still pending or processing. Each tick re-reads those files one by one and
  // merges them into the loaded list (pages and filters stay as they are). The loop ends, and its timer and any
  // in-flight result are dropped, when nothing is active any more, the scope changes or the panel unmounts.
  const activeIds = list.status === 'ready' ? list.items.filter((f) => f.ingestionStatus === 'pending' || f.ingestionStatus === 'processing').map((f) => f.id) : [];
  const activeKey = activeIds.join('|');
  useEffect(() => {
    if (!activeKey) return;
    const ids = activeKey.split('|').slice(0, POLL_MAX_FILES);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      timer = setTimeout(async () => {
        const results = await Promise.all(
          ids.map(async (id): Promise<FileDto | 'session' | null> => {
            try {
              const res = await apiFetch(`${filesBase}/${encodeURIComponent(id)}`);
              if (res.status === 401) return 'session';
              return res.ok ? ((await res.json()) as FileDto) : null;
            } catch {
              return null; // Network or authorization trouble: keep the last known state and try again.
            }
          }),
        );
        if (cancelled || !mounted.current) return;
        if (results.includes('session')) {
          setNotice(SESSION);
          return;
        }
        const fresh = new Map(results.filter((r): r is FileDto => r !== null && r !== 'session').map((f) => [f.id, f]));
        if (fresh.size > 0) setList((l) => (l.status === 'ready' ? { ...l, items: l.items.map((i) => fresh.get(i.id) ?? i) } : l));
        tick();
      }, POLL_INTERVAL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeKey, filesBase]);

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
      const page = (await res.json()) as FilePageDto;
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

  const updateFile = (next: FileDto) => {
    if (!mounted.current) return;
    setList((l) => (l.status === 'ready' ? { ...l, items: l.items.map((i) => (i.id === next.id ? next : i)) } : l));
    setFocusedFile((c) => (c && c.id === next.id ? next : c));
  };
  const refresh = () => {
    void loadFirst(applied, true);
    void loadOptions();
  };
  const filtered = Boolean(applied.collectionId || applied.tag || applied.status || applied.name.trim());
  const collectionName = (id: string | null) => (id ? (collections.find((c) => c.id === id)?.name ?? 'Unknown Collection') : null);
  const selectedFile = (list.status === 'ready' ? list.items.find((f) => f.id === selected) : undefined) ?? (focusedFile && focusedFile.id === selected ? focusedFile : null);

  return (
    <section>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <h1 className="mb-4 text-2xl font-semibold tracking-tight break-words">Files</h1>
      <p className="text-muted-foreground">Original files are stored as uploaded and can only be downloaded, never previewed here.</p>
      <div role="status" className="my-3 rounded-md border border-border bg-muted px-3 py-2 text-sm" hidden={!notice}>
        {notice}
      </div>

      <FileUploader
        base={filesBase}
        collections={collections}
        onUploaded={(f) => {
          if (!mounted.current) return;
          setNotice(`“${f.name}” uploaded.`);
          refresh();
        }}
      />

      <form onSubmit={applyFilters} aria-label="Filter files" className="flex flex-row flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="filter-name">Name contains</Label>
          <Input id="filter-name" type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="filter-collection">Collection</Label>
          <Select id="filter-collection" value={draft.collectionId} onChange={(e) => setDraft({ ...draft, collectionId: e.target.value })}>
            <option value="">All Collections</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
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
          <Select id="filter-status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as Filters['status'] })}>
            <option value="">Any status</option>
            {INGESTION_STATUSES.map((s) => (
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

      <h2 className="mt-6 mb-2 text-lg font-semibold break-words">All files</h2>
      {list.status === 'loading' && (
        <p role="status" aria-busy="true" className="text-muted-foreground">
          Loading files…
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
      {list.status === 'ready' && list.items.length === 0 && !filtered && <p className="text-muted-foreground">No files yet. Upload one above.</p>}
      {list.status === 'ready' && list.items.length === 0 && filtered && (
        <div>
          <p className="text-muted-foreground">No files match these filters.</p>
          <Button type="button" onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      )}
      {list.status === 'ready' && list.items.length > 0 && (
        <>
          <Table>
            <TableCaption className="sr-only">Files in this scope</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Name</TableHead>
                <TableHead scope="col">Size</TableHead>
                <TableHead scope="col">Collection</TableHead>
                <TableHead scope="col">Tags</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Uploaded</TableHead>
                <TableHead scope="col">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.items.map((f) => (
                <TableRow key={f.id}>
                  <TableHead scope="row" className="text-foreground">{f.name}</TableHead>
                  <TableCell>{formatSize(f.sizeBytes)}</TableCell>
                  <TableCell>{collectionName(f.collectionId) ?? <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>{f.tags.length > 0 ? f.tags.join(', ') : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>
                    <StatusBadge status={f.ingestionStatus} />
                    {f.ingestionStatus === 'failed' && (
                      <>
                        <p className="mt-1 text-sm text-destructive break-words">{f.ingestionError ?? 'Indexing failed.'}</p>
                        <ReindexButton base={filesBase} file={f} onQueued={updateFile} />
                      </>
                    )}
                  </TableCell>
                  <TableCell>{formatDate(f.createdAt)}</TableCell>
                  <TableCell>
                    <a className="rounded-sm text-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-ring" href={`${filesBase}/${encodeURIComponent(f.id)}/download`} download>
                      Download<span className="sr-only"> {f.name}</span>
                    </a>{' '}
                    <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => setSelected(f.id)}>
                      Details<span className="sr-only"> {f.name}</span>
                    </Button>{' '}
                    <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => setDeleting(f)}>
                      Delete<span className="sr-only"> {f.name}</span>
                    </Button>
                  </TableCell>
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

      {selectedFile && (
        <FileDetail
          key={selectedFile.id}
          base={filesBase}
          file={selectedFile}
          focusChunk={focus && focus.fileId === selectedFile.id ? { chunkId: focus.chunkId, ordinal: focus.ordinal } : null}
          collections={collections}
          onClose={() => setSelected(null)}
          onSaved={(next) => {
            updateFile(next);
            refresh();
          }}
          onReindexed={updateFile}
        />
      )}
      {deleting && (
        <DeleteDialog
          base={filesBase}
          file={deleting}
          onCancel={() => setDeleting(null)}
          onDeleted={() => {
            if (!mounted.current) return;
            const name = deleting.name;
            if (selected === deleting.id) setSelected(null);
            setDeleting(null);
            setNotice(`“${name}” deleted.`);
            refresh();
          }}
        />
      )}
    </section>
  );
}

function DeleteDialog({ base, file, onCancel, onDeleted }: { base: string; file: FileDto; onCancel: () => void; onDeleted: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    cancelRef.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch(`${base}/${encodeURIComponent(file.id)}`, { method: 'DELETE' });
      if (res.ok || res.status === 404) {
        onDeleted();
        return;
      }
      const message = await errorText(res);
      if (alive.current) setError(message);
    } catch {
      if (alive.current) setError(NETWORK);
    }
    if (alive.current) setPending(false);
  }

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-file-title"
      aria-describedby="delete-file-desc"
      className="fixed inset-0 z-50 m-auto flex h-fit w-[min(28rem,90vw)] flex-col gap-3 rounded-lg border border-border bg-popover p-5 text-popover-foreground"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !pending) onCancel();
      }}
    >
      <h2 className="mt-6 mb-2 text-lg font-semibold break-words" id="delete-file-title">Delete “{file.name}”?</h2>
      <p id="delete-file-desc">The file and its stored original are removed permanently.</p>
      {error && (
        <p role="alert" className="text-sm text-destructive break-words">
          {error}
        </p>
      )}
      <Button type="button" ref={cancelRef} onClick={onCancel} disabled={pending}>
        Cancel
      </Button>{' '}
      <Button type="button" variant="destructive" onClick={confirm} disabled={pending}>
        {pending ? 'Deleting…' : 'Delete file'}
      </Button>
    </div>
  );
}
