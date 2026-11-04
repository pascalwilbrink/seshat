'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { WorkspaceDto } from '@/lib/api-types';
import { readFormError, type FormError } from '@/lib/form-errors';
import { GLOBAL_OVERVIEW_PATH } from '@/lib/scope';
import { FormField } from './form-field';
import { useWorkspaces } from './workspaces-provider';

const networkError: FormError = { message: 'Could not reach the server. Check your connection and try again.', fields: {}, status: 0 };

function NotFound() {
  return (
    <section>
      <h1>Workspace not found</h1>
      <p className="muted">This Workspace does not exist or is not available to you.</p>
      <Link href={GLOBAL_OVERVIEW_PATH}>Go to Global Overview</Link>
    </section>
  );
}

/** Workspace Settings: rename (name, description) and hard delete. The slug is fixed and only shown. */
export function WorkspaceSettingsView({ slug }: { slug: string }) {
  const { state, reload } = useWorkspaces();
  const [deleted, setDeleted] = useState(false);

  if (deleted) {
    return (
      <section>
        <h1>Workspace deleted</h1>
        <p role="status" className="muted">
          Returning to Global…
        </p>
      </section>
    );
  }
  if (state.status === 'loading') {
    return (
      <section aria-busy="true">
        <h1>Workspace Settings</h1>
        <p role="status" className="muted">
          Loading…
        </p>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section>
        <h1>Workspace Settings</h1>
        <p role="alert">Could not load Workspaces.</p>
        <button type="button" onClick={reload}>
          Retry
        </button>
      </section>
    );
  }
  const workspace = state.workspaces.find((w) => w.slug === slug);
  if (!workspace) return <NotFound />;
  // Keyed by id so a different Workspace never inherits form state.
  return <Loaded key={workspace.id} workspace={workspace} onDeleted={() => setDeleted(true)} />;
}

function Loaded({ workspace, onDeleted }: { workspace: WorkspaceDto; onDeleted: () => void }) {
  const router = useRouter();
  const { refresh } = useWorkspaces();

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<FormError | null>(null);
  const [saved, setSaved] = useState(false);
  const [missing, setMissing] = useState(false);

  const [confirm, setConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<FormError | null>(null);

  const base = `/api/workspaces/${encodeURIComponent(workspace.id)}`;

  async function onRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await apiFetch(base, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: String(data.get('name') ?? ''), description: String(data.get('description') ?? '') }),
      });
      if (res.status === 404) {
        await refresh();
        setMissing(true);
      } else if (!res.ok) {
        setSaveError(await readFormError(res));
      } else {
        await refresh();
        setSaved(true);
      }
    } catch {
      setSaveError(networkError);
    }
    setSaving(false);
  }

  async function onDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirm !== workspace.slug) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await apiFetch(base, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: confirm }),
      });
      if (res.ok || res.status === 404) {
        onDeleted();
        await refresh();
        router.replace(GLOBAL_OVERVIEW_PATH);
        return;
      }
      setDeleteError(await readFormError(res));
    } catch {
      setDeleteError(networkError);
    }
    setDeleting(false);
  }

  if (missing) return <NotFound />;

  const fe = saveError?.fields ?? {};
  const mismatch = confirm !== '' && confirm !== workspace.slug;
  return (
    <section>
      <p className="scope-label">Workspace</p>
      <h1>Workspace Settings</h1>

      <h2>General</h2>
      <form onSubmit={onRename} aria-busy={saving} noValidate className="form">
        <FormField id="ws-name" label="Name" error={fe.name}>
          {(p) => <input {...p} name="name" type="text" required maxLength={100} defaultValue={workspace.name} disabled={saving} />}
        </FormField>
        <FormField id="ws-slug" label="Slug" hint="The slug is fixed and cannot be changed.">
          {(p) => <input {...p} name="slug" type="text" value={workspace.slug} readOnly />}
        </FormField>
        <FormField id="ws-description" label="Description" error={fe.description}>
          {(p) => <textarea {...p} name="description" rows={3} maxLength={2000} defaultValue={workspace.description ?? ''} disabled={saving} />}
        </FormField>
        {saveError && (
          <p role="alert" className="field-error">
            {saveError.message}
          </p>
        )}
        {saved && !saveError && <p role="status">Workspace saved.</p>}
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </form>

      <h2>Delete Workspace</h2>
      <form onSubmit={onDelete} aria-busy={deleting} noValidate className="form danger-zone">
        <p>
          Deleting <strong>{workspace.name}</strong> is permanent and cannot be undone.
        </p>
        <FormField
          id="ws-confirm"
          label={`Type the slug "${workspace.slug}" to confirm deletion`}
          error={mismatch ? 'The slug does not match.' : undefined}
        >
          {(p) => (
            <input
              {...p}
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={deleting}
            />
          )}
        </FormField>
        {deleteError && (
          <p role="alert" className="field-error">
            {deleteError.message}
          </p>
        )}
        <button type="submit" className="danger" disabled={deleting || confirm !== workspace.slug}>
          {deleting ? 'Deleting…' : 'Delete Workspace'}
        </button>
      </form>
    </section>
  );
}
