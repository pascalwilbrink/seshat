'use client';

import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { CollectionDto, WorkspaceDto } from '@/lib/api-types';
import { readFormError, type FormError } from '@/lib/form-errors';
import { GLOBAL_OVERVIEW_PATH, type Scope } from '@/lib/scope';
import { FormField } from './form-field';
import { useWorkspaces } from './workspaces-provider';

const networkError: FormError = { message: 'Could not reach the server. Check your connection and try again.', fields: {}, status: 0 };
const sessionError: FormError = { message: 'Your session has expired. Log in again to continue.', fields: {}, status: 401 };

async function toError(res: Response): Promise<FormError> {
  if (res.status === 401) return sessionError;
  const err = await readFormError(res);
  // A name conflict belongs to the name field.
  if (err.status === 409 && !err.fields.name) return { ...err, fields: { ...err.fields, name: err.message } };
  return err;
}

/** Collections of Global or one Workspace. Names and descriptions are untrusted text, rendered as text only. */
export function CollectionsView({ scope }: { scope: Scope }) {
  if (scope.kind === 'global') {
    return <CollectionsPanel key="global" base="/api/global/collections" label="Global" />;
  }
  return <WorkspaceCollections slug={scope.slug} />;
}

function WorkspaceCollections({ slug }: { slug: string }) {
  const { state, reload } = useWorkspaces();
  if (state.status === 'loading') {
    return (
      <section aria-busy="true">
        <h1>Collections</h1>
        <p role="status" className="muted">
          Loading…
        </p>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section>
        <h1>Collections</h1>
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
  // Keyed by id: another Workspace never inherits a list, a form or a notice.
  return (
    <CollectionsPanel
      key={workspace.id}
      base={`/api/workspaces/${encodeURIComponent(workspace.id)}/collections`}
      label={`Workspace · ${workspace.name}`}
    />
  );
}

type ListState = { status: 'loading' } | { status: 'error'; error: FormError } | { status: 'ready'; items: CollectionDto[] };

function CollectionsPanel({ base, label }: { base: string; label: string }) {
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [mode, setMode] = useState<'none' | 'create'>('none');
  const [editing, setEditing] = useState<CollectionDto | null>(null);
  const [deleting, setDeleting] = useState<CollectionDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Only the newest request may write state; an unmounted panel (scope change) writes nothing.
  const load = useCallback(async () => {
    const id = ++latest.current;
    const current = () => mounted.current && id === latest.current;
    try {
      const res = await apiFetch(base);
      if (!current()) return;
      if (!res.ok) {
        const error = await toError(res);
        if (current()) setList({ status: 'error', error });
        return;
      }
      const items = (await res.json()) as CollectionDto[];
      if (current()) setList({ status: 'ready', items });
    } catch {
      if (current()) setList({ status: 'error', error: networkError });
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const done = (message: string) => {
    if (!mounted.current) return;
    setNotice(message);
    void load();
  };

  return (
    <section>
      <p className="scope-label">{label}</p>
      <h1>Collections</h1>
      <p className="muted">Collections group files for browsing. They are optional and never grant access.</p>

      <div role="status" className="notice" hidden={!notice}>
        {notice}
      </div>

      {mode === 'none' && !editing && (
        <button
          type="button"
          onClick={() => {
            setMode('create');
            setNotice(null);
          }}
        >
          Create Collection
        </button>
      )}
      {mode === 'create' && (
        <CollectionForm
          key="create"
          title="Create Collection"
          submitLabel="Create"
          pendingLabel="Creating…"
          initial={{ name: '', description: '' }}
          send={(v) =>
            apiFetch(base, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: v.name, ...(v.description ? { description: v.description } : {}) }),
            })
          }
          onCancel={() => setMode('none')}
          onDone={(c) => {
            if (!mounted.current) return;
            setMode('none');
            done(`Collection “${c.name}” created.`);
          }}
        />
      )}
      {editing && (
        <CollectionForm
          key={editing.id}
          title={`Edit ${editing.name}`}
          submitLabel="Save changes"
          pendingLabel="Saving…"
          initial={{ name: editing.name, description: editing.description ?? '' }}
          send={(v) =>
            apiFetch(`${base}/${encodeURIComponent(editing.id)}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: v.name, description: v.description || null }),
            })
          }
          onCancel={() => setEditing(null)}
          onDone={(c) => {
            if (!mounted.current) return;
            setEditing(null);
            done(`Collection “${c.name}” saved.`);
          }}
        />
      )}

      <h2>All Collections</h2>
      {list.status === 'loading' && (
        <p role="status" aria-busy="true" className="muted">
          Loading Collections…
        </p>
      )}
      {list.status === 'error' && (
        <div>
          <p role="alert">{list.error.message}</p>
          {list.error.status !== 401 && (
            <button
              type="button"
              onClick={() => {
                setList({ status: 'loading' });
                void load();
              }}
            >
              Retry
            </button>
          )}
        </div>
      )}
      {list.status === 'ready' && list.items.length === 0 && (
        <p className="muted">No Collections yet. Create one to group related files.</p>
      )}
      {list.status === 'ready' && list.items.length > 0 && (
        <table className="keys">
          <caption className="sr-only">Collections in this scope</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Description</th>
              <th scope="col">Files</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((c) => (
              <tr key={c.id}>
                <th scope="row">{c.name}</th>
                <td>{c.description ?? <span className="muted">—</span>}</td>
                <td>{c.fileCount}</td>
                <td>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      setEditing(c);
                      setMode('none');
                      setNotice(null);
                    }}
                  >
                    Rename<span className="sr-only"> {c.name}</span>
                  </button>{' '}
                  <button type="button" className="link-button" onClick={() => setDeleting(c)}>
                    Delete<span className="sr-only"> {c.name}</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {deleting && (
        <DeleteDialog
          base={base}
          collection={deleting}
          onCancel={() => setDeleting(null)}
          onDeleted={() => {
            if (!mounted.current) return;
            const name = deleting.name;
            setDeleting(null);
            done(`Collection “${name}” deleted. Its files were kept.`);
          }}
        />
      )}
    </section>
  );
}

function CollectionForm({
  title,
  submitLabel,
  pendingLabel,
  initial,
  send,
  onCancel,
  onDone,
}: {
  title: string;
  submitLabel: string;
  pendingLabel: string;
  initial: { name: string; description: string };
  send: (v: { name: string; description: string }) => Promise<Response>;
  onCancel: () => void;
  onDone: (c: CollectionDto) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const [local, setLocal] = useState<Record<string, string>>({});
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const problems: Record<string, string> = {};
    if (!name.trim()) problems.name = 'Name must not be empty';
    setLocal(problems);
    if (Object.keys(problems).length > 0) return;
    setPending(true);
    setError(null);
    try {
      const res = await send({ name: name.trim(), description: description.trim() });
      if (res.ok) {
        onDone((await res.json()) as CollectionDto);
        return;
      }
      const err = await toError(res);
      if (alive.current) setError(err);
    } catch {
      if (alive.current) setError(networkError);
    }
    if (alive.current) setPending(false);
  }

  const fe = { ...(error?.fields ?? {}), ...local };
  const formLevel = error && Object.keys(error.fields).length === 0 ? error.message : null;
  return (
    <form onSubmit={onSubmit} aria-busy={pending} noValidate className="form" aria-label={title}>
      <h2>{title}</h2>
      <FormField id="collection-name" label="Name" error={fe.name}>
        {(p) => <input {...p} type="text" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} disabled={pending} />}
      </FormField>
      <FormField id="collection-description" label="Description (optional)" error={fe.description}>
        {(p) => <textarea {...p} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} disabled={pending} />}
      </FormField>
      {formLevel && (
        <p role="alert" className="field-error">
          {formLevel}
        </p>
      )}
      <div>
        <button type="submit" disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </button>{' '}
        <button type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DeleteDialog({
  base,
  collection,
  onCancel,
  onDeleted,
}: {
  base: string;
  collection: CollectionDto;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
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
      const res = await apiFetch(`${base}/${encodeURIComponent(collection.id)}`, { method: 'DELETE' });
      if (res.ok) {
        onDeleted();
        return;
      }
      const err = await toError(res);
      if (alive.current) setError(err);
    } catch {
      if (alive.current) setError(networkError);
    }
    if (alive.current) setPending(false);
  }

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-collection-title"
      aria-describedby="delete-collection-desc"
      className="dialog"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !pending) onCancel();
      }}
    >
      <h2 id="delete-collection-title">Delete “{collection.name}”?</h2>
      <p id="delete-collection-desc">
        The Collection is removed. Its files are kept and simply no longer belong to a Collection.
      </p>
      {error && (
        <p role="alert" className="field-error">
          {error.message}
        </p>
      )}
      <button type="button" ref={cancelRef} onClick={onCancel} disabled={pending}>
        Cancel
      </button>{' '}
      <button type="button" className="danger" onClick={confirm} disabled={pending}>
        {pending ? 'Deleting…' : 'Delete Collection'}
      </button>
    </div>
  );
}
