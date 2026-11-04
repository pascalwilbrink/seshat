'use client';

import { type DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { CollectionDto, FileDto } from '@/lib/api-types';
import { parseTagInput } from '@/lib/files';
import { uploadForm } from '@/lib/upload';
import { formatSize } from '@/lib/files';

type ItemStatus = 'pending' | 'uploading' | 'success' | 'failed';
interface QueueItem {
  id: number;
  file: File;
  collectionId: string;
  tags: string[];
  status: ItemStatus;
  loaded: number;
  error: string | null;
}

function failureText(status: number, body: unknown): string {
  if (status === 401) return 'Your session has expired. Log in again to continue.';
  if (status === 413) return 'This file is larger than the upload limit. Choose a smaller file.';
  const msg = body && typeof body === 'object' ? (body as { message?: unknown }).message : null;
  if ((status === 400 || status === 409) && typeof msg === 'string' && msg !== 'Invalid request') return msg;
  if (status === 400) return 'The server rejected this upload. Check the Collection and tags.';
  return 'Upload failed. Try again.';
}

/**
 * Drag/drop and file-input upload: one multipart request per original, sequentially, with real progress. The chosen Collection
 * and tag names stay in place after uploads and are captured per file so a retry repeats the same request. Unmounting (scope
 * change) aborts the running request and starts no further ones.
 */
export function FileUploader({
  base,
  collections,
  onUploaded,
}: {
  base: string;
  collections: CollectionDto[];
  onUploaded: (file: FileDto) => void;
}) {
  const [collectionId, setCollectionId] = useState('');
  const [tagText, setTagText] = useState('');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [announce, setAnnounce] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const running = useRef(false);
  const alive = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const queueRef = useRef<QueueItem[]>([]);
  queueRef.current = queue;
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, []);

  const patch = useCallback((id: number, change: Partial<QueueItem>) => {
    if (!alive.current) return;
    setQueue((q) => q.map((i) => (i.id === id ? { ...i, ...change } : i)));
  }, []);

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        if (!alive.current) return;
        const item = queueRef.current.find((i) => i.status === 'pending');
        if (!item) return;
        patch(item.id, { status: 'uploading', loaded: 0, error: null });
        // Fields first so the server has them before the file part; the browser adds the multipart boundary.
        const form = new FormData();
        if (item.collectionId) form.append('collectionId', item.collectionId);
        for (const t of item.tags) form.append('tags', t);
        form.append('file', item.file);
        const controller = new AbortController();
        abort.current = controller;
        try {
          const res = await uploadForm(base, form, { signal: controller.signal, onProgress: (loaded) => patch(item.id, { loaded }) });
          if (!alive.current) return;
          if (res.status >= 200 && res.status < 300) {
            patch(item.id, { status: 'success', loaded: item.file.size });
            setAnnounce(`${item.file.name} uploaded.`);
            onUploadedRef.current(res.body as FileDto);
          } else {
            const error = failureText(res.status, res.body);
            patch(item.id, { status: 'failed', error });
            setAnnounce(`${item.file.name} failed: ${error}`);
          }
        } catch {
          if (!alive.current) return;
          patch(item.id, { status: 'failed', error: 'Could not reach the server. Try again.' });
          setAnnounce(`${item.file.name} failed: could not reach the server.`);
        }
      }
    } finally {
      running.current = false;
    }
  }, [base, patch]);

  function enqueue(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    const tags = parseTagInput(tagText);
    const items: QueueItem[] = list.map((file) => ({
      id: nextId.current++,
      file,
      collectionId,
      tags,
      status: 'pending',
      loaded: 0,
      error: null,
    }));
    queueRef.current = [...queueRef.current, ...items];
    setQueue(queueRef.current);
    void pump();
  }

  function retry(id: number) {
    queueRef.current = queueRef.current.map((i) => (i.id === id ? { ...i, status: 'pending', loaded: 0, error: null } : i));
    setQueue(queueRef.current);
    void pump();
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    enqueue(e.dataTransfer.files);
  }

  return (
    <section aria-labelledby="upload-title" className="uploader">
      <h2 id="upload-title">Upload files</h2>
      <div className="form">
        <div className="field">
          <label htmlFor="upload-collection">Collection (optional)</label>
          <select id="upload-collection" value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
            <option value="">No Collection</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="upload-tags">Tags (optional)</label>
          <input id="upload-tags" type="text" value={tagText} onChange={(e) => setTagText(e.target.value)} aria-describedby="upload-tags-hint" />
          <p id="upload-tags-hint" className="field-hint muted">
            Separate tags with commas. They are created in this scope if they do not exist.
          </p>
        </div>
      </div>
      <div
        className={`dropzone${dragging ? ' dropzone-active' : ''}`}
        data-testid="dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p>Drag files here, or</p>
        <button type="button" onClick={() => inputRef.current?.click()}>
          Choose files
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          aria-label="Files to upload"
          tabIndex={-1}
          onChange={(e) => {
            enqueue(e.target.files ?? []);
            e.target.value = '';
          }}
        />
      </div>
      <div role="status" className="sr-only">
        {announce}
      </div>
      {queue.length > 0 && (
        <ul className="upload-list" aria-label="Uploads">
          {queue.map((i) => (
            <li key={i.id}>
              <span>{i.file.name}</span> <span className="muted">({formatSize(i.file.size)})</span>{' '}
              {i.status === 'pending' && <span>Waiting…</span>}
              {i.status === 'uploading' && (
                <progress aria-label={`Uploading ${i.file.name}`} value={i.loaded} max={i.file.size || 1}>
                  {i.loaded}
                </progress>
              )}
              {i.status === 'success' && <span>Uploaded</span>}
              {i.status === 'failed' && (
                <>
                  <span role="alert" className="field-error">
                    {i.error}
                  </span>{' '}
                  <button type="button" onClick={() => retry(i.id)}>
                    Retry<span className="sr-only"> {i.file.name}</span>
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
