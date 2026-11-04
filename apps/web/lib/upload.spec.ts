// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadForm } from './upload';

class Xhr {
  static last: Xhr;
  upload: { onprogress: ((e: unknown) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = '';
  withCredentials = false;
  headers: string[] = [];
  open() {}
  setRequestHeader(n: string) {
    this.headers.push(n);
  }
  send() {
    Xhr.last = this;
  }
  abort() {
    this.onabort?.();
  }
}
afterEach(() => vi.unstubAllGlobals());

describe('uploadForm', () => {
  it('reports progress, parses the body and never sets a content type', async () => {
    vi.stubGlobal('XMLHttpRequest', Xhr);
    const seen: number[] = [];
    const p = uploadForm('/api/global/files', new FormData(), { onProgress: (l) => seen.push(l) });
    Xhr.last.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
    Xhr.last.status = 201;
    Xhr.last.responseText = '{"id":"x"}';
    Xhr.last.onload?.();
    await expect(p).resolves.toEqual({ status: 201, body: { id: 'x' } });
    expect(seen).toEqual([5]);
    expect(Xhr.last.headers).toEqual([]);
    expect(Xhr.last.withCredentials).toBe(true);
  });
  it('sends a 401 to the login flow', async () => {
    vi.stubGlobal('XMLHttpRequest', Xhr);
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/w/a/files', search: '', assign });
    const p = uploadForm('/api/global/files', new FormData());
    Xhr.last.status = 401;
    Xhr.last.onload?.();
    await p;
    expect(assign).toHaveBeenCalledWith(expect.stringContaining('/login'));
  });
  it('rejects non-api paths, aborts and network errors', async () => {
    vi.stubGlobal('XMLHttpRequest', Xhr);
    expect(() => uploadForm('https://evil.test/x', new FormData())).toThrow();
    const c = new AbortController();
    const p = uploadForm('/api/x', new FormData(), { signal: c.signal });
    c.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const q = uploadForm('/api/x', new FormData());
    Xhr.last.onerror?.();
    await expect(q).rejects.toThrow('network');
  });
});
