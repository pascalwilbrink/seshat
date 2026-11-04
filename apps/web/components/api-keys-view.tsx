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
        <h1>API Keys</h1>
        <p role="status" className="muted">
          Loading…
        </p>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section>
        <h1>API Keys</h1>
        <p role="alert">Could not load Workspaces.</p>
        <button type="button" onClick={reload}>
          Retry
        </button>
      </section>
    );
  }
  const workspace = state.workspaces.find((w) => w.slug === slug);
  if (!workspace) {
    return (
      <section>
        <h1>Workspace not found</h1>
        <p className="muted">This Workspace does not exist or is not available to you.</p>
        <Link href={GLOBAL_OVERVIEW_PATH}>Go to Global Overview</Link>
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
      <p className="scope-label">Workspace · {workspace.name}</p>
      <h1>API Keys</h1>
      <p className="muted">
        Keys give agents access to this Workspace only, limited to the permissions you select.
      </p>

      {created && <SecretView created={created} onDismiss={() => setCreated(null)} />}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}

      {mode === 'none' && !editing && (
        <button type="button" onClick={() => { setMode('create'); setNotice(null); }}>
          Create API key
        </button>
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

      <h2>Keys</h2>
      {list.status === 'loading' && (
        <p role="status" aria-busy="true" className="muted">
          Loading keys…
        </p>
      )}
      {list.status === 'error' && (
        <div>
          <p role="alert">{list.error.message}</p>
          {list.error.status !== 401 && (
            <button type="button" onClick={() => { setList({ status: 'loading' }); void load(); }}>
              Retry
            </button>
          )}
        </div>
      )}
      {list.status === 'ready' && list.keys.length === 0 && (
        <p className="muted">No API keys yet. Create one to give an agent access to this Workspace.</p>
      )}
      {list.status === 'ready' && list.keys.length > 0 && (
        <table className="keys">
          <caption className="sr-only">API keys of this Workspace</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Prefix</th>
              <th scope="col">Permissions</th>
              <th scope="col">Created</th>
              <th scope="col">Last used</th>
              <th scope="col">Expires</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.keys.map((k) => (
              <tr key={k.id}>
                <th scope="row">{k.name}</th>
                <td>
                  <code>{k.prefix}</code>
                </td>
                <td>
                  {k.permissions.map((p) => (
                    <code key={p} className="perm-chip">
                      {p}
                    </code>
                  ))}
                </td>
                <td>{formatDate(k.createdAt, '—')}</td>
                <td>{formatDate(k.lastUsedAt, 'Never')}</td>
                <td>{formatDate(k.expiresAt, 'Never')}</td>
                <td>{k.status === 'active' ? 'Active' : k.status === 'revoked' ? 'Revoked' : 'Expired'}</td>
                <td>
                  {k.status === 'active' && (
                    <>
                      <button type="button" className="link-button" onClick={() => { setEditing(k); setMode('none'); setNotice(null); }}>
                        Edit<span className="sr-only"> {k.name}</span>
                      </button>{' '}
                      <button type="button" className="link-button" onClick={() => setRevoking(k)}>
                        Revoke<span className="sr-only"> {k.name}</span>
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
    <section aria-labelledby="secret-title" className="secret">
      <h2 id="secret-title" tabIndex={-1} ref={headingRef}>
        Copy your API key now
      </h2>
      <p role="alert" className="warning">
        This is the only time the full key is shown. It cannot be shown again. Store it somewhere safe.
      </p>
      <p className="muted">
        Key “{created.apiKey.name}” was created.
      </p>
      <label htmlFor="new-key-secret">API key</label>
      <input id="new-key-secret" type="text" readOnly value={created.secret} autoComplete="off" spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
      <div>
        <button type="button" onClick={onCopy}>
          Copy key
        </button>{' '}
        <button type="button" onClick={onDismiss}>
          I have saved it
        </button>
      </div>
      {copy === 'ok' && <p role="status">Copied to clipboard.</p>}
      {copy === 'failed' && (
        <p role="alert" className="field-error">
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
    <form onSubmit={onSubmit} aria-busy={pending} noValidate className="form" aria-label="Create API key">
      <h2>Create API key</h2>
      <FormField id="key-name" label="Name" error={fe.name}>
        {(p) => <input {...p} type="text" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} disabled={pending} />}
      </FormField>
      <FormField id="key-expiry" label="Expiry (optional)" hint="Leave empty for a key that does not expire." error={fe.expiresAt}>
        {(p) => <input {...p} type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={pending} />}
      </FormField>
      <PermissionPicker idPrefix="create" value={permissions} onChange={setPermissions} disabled={pending} error={fe.permissions} />
      {error && (
        <p role="alert" className="field-error">
          {error.message}
        </p>
      )}
      <div>
        <button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create key'}
        </button>{' '}
        <button type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
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
        method: 'PATCH',
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
    <form onSubmit={onSubmit} aria-busy={pending} noValidate className="form" aria-label="Edit API key">
      <h2>Edit {apiKey.name}</h2>
      <FormField id="edit-name" label="Name" error={fe.name}>
        {(p) => <input {...p} type="text" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} disabled={pending} />}
      </FormField>
      <PermissionPicker idPrefix="edit" value={permissions} onChange={setPermissions} disabled={pending} error={fe.permissions} />
      {error && (
        <p role="alert" className="field-error">
          {error.message}
        </p>
      )}
      <div>
        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </button>{' '}
        <button type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
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
      className="dialog"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !pending) onCancel();
      }}
    >
      <h2 id="revoke-title">Revoke “{apiKey.name}”?</h2>
      <p id="revoke-desc">Any agent using this key loses access immediately. This cannot be undone.</p>
      {error && (
        <p role="alert" className="field-error">
          {error.message}
        </p>
      )}
      <button type="button" ref={cancelRef} onClick={onCancel} disabled={pending}>
        Cancel
      </button>{' '}
      <button type="button" className="danger" onClick={confirm} disabled={pending}>
        {pending ? 'Revoking…' : 'Revoke key'}
      </button>
    </div>
  );
}
