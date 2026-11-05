'use client';

import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { Permission } from '@seshat/domain';
import { apiFetch } from '@/lib/api-client';
import type { ApiKeyDto, CreatedApiKeyDto, WorkspaceDto } from '@/lib/api-types';
import { readFormError, type FormError } from '@/lib/form-errors';
import { GLOBAL_OVERVIEW_PATH } from '@/lib/scope';
import { FormField } from './form-field';
import { PermissionPicker } from './permission-picker';
import { useWorkspaces } from './workspaces-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const networkError: FormError = { message: 'Could not reach the server. Check your connection and try again.', fields: {}, status: 0 };
const sessionError: FormError = { message: 'Your session has expired. Log in again to continue.', fields: {}, status: 401 };

function formatDate(value: string | null, empty: string): string {
  if (!value) return empty;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return empty;
  return `${d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`;
}

async function toError(res: Response): Promise<FormError> {
  return res.status === 401 ? sessionError : readFormError(res);
}

/** Workspace API keys. Resolves the slug to the Workspace id; there is no Global variant of this page. */
export function ApiKeysView({ slug }: { slug: string }) {
  const { state, reload } = useWorkspaces();
  if (state.status === 'loading') {
    return (
      <section aria-busy="true">
        <h1 className="mb-4 text-2xl font-semibold tracking-tight break-words">API Keys</h1>
        <p role="status" className="text-muted-foreground">
          Loading…
        </p>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section>
        <h1 className="mb-4 text-2xl font-semibold tracking-tight break-words">API Keys</h1>
        <p role="alert">Could not load Workspaces.</p>
        <Button type="button" onClick={reload}>
          Retry
        </Button>
      </section>
    );
  }
  const workspace = state.workspaces.find((w) => w.slug === slug);
  if (!workspace) {
    return (
      <section>
        <h1 className="mb-4 text-2xl font-semibold tracking-tight break-words">Workspace not found</h1>
        <p className="text-muted-foreground">This Workspace does not exist or is not available to you.</p>
        <Link href={GLOBAL_OVERVIEW_PATH} className="rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">Go to Global Overview</Link>
      </section>
    );
  }
  // Keyed by id: a different Workspace never inherits keys, forms or a visible secret.
  return <KeysPanel key={workspace.id} workspace={workspace} />;
}

type ListState = { status: 'loading' } | { status: 'error'; error: FormError } | { status: 'ready'; keys: ApiKeyDto[] };

