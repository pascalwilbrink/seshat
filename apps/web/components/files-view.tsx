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
import { FileDetail } from './file-detail';
import { FileUploader } from './file-uploader';
import { useWorkspaces } from './workspaces-provider';

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const SESSION = 'Your session has expired. Log in again to continue.';

async function errorText(res: Response): Promise<string> {
  if (res.status === 401) return SESSION;
  return (await readFormError(res)).message;
}

/** Files of Global or one Workspace. Names, tags and types are untrusted text; originals are only ever downloaded. */
export function FilesView({ scope }: { scope: Scope }) {
  if (scope.kind === 'global') return <FilesPanel key="global" base="/api/global" label="Global" />;
  return <WorkspaceFiles slug={scope.slug} />;
}

function WorkspaceFiles({ slug }: { slug: string }) {
  const { state, reload } = useWorkspaces();
  if (state.status === 'loading') {
    return (
      <section aria-busy="true">
        <h1>Files</h1>
        <p role="status" className="muted">
          Loading…
        </p>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section>
        <h1>Files</h1>
        <p role="alert">Could not load Workspaces.</p>
        <button type="button" onClick={reload}>
          Retry
        </button>
      </section>
    );
  }
  const workspace: WorkspaceDto | undefined = state.workspaces.find((w) => w.slug === slug);
  if (!workspace) {
    return (
      <section>
        <h1>Workspace not found</h1>
        <p className="muted">This Workspace does not exist or is not available to you.</p>
        <Link href={GLOBAL_OVERVIEW_PATH}>Go to Global Overview</Link>
      </section>
    );
  }
  // Keyed by id: another Workspace never inherits a list, an upload queue or an open panel.
  return <FilesPanel key={workspace.id} base={`/api/workspaces/${encodeURIComponent(workspace.id)}`} label={`Workspace · ${workspace.name}`} />;
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

function FilesPanel({ base, label }: { base: string; label: string }) {
  const filesBase = `${base}/files`;
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [more, setMore] = useState<{ pending: boolean; error: string | null }>({ pending: false, error: null });
  const [collections, setCollections] = useState<CollectionDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
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

  const refresh = () => {
    void loadFirst(applied, true);
    void loadOptions();
  };
  const filtered = Boolean(applied.collectionId || applied.tag || applied.status || applied.name.trim());
  const collectionName = (id: string | null) => (id ? (collections.find((c) => c.id === id)?.name ?? 'Unknown Collection') : null);
  const selectedFile = list.status === 'ready' ? (list.items.find((f) => f.id === selected) ?? null) : null;

  return (
    <section>
      <p className="scope-label">{label}</p>
      <h1>Files</h1>
      <p className="muted">Original files are stored as uploaded and can only be downloaded, never previewed here.</p>
      <div role="status" className="notice" hidden={!notice}>
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

      <form onSubmit={applyFilters} aria-label="Filter files" className="form filters">
        <div className="field">
          <label htmlFor="filter-name">Name contains</label>
          <input id="filter-name" type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="filter-collection">Collection</label>
          <select id="filter-collection" value={draft.collectionId} onChange={(e) => setDraft({ ...draft, collectionId: e.target.value })}>
            <option value="">All Collections</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-tag">Tag</label>
          <select id="filter-tag" value={draft.tag} onChange={(e) => setDraft({ ...draft, tag: e.target.value })}>
            <option value="">All tags</option>
            {tags.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-status">Status</label>
          <select id="filter-status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as Filters['status'] })}>
            <option value="">Any status</option>
            {INGESTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <button type="submit">Apply filters</button>{' '}
          <button type="button" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      </form>

      <h2>All files</h2>
      {list.status === 'loading' && (
        <p role="status" aria-busy="true" className="muted">
          Loading files…
        </p>
      )}
      {list.status === 'error' && (
        <div>
          <p role="alert">{list.message}</p>
          {!list.session && (
            <button type="button" onClick={() => void loadFirst(applied)}>
              Retry
            </button>
          )}
        </div>
      )}
      {list.status === 'ready' && list.items.length === 0 && !filtered && <p className="muted">No files yet. Upload one above.</p>}
      {list.status === 'ready' && list.items.length === 0 && filtered && (
        <div>
          <p className="muted">No files match these filters.</p>
          <button type="button" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      )}
      {list.status === 'ready' && list.items.length > 0 && (
        <>
          <table className="keys">
            <caption className="sr-only">Files in this scope</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Size</th>
                <th scope="col">Collection</th>
                <th scope="col">Tags</th>
                <th scope="col">Status</th>
                <th scope="col">Uploaded</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((f) => (
                <tr key={f.id}>
                  <th scope="row">{f.name}</th>
                  <td>{formatSize(f.sizeBytes)}</td>
                  <td>{collectionName(f.collectionId) ?? <span className="muted">—</span>}</td>
                  <td>{f.tags.length > 0 ? f.tags.join(', ') : <span className="muted">—</span>}</td>
                  <td>{f.ingestionStatus}</td>
                  <td>{formatDate(f.createdAt)}</td>
                  <td>
                    <a href={`${filesBase}/${encodeURIComponent(f.id)}/download`} download>
                      Download<span className="sr-only"> {f.name}</span>
                    </a>{' '}
                    <button type="button" className="link-button" onClick={() => setSelected(f.id)}>
                      Details<span className="sr-only"> {f.name}</span>
                    </button>{' '}
                    <button type="button" className="link-button" onClick={() => setDeleting(f)}>
                      Delete<span className="sr-only"> {f.name}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {more.error && <p role="alert">{more.error}</p>}
          {list.nextCursor && (
            <button type="button" onClick={() => void loadMore()} disabled={more.pending}>
              {more.pending ? 'Loading…' : more.error ? 'Retry loading more' : 'Load more'}
            </button>
          )}
        </>
      )}

      {selectedFile && (
        <FileDetail
          key={selectedFile.id}
          base={filesBase}
          file={selectedFile}
          collections={collections}
          onClose={() => setSelected(null)}
          onSaved={(next) => {
            if (!mounted.current) return;
            setList((l) => (l.status === 'ready' ? { ...l, items: l.items.map((i) => (i.id === next.id ? next : i)) } : l));
            refresh();
          }}
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
      className="dialog"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !pending) onCancel();
      }}
    >
      <h2 id="delete-file-title">Delete “{file.name}”?</h2>
      <p id="delete-file-desc">The file and its stored original are removed permanently.</p>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      <button type="button" ref={cancelRef} onClick={onCancel} disabled={pending}>
        Cancel
      </button>{' '}
      <button type="button" className="danger" onClick={confirm} disabled={pending}>
        {pending ? 'Deleting…' : 'Delete file'}
      </button>
    </div>
  );
}
