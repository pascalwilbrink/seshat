'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { CollectionDto, FileDto } from '@/lib/api-types';
import { formatSize, parseTagInput } from '@/lib/files';
import { readFormError } from '@/lib/form-errors';
import { FormField } from './form-field';

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const SESSION = 'Your session has expired. Log in again to continue.';

async function failure(res: Response): Promise<{ message: string; fields: Record<string, string> }> {
  if (res.status === 401) return { message: SESSION, fields: {} };
  if (res.status === 404) return { message: 'This file no longer exists.', fields: {} };
  const e = await readFormError(res);
  return { message: e.message, fields: e.fields };
}

/** Detail panel: rename, set/clear the Collection, replace the tags, download. Never renders the original content. */
export function FileDetail({
  base,
  file,
  collections,
  onClose,
  onSaved,
}: {
  base: string;
  file: FileDto;
  collections: CollectionDto[];
  onClose: () => void;
  onSaved: (file: FileDto) => void;
}) {
  const [name, setName] = useState(file.name);
  const [collectionId, setCollectionId] = useState(file.collectionId ?? '');
  const [tagText, setTagText] = useState(file.tags.join(', '));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; fields: Record<string, string> } | null>(null);
  const [saved, setSaved] = useState(false);
  const alive = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    alive.current = true;
    headingRef.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (!name.trim()) {
      setError({ message: '', fields: { name: 'Name must not be empty' } });
      return;
    }
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const res = await apiFetch(`${base}/${encodeURIComponent(file.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), collectionId: collectionId || null, tags: parseTagInput(tagText) }),
      });
      if (!alive.current) return;
      if (res.ok) {
        const next = (await res.json()) as FileDto;
        if (!alive.current) return;
        setSaved(true);
        setPending(false);
        onSaved(next);
        return;
      }
      const f = await failure(res);
      if (alive.current) setError(f);
    } catch {
      if (alive.current) setError({ message: NETWORK, fields: {} });
    }
    if (alive.current) setPending(false);
  }

  const fe = error?.fields ?? {};
  const formLevel = error && Object.keys(fe).length === 0 && error.message ? error.message : null;
  return (
    <aside aria-labelledby="file-detail-title" className="file-detail">
      <h2 id="file-detail-title" ref={headingRef} tabIndex={-1}>
        File details
      </h2>
      <dl>
        <dt>Type</dt>
        <dd>{file.mimeType}</dd>
        <dt>Size</dt>
        <dd>{formatSize(file.sizeBytes)}</dd>
        <dt>SHA-256</dt>
        <dd className="mono">{file.sha256}</dd>
      </dl>
      <form onSubmit={submit} noValidate aria-busy={pending} aria-label={`Edit ${file.name}`} className="form">
        <FormField id="file-name" label="Display name" error={fe.name}>
          {(p) => <input {...p} type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={pending} />}
        </FormField>
        <div className="field">
          <label htmlFor="file-collection">Collection</label>
          <select id="file-collection" value={collectionId} onChange={(e) => setCollectionId(e.target.value)} disabled={pending}>
            <option value="">No Collection</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {fe.collectionId && <p className="field-error">{fe.collectionId}</p>}
        </div>
        <FormField id="file-tags" label="Tags" hint="Separate tags with commas. Saving replaces the current tags." error={fe.tags}>
          {(p) => <input {...p} type="text" value={tagText} onChange={(e) => setTagText(e.target.value)} disabled={pending} />}
        </FormField>
        {formLevel && (
          <p role="alert" className="field-error">
            {formLevel}
          </p>
        )}
        <div role="status">{saved ? 'Changes saved.' : ''}</div>
        <div>
          <button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </button>{' '}
          <a href={`${base}/${encodeURIComponent(file.id)}/download`} download>
            Download<span className="sr-only"> {file.name}</span>
          </a>{' '}
          <button type="button" onClick={onClose} disabled={pending}>
            Close
          </button>
        </div>
      </form>
    </aside>
  );
}