function KeysPanel({ workspace }: { workspace: WorkspaceDto }) {
  const base = `/api/workspaces/${encodeURIComponent(workspace.id)}/api-keys`;
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [mode, setMode] = useState<'none' | 'create'>('none');
  const [editing, setEditing] = useState<ApiKeyDto | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyDto | null>(null);
  // The one-time secret lives only here, in memory. Unmounting the panel (navigation) discards it.
  const [created, setCreated] = useState<CreatedApiKeyDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(base);
      if (!res.ok) {
        setList({ status: 'error', error: await toError(res) });
        return;
      }
      setList({ status: 'ready', keys: (await res.json()) as ApiKeyDto[] });
    } catch {
      setList({ status: 'error', error: networkError });
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Workspace · {workspace.name}</p>
      <h1 className="mb-4 text-2xl font-semibold tracking-tight break-words">API Keys</h1>
      <p className="text-muted-foreground">
        Keys give agents access to this Workspace only, limited to the permissions you select.
      </p>

      {created && <SecretView created={created} onDismiss={() => setCreated(null)} />}
      {notice && (
        <p role="status" className="my-3 rounded-md border border-border bg-muted px-3 py-2 text-sm">
          {notice}
        </p>
      )}

      {mode === 'none' && !editing && (
        <Button type="button" onClick={() => { setMode('create'); setNotice(null); }}>
          Create API key
        </Button>
      )}
      {mode === 'create' && (
        <CreateForm
          base={base}
          onCancel={() => setMode('none')}
          onCreated={(c) => {
            setMode('none');
            setCreated(c);
            void load();
          }}
        />
      )}
      {editing && (
        <EditForm
          base={base}
          apiKey={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNotice('API key saved.');
            void load();
          }}
        />
      )}

      <h2 className="mt-6 mb-2 text-lg font-semibold break-words">Keys</h2>
      {list.status === 'loading' && (
        <p role="status" aria-busy="true" className="text-muted-foreground">
          Loading keys…
        </p>
      )}
      {list.status === 'error' && (
        <div>
          <p role="alert">{list.error.message}</p>
          {list.error.status !== 401 && (
            <Button type="button" onClick={() => { setList({ status: 'loading' }); void load(); }}>
              Retry
            </Button>
          )}
        </div>
      )}
      {list.status === 'ready' && list.keys.length === 0 && (
        <p className="text-muted-foreground">No API keys yet. Create one to give an agent access to this Workspace.</p>
      )}
      {list.status === 'ready' && list.keys.length > 0 && (
        <Table>
          <TableCaption className="sr-only">API keys of this Workspace</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Name</TableHead>
              <TableHead scope="col">Prefix</TableHead>
              <TableHead scope="col">Permissions</TableHead>
              <TableHead scope="col">Created</TableHead>
              <TableHead scope="col">Last used</TableHead>
              <TableHead scope="col">Expires</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.keys.map((k) => (
              <TableRow key={k.id}>
                <TableHead scope="row" className="text-foreground">{k.name}</TableHead>
                <TableCell>
                  <code>{k.prefix}</code>
                </TableCell>
                <TableCell>
                  {k.permissions.map((p) => (
                    <code key={p} className="mb-1 mr-1 inline-block rounded-md border border-border px-1 text-xs">
                      {p}
                    </code>
                  ))}
                </TableCell>
                <TableCell>{formatDate(k.createdAt, '—')}</TableCell>
                <TableCell>{formatDate(k.lastUsedAt, 'Never')}</TableCell>
                <TableCell>{formatDate(k.expiresAt, 'Never')}</TableCell>
                <TableCell>{k.status === 'active' ? 'Active' : k.status === 'revoked' ? 'Revoked' : 'Expired'}</TableCell>
                <TableCell>
                  {k.status === 'active' && (
                    <>
                      <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => { setEditing(k); setMode('none'); setNotice(null); }}>
                        Edit<span className="sr-only"> {k.name}</span>
                      </Button>{' '}
                      <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => setRevoking(k)}>
                        Revoke<span className="sr-only"> {k.name}</span>
                      </Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {revoking && (
        <RevokeDialog
          base={base}
          apiKey={revoking}
          onCancel={() => setRevoking(null)}
          onRevoked={() => {
            setRevoking(null);
            setNotice('API key revoked.');
            void load();
          }}
        />
      )}
    </section>
  );
}

/** Shown once after creation. Clipboard failures never expose the secret anywhere but this view. */
function SecretView({ created, onDismiss }: { created: CreatedApiKeyDto; onDismiss: () => void }) {
  const [copy, setCopy] = useState<'idle' | 'ok' | 'failed'>('idle');
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(created.secret);
      setCopy('ok');
    } catch {
      setCopy('failed');
    }
  }

  return (
    <section aria-labelledby="secret-title" className="my-4 flex min-w-0 flex-col gap-2 rounded-lg border border-primary p-4">
      <h2 className="mt-6 mb-2 text-lg font-semibold break-words" id="secret-title" tabIndex={-1} ref={headingRef}>
        Copy your API key now
      </h2>
      <p role="alert" className="m-0 text-warning">
        This is the only time the full key is shown. It cannot be shown again. Store it somewhere safe.
      </p>
      <p className="text-muted-foreground">
        Key “{created.apiKey.name}” was created.
      </p>
      <Label htmlFor="new-key-secret">API key</Label>
      <Input id="new-key-secret" className="font-mono" type="text" readOnly value={created.secret} autoComplete="off" spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={onCopy}>
          Copy key
        </Button>{' '}
        <Button type="button" onClick={onDismiss}>
          I have saved it
        </Button>
      </div>
      {copy === 'ok' && <p role="status">Copied to clipboard.</p>}
      {copy === 'failed' && (
        <p role="alert" className="text-sm text-destructive break-words">
          Could not copy automatically. Select the key above and copy it manually.
        </p>
      )}
    </section>
  );
}

