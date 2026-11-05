'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { CollectionDto, FileDto } from '@/lib/api-types';
import { formatSize, parseTagInput } from '@/lib/files';
import { readFormError } from '@/lib/form-errors';
import { formatDate } from '@/lib/files';
import { ChunkPreview } from './chunk-preview';
import { FormField } from './form-field';
import { ReindexButton } from './reindex-button';
import { StatusBadge } from './status-badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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
  onReindexed,
}: {
  base: string;
  file: FileDto;
  collections: CollectionDto[];
  onClose: () => void;
  onSaved: (file: FileDto) => void;
  onReindexed: (file: FileDto) => void;
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
    <aside aria-labelledby="file-detail-title" className="my-4 min-w-0 rounded-lg border border-border p-4">
      <h2 className="mt-6 mb-2 text-lg font-semibold break-words" id="file-detail-title" ref={headingRef} tabIndex={-1}>
        File details
      </h2>
      <dl className="my-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Type</dt>
        <dd className="m-0 min-w-0 break-words">{file.mimeType}</dd>
        <dt className="text-muted-foreground">Size</dt>
        <dd className="m-0 min-w-0 break-words">{formatSize(file.sizeBytes)}</dd>
        <dt className="text-muted-foreground">Indexing</dt>
        <dd className="m-0 min-w-0 break-words">
          <StatusBadge status={file.ingestionStatus} />
        </dd>
        <dt className="text-muted-foreground">Indexed</dt>
        <dd className="m-0 min-w-0 break-words">{file.indexedAt ? formatDate(file.indexedAt) : 'Not indexed yet'}</dd>
        <dt className="text-muted-foreground">Chunks</dt>
        <dd className="m-0 min-w-0 break-words">{file.chunkCount}</dd>
        <dt className="text-muted-foreground">SHA-256</dt>
        <dd className="m-0 font-mono break-all">{file.sha256}</dd>
      </dl>
      {file.ingestionStatus === 'failed' && (
        <p role="alert" className="text-sm text-destructive break-words">
          {file.ingestionError ?? 'Indexing failed.'}
        </p>
      )}
      <div className="my-2">
        <ReindexButton base={base} file={file} onQueued={onReindexed} />
      </div>
      <form onSubmit={submit} noValidate aria-busy={pending} aria-label={`Edit ${file.name}`} className="flex max-w-lg flex-col gap-3">
        <FormField id="file-name" label="Display name" error={fe.name}>
          {(p) => <Input {...p} type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={pending} />}
        </FormField>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="file-collection">Collection</Label>
          <Select id="file-collection" value={collectionId} onChange={(e) => setCollectionId(e.target.value)} disabled={pending}>
            <option value="">No Collection</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          {fe.collectionId && <p className="text-sm text-destructive break-words">{fe.collectionId}</p>}
        </div>
        <FormField id="file-tags" label="Tags" hint="Separate tags with commas. Saving replaces the current tags." error={fe.tags}>
          {(p) => <Input {...p} type="text" value={tagText} onChange={(e) => setTagText(e.target.value)} disabled={pending} />}
        </FormField>
        {formLevel && (
          <p role="alert" className="text-sm text-destructive break-words">
            {formLevel}
          </p>
        )}
        <div role="status">{saved ? 'Changes saved.' : ''}</div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>{' '}
          <a className="rounded-sm text-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-ring" href={`${base}/${encodeURIComponent(file.id)}/download`} download>
            Download<span className="sr-only"> {file.name}</span>
          </a>{' '}
          <Button type="button" onClick={onClose} disabled={pending}>
            Close
          </Button>
        </div>
      </form>
      <ChunkPreview base={base} fileId={file.id} reloadKey={`${file.ingestionStatus}|${file.indexedAt ?? ''}`} />
    </aside>
  );
}
