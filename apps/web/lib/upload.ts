import { handleUnauthorized } from './api-client';

export interface UploadResult {
  status: number;
  body: unknown;
}

/**
 * Same-origin multipart upload with real progress (`xhr.upload.onprogress`). The browser sets the multipart boundary from the
 * FormData; a 401 follows the same flow as `apiFetch`. Rejects with `AbortError` when aborted and `Error('network')` on failure.
 */
export function uploadForm(
  url: string,
  form: FormData,
  opts: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<UploadResult> {
  if (!url.startsWith('/api/')) throw new Error('uploadForm only calls relative /api paths');
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status === 401) handleUnauthorized();
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (opts.signal) {
      if (opts.signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(form);
  });
}
