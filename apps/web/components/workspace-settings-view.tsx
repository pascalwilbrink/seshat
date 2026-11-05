'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-client';
import type { WorkspaceDto } from '@/lib/api-types';
import { readFormError, type FormError } from '@/lib/form-errors';
import { GLOBAL_OVERVIEW_PATH } from '@/lib/scope';
import { ConfirmDialog } from './confirm-dialog';
import { ErrorState } from './error-state';
import { FormField } from './form-field';
import { PageHeader } from './page-header';
import { useWorkspaces } from './workspaces-provider';

const NETWORK_MESSAGE = 'Could not reach the server. Check your connection and try again.';
const networkError: FormError = { message: NETWORK_MESSAGE, fields: {}, status: 0 };

function NotFound() {
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

/** Workspace Settings: rename (name, description) and hard delete. The slug is fixed and only shown. */
export function WorkspaceSettingsView({ slug }: { slug: string }) {
  const { state, reload } = useWorkspaces();
  const [deleted, setDeleted] = useState(false);

  if (deleted) {
    return (
      <section className="flex flex-col gap-6">
        <PageHeader title="Workspace deleted" />
        <p role="status" className="text-sm text-muted-foreground">
          Returning to Global…
        </p>
      </section>
    );
  }
  if (state.status === 'loading') {
    return (
      <section aria-busy="true" className="flex flex-col gap-6">
        <PageHeader title="Workspace Settings" />
        <p role="status" className="sr-only">
          Loading…
        </p>
        <Skeleton className="h-48 w-full max-w-xl" />
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="flex flex-col gap-6">
        <PageHeader title="Workspace Settings" />
        <ErrorState title="Could not load Workspaces" message="Check your connection and try again." retryLabel="Retry" onRetry={reload} />
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

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<FormError | null>(null);

  const base = `/api/workspaces/${encodeURIComponent(workspace.id)}`;

  async function onRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const data = new FormData(event.currentTarget);
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await apiFetch(base, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: String(data.get('name') ?? ''), description: String(data.get('description') ?? '') }),
      });
      if (res.status === 404) {
        toast.error('This Workspace no longer exists.');
        await refresh();
        setMissing(true);
      } else if (!res.ok) {
        const failure = await readFormError(res);
        setSaveError(failure);
        toast.error(failure.message);
      } else {
        await refresh();
        setSaved(true);
        toast.success('Workspace saved');
      }
    } catch {
      setSaveError(networkError);
      toast.error(NETWORK_MESSAGE);
    }
    setSaving(false);
  }

  async function onDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await apiFetch(base, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: workspace.slug }),
      });
      if (res.ok || res.status === 404) {
        toast.success('Workspace deleted');
        onDeleted();
        await refresh();
        router.replace(GLOBAL_OVERVIEW_PATH);
        return;
      }
      const failure = await readFormError(res);
      setDeleteError(failure);
      toast.error(failure.message);
    } catch {
      setDeleteError(networkError);
      toast.error(NETWORK_MESSAGE);
    }
    setDeleting(false);
  }

  function onConfirmOpenChange(open: boolean) {
    setConfirmOpen(open);
    if (!open) setDeleteError(null);
  }

  if (missing) return <NotFound />;

  const fe = saveError?.fields ?? {};
  return (
    <section className="flex flex-col gap-6">
      <PageHeader title="Workspace Settings" description={`Manage ${workspace.name}.`} />

      <div className="flex min-w-0 flex-col gap-3">
        <h2 className="text-lg font-semibold">General</h2>
        <Card className="min-w-0 max-w-xl p-4">
          <form onSubmit={onRename} aria-busy={saving} noValidate className="flex flex-col gap-4">
            <FormField id="ws-name" label="Name" error={fe.name}>
              {(p) => <Input {...p} name="name" type="text" required maxLength={100} defaultValue={workspace.name} disabled={saving} />}
            </FormField>
            <FormField id="ws-slug" label="Slug" hint="The slug is fixed and cannot be changed.">
              {(p) => <Input {...p} name="slug" type="text" value={workspace.slug} readOnly className="font-mono" />}
            </FormField>
            <FormField id="ws-description" label="Description" error={fe.description}>
              {(p) => <Textarea {...p} name="description" rows={3} maxLength={2000} defaultValue={workspace.description ?? ''} disabled={saving} />}
            </FormField>
            {saveError && (
              <p role="alert" className="text-sm text-destructive break-words">
                {saveError.message}
              </p>
            )}
            {saved && !saveError && (
              <p role="status" className="text-sm text-success">
                Workspace saved.
              </p>
            )}
            <div>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </form>
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <h2 className="text-lg font-semibold">Delete Workspace</h2>
        <Card className="min-w-0 max-w-xl border-destructive p-4">
          <div className="flex flex-col items-start gap-4">
            <p className="text-sm break-words">
              Deleting <strong>{workspace.name}</strong> is permanent and cannot be undone.
            </p>
            <Button type="button" variant="destructive" onClick={() => setConfirmOpen(true)}>
              Delete Workspace
            </Button>
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={onConfirmOpenChange}
        title="Delete Workspace"
        consequence={`This permanently deletes ${workspace.name} and everything in it, including its files, collections and tags. This cannot be undone.`}
        confirmSlug={workspace.slug}
        confirmLabel="Delete Workspace"
        onConfirm={onDelete}
        pending={deleting}
        error={deleteError?.message ?? null}
      />
    </section>
  );
}
