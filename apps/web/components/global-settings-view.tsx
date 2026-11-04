'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { WorkspaceDto } from '@/lib/api-types';
import { readFormError, type FormError } from '@/lib/form-errors';
import { scopeHref } from '@/lib/scope';
import { FormField } from './form-field';
import { useWorkspaces } from './workspaces-provider';

/** Global Settings: list and create Workspaces. Global itself has nothing to rename or delete. */
export function GlobalSettingsView() {
  const router = useRouter();
  const { state, reload, refresh } = useWorkspaces();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FormError | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
        setError(await readFormError(res));
        setPending(false);
        return;
      }
      const created = (await res.json()) as WorkspaceDto;
      await refresh();
      router.push(scopeHref({ kind: 'workspace', slug: created.slug }, 'overview'));
    } catch {
      setError({ message: 'Could not reach the server. Check your connection and try again.', fields: {}, status: 0 });
      setPending(false);
    }
  }

  const fe = error?.fields ?? {};
  const formLevel = error && error.status !== 409 ? error.message : null;
  // A slug collision (409) carries no field path: show it on the slug field.
  const slugError = fe.slug ?? (error?.status === 409 ? error.message : undefined);

  return (
    <section>
      <p className="scope-label">Global</p>
      <h1>Global Settings</h1>

      <h2>Workspaces</h2>
      {state.status === 'loading' && (
        <p role="status" className="muted">
          Loading Workspaces…
        </p>
      )}
      {state.status === 'error' && (
        <div>
          <p role="alert">Could not load Workspaces.</p>
          <button type="button" onClick={reload}>
            Retry
          </button>
        </div>
      )}
      {state.status === 'ready' && state.workspaces.length === 0 && <p className="muted">No Workspaces yet. Create your first Workspace below.</p>}
      {state.status === 'ready' && state.workspaces.length > 0 && (
        <ul aria-label="Workspaces" className="ws-list">
          {state.workspaces.map((w) => (
            <li key={w.id}>
              <Link href={scopeHref({ kind: 'workspace', slug: w.slug }, 'overview')}>{w.name}</Link>{' '}
              <code>{w.slug}</code>{' '}
              <Link href={scopeHref({ kind: 'workspace', slug: w.slug }, 'settings')} aria-label={`Settings for ${w.name}`}>
                Settings
              </Link>
            </li>
          ))}
        </ul>
      )}

      <h2>Create Workspace</h2>
      <form onSubmit={onSubmit} aria-busy={pending} noValidate className="form">
        <FormField id="ws-name" label="Name" error={fe.name}>
          {(p) => <input {...p} name="name" type="text" required maxLength={100} disabled={pending} />}
        </FormField>
        <FormField id="ws-slug" label="Slug (optional)" hint="Lowercase letters, numbers and hyphens. Derived from the name when empty. It cannot be changed later." error={slugError}>
          {(p) => <input {...p} name="slug" type="text" maxLength={100} autoCapitalize="none" spellCheck={false} disabled={pending} />}
        </FormField>
        <FormField id="ws-description" label="Description (optional)" error={fe.description}>
          {(p) => <textarea {...p} name="description" rows={3} maxLength={2000} disabled={pending} />}
        </FormField>
        {formLevel && (
          <p role="alert" className="field-error">
            {formLevel}
          </p>
        )}
        <button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create Workspace'}
        </button>
      </form>
    </section>
  );
}
