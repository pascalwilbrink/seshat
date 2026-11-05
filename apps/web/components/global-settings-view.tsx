'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Boxes } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-client';
import type { WorkspaceDto } from '@/lib/api-types';
import { readFormError, type FormError } from '@/lib/form-errors';
import { scopeHref } from '@/lib/scope';
import { EmptyState } from './empty-state';
import { ErrorState } from './error-state';
import { FormField } from './form-field';
import { PageHeader } from './page-header';
import { useWorkspaces } from './workspaces-provider';

const NETWORK_MESSAGE = 'Could not reach the server. Check your connection and try again.';

/** Global Settings: list and create Workspaces. Global itself has nothing to rename or delete. */
export function GlobalSettingsView() {
  const router = useRouter();
  const { state, reload, refresh } = useWorkspaces();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FormError | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const body: Record<string, string> = { name: String(data.get('name') ?? '') };
    const slug = String(data.get('slug') ?? '').trim();
    const description = String(data.get('description') ?? '');
    if (slug) body.slug = slug;
    if (description.trim()) body.description = description;
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch('/api/global/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const failure = await readFormError(res);
        setError(failure);
        toast.error(failure.message);
        setPending(false);
        return;
      }
      const created = (await res.json()) as WorkspaceDto;
      await refresh();
      toast.success(`Workspace "${created.name}" created`);
      router.push(scopeHref({ kind: 'workspace', slug: created.slug }, 'overview'));
    } catch {
      setError({ message: NETWORK_MESSAGE, fields: {}, status: 0 });
      toast.error(NETWORK_MESSAGE);
      setPending(false);
    }
  }

  const fe = error?.fields ?? {};
  const formLevel = error && error.status !== 409 ? error.message : null;
  // A slug collision (409) carries no field path: show it on the slug field.
  const slugError = fe.slug ?? (error?.status === 409 ? error.message : undefined);

  return (
    <section className="flex flex-col gap-6">
      <PageHeader title="Global Settings" description="Create and open the Workspaces available to you." />

      <div className="flex min-w-0 flex-col gap-3">
        <h2 className="text-lg font-semibold">Workspaces</h2>
        {state.status === 'loading' && (
          <div aria-busy="true" className="flex flex-col gap-2">
            <p role="status" className="sr-only">
              Loading Workspaces…
            </p>
            <Skeleton className="h-10 w-full max-w-md" />
            <Skeleton className="h-10 w-full max-w-md" />
          </div>
        )}
        {state.status === 'error' && <ErrorState title="Could not load Workspaces" message="Check your connection and try again." retryLabel="Retry" onRetry={reload} />}
        {state.status === 'ready' && state.workspaces.length === 0 && (
          <EmptyState title="No Workspaces yet" description="Create your first Workspace below." icon={Boxes} />
        )}
        {state.status === 'ready' && state.workspaces.length > 0 && (
          <Card className="min-w-0 p-2">
            <ul aria-label="Workspaces" className="flex flex-col divide-y divide-border">
              {state.workspaces.map((w) => (
                <li key={w.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2 text-sm">
                  <Link
                    href={scopeHref({ kind: 'workspace', slug: w.slug }, 'overview')}
                    className="min-w-0 break-words font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {w.name}
                  </Link>
                  <code className="min-w-0 break-all font-mono text-muted-foreground">{w.slug}</code>
                  <Link
                    href={scopeHref({ kind: 'workspace', slug: w.slug }, 'settings')}
                    aria-label={`Settings for ${w.name}`}
                    className="ml-auto text-muted-foreground underline-offset-4 hover:underline"
                  >
                    Settings
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <h2 id="create-workspace" tabIndex={-1} className="scroll-mt-4 text-lg font-semibold focus-visible:outline-2 focus-visible:outline-ring">
          Create Workspace
        </h2>
        <Card className="min-w-0 max-w-xl p-4">
          <form onSubmit={onSubmit} aria-busy={pending} noValidate className="flex flex-col gap-4">
            <FormField id="ws-name" label="Name" error={fe.name}>
              {(p) => <Input {...p} name="name" type="text" required maxLength={100} disabled={pending} />}
            </FormField>
            <FormField
              id="ws-slug"
              label="Slug (optional)"
              hint="Lowercase letters, numbers and hyphens. Derived from the name when empty. It cannot be changed later."
              error={slugError}
            >
              {(p) => <Input {...p} name="slug" type="text" maxLength={100} autoCapitalize="none" spellCheck={false} disabled={pending} />}
            </FormField>
            <FormField id="ws-description" label="Description (optional)" error={fe.description}>
              {(p) => <Textarea {...p} name="description" rows={3} maxLength={2000} disabled={pending} />}
            </FormField>
            {formLevel && (
              <p role="alert" className="text-sm text-destructive break-words">
                {formLevel}
              </p>
            )}
            <div>
              <Button type="submit" disabled={pending}>
                {pending ? 'Creating…' : 'Create Workspace'}
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </section>
  );
}