function CreateForm({ base, onCancel, onCreated }: { base: string; onCancel: () => void; onCreated: (c: CreatedApiKeyDto) => void }) {
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('');
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const [local, setLocal] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const problems: Record<string, string> = {};
    if (!name.trim()) problems.name = 'Name must not be empty';
    if (permissions.length === 0) problems.permissions = 'Select at least one permission';
    let expiresAt: string | undefined;
    if (expiry) {
      const d = new Date(expiry);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) problems.expiresAt = 'Expiry must be in the future';
      else expiresAt = d.toISOString();
    }
    setLocal(problems);
    if (Object.keys(problems).length > 0) return;
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), permissions, ...(expiresAt ? { expiresAt } : {}) }),
      });
      if (!res.ok) {
        setError(await toError(res));
      } else {
        onCreated((await res.json()) as CreatedApiKeyDto);
        return;
      }
    } catch {
      setError(networkError);
    }
    setPending(false);
  }

  const fe = { ...(error?.fields ?? {}), ...local };
  return (
    <form onSubmit={onSubmit} aria-busy={pending} noValidate className="flex max-w-lg flex-col gap-3" aria-label="Create API key">
      <h2 className="mt-6 mb-2 text-lg font-semibold break-words">Create API key</h2>
      <FormField id="key-name" label="Name" error={fe.name}>
        {(p) => <Input {...p} type="text" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} disabled={pending} />}
      </FormField>
      <FormField id="key-expiry" label="Expiry (optional)" hint="Leave empty for a key that does not expire." error={fe.expiresAt}>
        {(p) => <Input {...p} type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={pending} />}
      </FormField>
      <PermissionPicker idPrefix="create" value={permissions} onChange={setPermissions} disabled={pending} error={fe.permissions} />
      {error && (
        <p role="alert" className="text-sm text-destructive break-words">
          {error.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create key'}
        </Button>{' '}
        <Button type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function EditForm({ base, apiKey, onCancel, onSaved }: { base: string; apiKey: ApiKeyDto; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(apiKey.name);
  const [permissions, setPermissions] = useState<Permission[]>(apiKey.permissions);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const [local, setLocal] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const problems: Record<string, string> = {};
    if (!name.trim()) problems.name = 'Name must not be empty';
    if (permissions.length === 0) problems.permissions = 'Select at least one permission';
    setLocal(problems);
    if (Object.keys(problems).length > 0) return;
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch(`${base}/${encodeURIComponent(apiKey.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), permissions }),
      });
      if (!res.ok) setError(await toError(res));
      else {
        onSaved();
        return;
      }
    } catch {
      setError(networkError);
    }
    setPending(false);
  }

  const fe = { ...(error?.fields ?? {}), ...local };
  return (
    <form onSubmit={onSubmit} aria-busy={pending} noValidate className="flex max-w-lg flex-col gap-3" aria-label="Edit API key">
      <h2 className="mt-6 mb-2 text-lg font-semibold break-words">Edit {apiKey.name}</h2>
      <FormField id="edit-name" label="Name" error={fe.name}>
        {(p) => <Input {...p} type="text" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} disabled={pending} />}
      </FormField>
      <PermissionPicker idPrefix="edit" value={permissions} onChange={setPermissions} disabled={pending} error={fe.permissions} />
      {error && (
        <p role="alert" className="text-sm text-destructive break-words">
          {error.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>{' '}
        <Button type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RevokeDialog({ base, apiKey, onCancel, onRevoked }: { base: string; apiKey: ApiKeyDto; onCancel: () => void; onRevoked: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch(`${base}/${encodeURIComponent(apiKey.id)}/revoke`, { method: 'POST' });
      if (!res.ok) setError(await toError(res));
      else {
        onRevoked();
        return;
      }
    } catch {
      setError(networkError);
    }
    setPending(false);
  }

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="revoke-title"
      aria-describedby="revoke-desc"
      className="fixed inset-0 z-50 m-auto flex h-fit w-[min(28rem,90vw)] flex-col gap-3 rounded-lg border border-border bg-popover p-5 text-popover-foreground"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !pending) onCancel();
      }}
    >
      <h2 className="mt-6 mb-2 text-lg font-semibold break-words" id="revoke-title">Revoke “{apiKey.name}”?</h2>
      <p id="revoke-desc">Any agent using this key loses access immediately. This cannot be undone.</p>
      {error && (
        <p role="alert" className="text-sm text-destructive break-words">
          {error.message}
        </p>
      )}
      <Button type="button" ref={cancelRef} onClick={onCancel} disabled={pending}>
        Cancel
      </Button>{' '}
      <Button type="button" variant="destructive" onClick={confirm} disabled={pending}>
        {pending ? 'Revoking…' : 'Revoke key'}
      </Button>
    </div>
  );
}
