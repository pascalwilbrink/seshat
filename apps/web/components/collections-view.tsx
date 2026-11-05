'use client';

import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { CollectionDto, WorkspaceDto } from '@/lib/api-types';
import { readFormError, type FormError } from '@/lib/form-errors';
import { GLOBAL_OVERVIEW_PATH, type Scope } from '@/lib/scope';
import { FormField } from './form-field';
import { useWorkspaces } from './workspaces-provider';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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
        <h1 className="mb-4 text-2xl font-semibold tracking-tight break-words">Collections</h1>
        <p role="status" className="text-muted-foreground">
          Loading…
        </p>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section>
        <h1 className="mb-4 text-2xl font-semibold tracking-tight break-words">Collections</h1>
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
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <h1 className="mb-4 text-2xl font-semibold tracking-tight break-words">Collections</h1>
      <p className="text-muted-foreground">Collections group files for browsing. They are optional and never grant access.</p>

      <div role="status" className="my-3 rounded-md border border-border bg-muted px-3 py-2 text-sm" hidden={!notice}>
        {notice}
      </div>

      {mode === 'none' && !editing && (
        <Button
          type="button"
          onClick={() => {
            setMode('create');
            setNotice(null);
          }}
        >
          Create Collection
        </Button>
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
              method: 'PUT',
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

      <h2 className="mt-6 mb-2 text-lg font-semibold break-words">All Collections</h2>
      {list.status === 'loading' && (
        <p role="status" aria-busy="true" className="text-muted-foreground">
          Loading Collections…
        </p>
      )}
      {list.status === 'error' && (
        <div>
          <p role="alert">{list.error.message}</p>
          {list.error.status !== 401 && (
            <Button
              type="button"
              onClick={() => {
                setList({ status: 'loading' });
                void load();
              }}
            >
              Retry
            </Button>
          )}
        </div>
      )}
      {list.status === 'ready' && list.items.length === 0 && (
        <p className="text-muted-foreground">No Collections yet. Create one to group related files.</p>
      )}
      {list.status === 'ready' && list.items.length > 0 && (
        <Table>
          <TableCaption className="sr-only">Collections in this scope</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Description</TableHead>
              <TableHead scope="col">Files</TableHead>
              <TableHead scope="col">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.items.map((c) => (
              <TableRow key={c.id}>
                <TableHead scope="row" className="text-foreground">{c.name}</TableHead>
                <TableCell>{c.description ?? <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell>{c.fileCount}</TableCell>
                <TableCell>
                  <Button
                    type="button"
                    variant="link" size="sm" className="h-auto px-0"
                    onClick={() => {
                      setEditing(c);
                      setMode('none');
                      setNotice(null);
                    }}
                  >
                    Rename<span className="sr-only"> {c.name}</span>
                  </Button>{' '}
                  <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => setDeleting(c)}>
                    Delete<span className="sr-only"> {c.name}</span>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
    <form onSubmit={onSubmit} aria-busy={pending} noValidate className="flex max-w-lg flex-col gap-3" aria-label={title}>
      <h2 className="mt-6 mb-2 text-lg font-semibold break-words">{title}</h2>
      <FormField id="collection-name" label="Name" error={fe.name}>
        {(p) => <Input {...p} type="text" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} disabled={pending} />}
      </FormField>
      <FormField id="collection-description" label="Description (optional)" error={fe.description}>
        {(p) => <Textarea {...p} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} disabled={pending} />}
      </FormField>
      {formLevel && (
        <p role="alert" className="text-sm text-destructive break-words">
          {formLevel}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>{' '}
        <Button type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
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
      className="fixed inset-0 z-50 m-auto flex h-fit w-[min(28rem,90vw)] flex-col gap-3 rounded-lg border border-border bg-popover p-5 text-popover-foreground"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !pending) onCancel();
      }}
    >
      <h2 className="mt-6 mb-2 text-lg font-semibold break-words" id="delete-collection-title">Delete “{collection.name}”?</h2>
      <p id="delete-collection-desc">
        The Collection is removed. Its files are kept and simply no longer belong to a Collection.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive break-words">
          {error.message}
        </p>
      )}
      <Button type="button" ref={cancelRef} onClick={onCancel} disabled={pending}>
        Cancel
      </Button>{' '}
      <Button type="button" variant="destructive" onClick={confirm} disabled={pending}>
        {pending ? 'Deleting…' : 'Delete Collection'}
      </Button>
    </div>
  );
}
