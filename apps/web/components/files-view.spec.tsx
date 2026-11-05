// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api-client', () => ({ apiFetch: (p: string, i?: RequestInit) => fetch(p, i), handleUnauthorized: vi.fn() }));

import { FilesView, POLL_INTERVAL_MS } from './files-view';
import { WorkspacesProvider } from './workspaces-provider';
import { json, ws } from './shell.fixture';
import type { ChunkDto, FileDto } from '@/lib/api-types';
import { handleUnauthorized } from '@/lib/api-client';
import type { Scope } from '@/lib/scope';

const fetchMock = vi.fn();

class FakeXhr {
  static all: FakeXhr[] = [];
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = '';
  withCredentials = false;
  method = '';
  url = '';
  body: FormData | null = null;
  aborted = false;
  open(m: string, u: string) {
    this.method = m;
    this.url = u;
  }
  send(b: FormData) {
    this.body = b;
    FakeXhr.all.push(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  FakeXhr.all = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  vi.mocked(handleUnauthorized).mockReset();
});

const alpha = ws('alpha', 'Alpha', 'uuid-1');
const beta = ws('beta', 'Beta', 'uuid-2');
const file = (over: Partial<FileDto> = {}): FileDto => ({
  id: 'f1',
  scope: 'global',
  workspaceId: null,
  name: 'notes.md',
  extension: 'md',
  mimeType: 'text/markdown',
  sizeBytes: 2048,
  sha256: 'a'.repeat(64),
  collectionId: null,
  tags: [],
  ingestionStatus: 'pending',
  ingestionError: null,
  indexedAt: null,
  chunkCount: 0,
  createdAt: '2026-03-02T10:00:00.000Z',
  updatedAt: '2026-03-02T10:00:00.000Z',
  ...over,
});
const COLLECTIONS = [
  { id: 'c1', name: 'Specs', description: null, fileCount: 1, createdAt: '', updatedAt: '' },
  { id: 'c2', name: 'Notes', description: null, fileCount: 0, createdAt: '', updatedAt: '' },
];
const TAGS = [{ id: 't1', name: 'draft', scope: 'global', workspaceId: null, fileCount: 1, createdAt: '', updatedAt: '' }];

interface Server {
  files: Record<string, FileDto[]>;
  pageSize?: number;
  failList?: Record<string, number>;
  /** Chunks by file id; `chunkFail` makes the chunk route answer with that status. */
  chunks?: Record<string, ChunkDto[]>;
  chunkFail?: number;
  reindexFail?: number;
  seen: string[];
}
/** Mutable double keyed by base path (`/api/global`, `/api/workspaces/uuid-1`). */
function server(files: Record<string, FileDto[]>, extra: Partial<Server> = {}): Server {
  const s: Server = { files, seen: [], ...extra };
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    s.seen.push(`${method} ${url}`);
    if (url === '/api/global/workspaces') return json([alpha, beta]);
    const m = /^(\/api\/(?:global|workspaces\/[^/]+))\/(files|collections|tags)(?:\/([^/?]+))?(?:\/(chunks|reindex))?(?:\?(.*))?$/.exec(url);
    if (!m) throw new Error(`Unexpected fetch ${method} ${url}`);
    const [, base, kind, id, sub, qs] = m;
    if (kind === 'collections') return json(COLLECTIONS);
    if (kind === 'tags') return json(TAGS);
    if (s.failList?.[base]) return json({ message: 'boom' }, s.failList[base]);
    const all = s.files[base] ?? [];
    if (sub === 'chunks') {
      if (s.chunkFail) return json({ message: 'x' }, s.chunkFail);
      const all = s.chunks?.[id] ?? [];
      const q = new URLSearchParams(qs ?? '');
      const start = q.get('cursor') ? Number(q.get('cursor')) : 0;
      const limit = Number(q.get('limit') ?? 10);
      const hasMore = start + limit < all.length;
      return json({ items: all.slice(start, start + limit), nextCursor: hasMore ? String(start + limit) : null, hasMore, limit });
    }
    if (sub === 'reindex') {
      if (s.reindexFail) return json({ message: 'x' }, s.reindexFail);
      s.files[base] = all.map((f) => (f.id === id ? { ...f, ingestionStatus: 'pending', ingestionError: null } : f));
      return json(s.files[base].find((f) => f.id === id), 202);
    }
    if (method === 'GET' && id) {
      const f = all.find((x) => x.id === id);
      return f ? json(f) : json({ message: 'nf' }, 404);
    }
    if (method === 'GET' && !id) {
      const q = new URLSearchParams(qs ?? '');
      let items = all.filter(
        (f) =>
          (!q.get('collectionId') || f.collectionId === q.get('collectionId')) &&
          (!q.get('tag') || f.tags.includes(q.get('tag')!)) &&
          (!q.get('status') || f.ingestionStatus === q.get('status')) &&
          (!q.get('name') || f.name.includes(q.get('name')!)),
      );
      const size = s.pageSize ?? 25;
      const start = q.get('cursor') ? Number(q.get('cursor')) : 0;
      const page = items.slice(start, start + size);
      const hasMore = start + size < items.length;
      return json({ items: page, nextCursor: hasMore ? String(start + size) : null, hasMore, limit: size });
    }
    if (method === 'PUT') {
      const body = JSON.parse(String(init?.body));
      s.files[base] = all.map((f) => (f.id === id ? { ...f, ...body } : f));
      return json(s.files[base].find((f) => f.id === id));
    }
    if (method === 'DELETE') {
      s.files[base] = all.filter((f) => f.id !== id);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  });
  return s;
}

const G = '/api/global';
const A = '/api/workspaces/uuid-1';
const B = '/api/workspaces/uuid-2';

function renderView(scope: Scope) {
  const ui = (s: Scope) => (
    <WorkspacesProvider>
      <FilesView scope={s} />
    </WorkspacesProvider>
  );
  const r = render(ui(scope));
  return { ...r, switchTo: (s: Scope) => r.rerender(ui(s)) };
}
const lastXhr = () => FakeXhr.all[FakeXhr.all.length - 1];

describe('FilesView list', () => {
  it('shows loading, then every specified field', async () => {
    server({ [G]: [file({ collectionId: 'c1', tags: ['draft', 'x'], ingestionStatus: 'indexed' })] });
    renderView({ kind: 'global' });
    expect(screen.getByText('Loading files…')).toBeInTheDocument();
    const row = (await screen.findByRole('row', { name: /notes\.md/ })) as HTMLElement;
    expect(within(row).getByText('2.0 KB')).toBeInTheDocument();
    expect(within(row).getByText('Specs')).toBeInTheDocument();
    expect(within(row).getByText('draft, x')).toBeInTheDocument();
    expect(within(row).getByText('Indexed')).toBeInTheDocument();
    expect(within(row).getByText('2026-03-02 10:00 UTC')).toBeInTheDocument();
  });

  it('shows the empty state and an error with retry', async () => {
    const s = server({ [G]: [] }, { failList: { [G]: 500 } });
    renderView({ kind: 'global' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    delete s.failList![G];
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/No files yet/)).toBeInTheDocument();
  });

  it('treats names as text', async () => {
    server({ [G]: [file({ name: '<img src=x onerror=alert(1)>.md' })] });
    const { container } = renderView({ kind: 'global' });
    await screen.findByRole('rowheader', { name: '<img src=x onerror=alert(1)>.md' });
    expect(container.querySelector('img')).toBeNull();
  });

  it('applies combined filters from the first page and shows no-results', async () => {
    const s = server({ [G]: [file({ id: 'a', name: 'a.md', tags: ['draft'], collectionId: 'c1' }), file({ id: 'b', name: 'b.md' })] });
    renderView({ kind: 'global' });
    await screen.findByText('a.md', { selector: 'th' });
    await userEvent.type(screen.getByLabelText('Name contains'), 'a.md');
    await userEvent.selectOptions(screen.getByLabelText('Collection'), 'c1');
    await userEvent.selectOptions(screen.getByLabelText('Tag'), 'draft');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'pending');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(s.seen).toContain(`GET ${G}/files?collectionId=c1&tag=draft&status=pending&name=a.md`));
    expect(screen.queryByText('b.md', { selector: 'th' })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failed');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText('No files match these filters.')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
    expect(await screen.findByText('b.md', { selector: 'th' })).toBeInTheDocument();
  });

  it('paginates with load more and resets the cursor when filters change', async () => {
    const many = [1, 2, 3].map((n) => file({ id: `f${n}`, name: `f${n}.md`, tags: n === 3 ? ['draft'] : [] }));
    const s = server({ [G]: many }, { pageSize: 2 });
    renderView({ kind: 'global' });
    await screen.findByText('f2.md', { selector: 'th' });
    expect(screen.queryByText('f3.md', { selector: 'th' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('f3.md', { selector: 'th' })).toBeInTheDocument();
    expect(s.seen).toContain(`GET ${G}/files?cursor=2`);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Tag'), 'draft');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(s.seen).toContain(`GET ${G}/files?tag=draft`));
    expect(s.seen.filter((x) => x.includes('tag=draft') && x.includes('cursor'))).toEqual([]);
  });

  it('keeps the list and offers a retry when loading more fails', async () => {
    const many = [1, 2, 3].map((n) => file({ id: `f${n}`, name: `f${n}.md` }));
    const s = server({ [G]: many }, { pageSize: 2 });
    renderView({ kind: 'global' });
    await screen.findByText('f2.md', { selector: 'th' });
    const real = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(async () => json({ message: 'x' }, 500));
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('f1.md', { selector: 'th' })).toBeInTheDocument();
    fetchMock.mockImplementation(real);
    await userEvent.click(screen.getByRole('button', { name: 'Retry loading more' }));
    expect(await screen.findByText('f3.md', { selector: 'th' })).toBeInTheDocument();
    void s;
  });

  it('links downloads to the attachment endpoint and never previews', async () => {
    server({ [A]: [file({ id: 'fx' })] });
    const { container } = renderView({ kind: 'workspace', slug: 'alpha' });
    const link = await screen.findByRole('link', { name: /Download/ });
    expect(link).toHaveAttribute('href', `${A}/files/fx/download`);
    expect(link).toHaveAttribute('download');
    expect(container.querySelector('iframe, embed, object, img, video, audio')).toBeNull();
  });

  it('shows an expired session as a message without retry', async () => {
    server({ [G]: [] }, { failList: { [G]: 401 } });
    renderView({ kind: 'global' });
    expect(await screen.findByRole('alert')).toHaveTextContent('session has expired');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});

describe('FilesView detail and delete', () => {
  it('edits name, sets and clears the Collection and replaces tags', async () => {
    const s = server({ [G]: [file({ collectionId: 'c1', tags: ['draft'] })] });
    renderView({ kind: 'global' });
    await userEvent.click(await screen.findByRole('button', { name: /Details/ }));
    const form = screen.getByRole('form', { name: /Edit notes\.md/ });
    expect(within(form).getByLabelText('Collection')).toHaveValue('c1');
    const name = within(form).getByLabelText('Display name');
    await userEvent.clear(name);
    await userEvent.type(name, 'renamed.md');
    await userEvent.selectOptions(within(form).getByLabelText('Collection'), '');
    const tags = within(form).getByLabelText('Tags');
    await userEvent.clear(tags);
    await userEvent.type(tags, 'a, b');
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes saved.')).toBeInTheDocument();
    expect(s.files[G][0]).toMatchObject({ name: 'renamed.md', collectionId: null, tags: ['a', 'b'] });
    expect(await screen.findAllByText('renamed.md')).not.toHaveLength(0);
    // Clearing every tag sends an empty list.
    await userEvent.clear(tags);
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(s.files[G][0].tags).toEqual([]));
  });

  it('validates an empty name locally and shows server errors', async () => {
    server({ [G]: [file()] });
    renderView({ kind: 'global' });
    await userEvent.click(await screen.findByRole('button', { name: /Details/ }));
    await userEvent.clear(screen.getByLabelText('Display name'));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByLabelText('Display name')).toHaveAccessibleDescription('Name must not be empty');
    await userEvent.type(screen.getByLabelText('Display name'), 'x.md');
    const real = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(async () => json({ message: 'x' }, 500));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    fetchMock.mockImplementation(real);
  });

  it('cancels and confirms deletion', async () => {
    const s = server({ [G]: [file()] });
    renderView({ kind: 'global' });
    await userEvent.click(await screen.findByRole('button', { name: /Delete/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(s.files[G]).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: /Delete/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete file' }));
    expect(await screen.findByText(/No files yet/)).toBeInTheDocument();
    expect(s.files[G]).toHaveLength(0);
  });

  it('shows a delete failure and keeps the file', async () => {
    server({ [G]: [file()] });
    renderView({ kind: 'global' });
    await userEvent.click(await screen.findByRole('button', { name: /Delete/ }));
    const real = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(async () => json({ message: 'x' }, 500));
    await userEvent.click(screen.getByRole('button', { name: 'Delete file' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toBeInTheDocument();
    fetchMock.mockImplementation(real);
    expect(screen.getByText('notes.md', { selector: 'th' })).toBeInTheDocument();
  });
});

describe('FilesView upload', () => {
  const f = (name: string, size = 10) => new File([new Uint8Array(size)], name, { type: 'text/plain' });

  it('uploads several files one request each with real progress and a refreshed list', async () => {
    const s = server({ [G]: [] });
    renderView({ kind: 'global' });
    await screen.findByText(/No files yet/);
    await userEvent.selectOptions(screen.getByLabelText('Collection (optional)'), 'c2');
    await userEvent.type(screen.getByLabelText('Tags (optional)'), 'alpha, beta');
    await userEvent.upload(screen.getByLabelText('Files to upload'), [f('a.txt', 100), f('b.txt', 50)]);
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    const x = FakeXhr.all[0];
    expect(x.method).toBe('POST');
    expect(x.url).toBe(`${G}/files`);
    expect(x.body!.getAll('file')).toHaveLength(1);
    expect(x.body!.get('collectionId')).toBe('c2');
    expect(x.body!.getAll('tags')).toEqual(['alpha', 'beta']);
    expect(screen.getByText('Waiting…')).toBeInTheDocument();
    x.progress(25, 100);
    expect(await screen.findByRole('progressbar', { name: 'Uploading a.txt' })).toHaveAttribute('value', '25');
    s.files[G] = [file({ id: 'n1', name: 'a.txt' })];
    x.respond(201, file({ id: 'n1', name: 'a.txt' }));
    await waitFor(() => expect(FakeXhr.all).toHaveLength(2));
    expect(FakeXhr.all[1].body!.getAll('file')[0]).toMatchObject({ name: 'b.txt' });
    FakeXhr.all[1].respond(201, file({ id: 'n2', name: 'b.txt' }));
    expect(await screen.findAllByText('Uploaded')).toHaveLength(2);
    expect(await screen.findByRole('row', { name: /a\.txt/ })).toBeInTheDocument();
    // The selection stays for the next batch.
    expect(screen.getByLabelText('Collection (optional)')).toHaveValue('c2');
    expect(screen.getByLabelText('Tags (optional)')).toHaveValue('alpha, beta');
  });

  it('accepts dropped files', async () => {
    server({ [G]: [] });
    renderView({ kind: 'global' });
    await screen.findByText(/No files yet/);
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [f('d.txt')] } });
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    expect((lastXhr().body!.getAll('file')[0] as File).name).toBe('d.txt');
  });

  it('explains a 413 and retries with the same Collection and tags', async () => {
    server({ [G]: [] });
    renderView({ kind: 'global' });
    await screen.findByText(/No files yet/);
    await userEvent.selectOptions(screen.getByLabelText('Collection (optional)'), 'c1');
    await userEvent.type(screen.getByLabelText('Tags (optional)'), 'big');
    await userEvent.upload(screen.getByLabelText('Files to upload'), f('huge.bin'));
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    lastXhr().respond(413, { message: 'Payload too large' });
    expect(await screen.findByRole('alert')).toHaveTextContent('larger than the upload limit');
    // The user changes the form; the retry still repeats what was chosen for this file.
    await userEvent.selectOptions(screen.getByLabelText('Collection (optional)'), '');
    await userEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(FakeXhr.all).toHaveLength(2));
    expect(lastXhr().body!.get('collectionId')).toBe('c1');
    expect(lastXhr().body!.getAll('tags')).toEqual(['big']);
    lastXhr().respond(201, file({ id: 'ok', name: 'huge.bin' }));
    expect(await screen.findByText('Uploaded')).toBeInTheDocument();
  });

  it('reports network failure and an expired session per file', async () => {
    server({ [G]: [] });
    renderView({ kind: 'global' });
    await screen.findByText(/No files yet/);
    await userEvent.upload(screen.getByLabelText('Files to upload'), [f('a.txt'), f('b.txt')]);
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    lastXhr().onerror?.();
    await waitFor(() => expect(FakeXhr.all).toHaveLength(2));
    lastXhr().respond(401, { message: 'Unauthorized' });
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    const alerts = screen.getAllByRole('alert');
    expect(alerts[0]).toHaveTextContent('Could not reach the server');
    expect(alerts[1]).toHaveTextContent('session has expired');
    expect(handleUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('shows a server validation message', async () => {
    server({ [G]: [] });
    renderView({ kind: 'global' });
    await screen.findByText(/No files yet/);
    await userEvent.upload(screen.getByLabelText('Files to upload'), f('a.txt'));
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    lastXhr().respond(400, { message: 'Unknown Collection' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown Collection');
  });
});

describe('FilesView scopes', () => {
  it('uses UUID paths and never shows another scope’s data', async () => {
    const s = server({ [G]: [file({ id: 'g', name: 'global.md' })], [A]: [file({ id: 'a', name: 'alpha.md' })], [B]: [file({ id: 'b', name: 'beta.md' })] });
    const { switchTo } = renderView({ kind: 'global' });
    await screen.findByText('global.md', { selector: 'th' });
    switchTo({ kind: 'workspace', slug: 'alpha' });
    await screen.findByText('alpha.md', { selector: 'th' });
    expect(screen.queryByText('global.md', { selector: 'th' })).not.toBeInTheDocument();
    switchTo({ kind: 'workspace', slug: 'beta' });
    await screen.findByText('beta.md', { selector: 'th' });
    expect(screen.queryByText('alpha.md', { selector: 'th' })).not.toBeInTheDocument();
    expect(s.seen).toEqual(expect.arrayContaining([`GET ${A}/files`, `GET ${B}/files`, `GET ${G}/files`]));
    expect(s.seen.some((x) => x.includes('/workspaces/alpha') || x.includes('/workspaces/beta'))).toBe(false);
  });

  it('ignores a slow response from the previous scope', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server({ [A]: [file({ id: 'a', name: 'alpha.md' })], [B]: [file({ id: 'b', name: 'beta.md' })] });
    const real = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `${A}/files`) {
        await gate;
      }
      return real(url, init);
    });
    const { switchTo } = renderView({ kind: 'workspace', slug: 'alpha' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`${A}/files`, undefined));
    switchTo({ kind: 'workspace', slug: 'beta' });
    await screen.findByText('beta.md', { selector: 'th' });
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('alpha.md', { selector: 'th' })).not.toBeInTheDocument();
    expect(screen.getByText('beta.md', { selector: 'th' })).toBeInTheDocument();
  });

  it('aborts a running upload and starts no more when the scope changes', async () => {
    server({ [A]: [], [B]: [] });
    const { switchTo } = renderView({ kind: 'workspace', slug: 'alpha' });
    await screen.findByText(/No files yet/);
    await userEvent.upload(screen.getByLabelText('Files to upload'), [new File(['1'], 'a.txt'), new File(['2'], 'b.txt')]);
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    const first = FakeXhr.all[0];
    expect(first.url).toBe(`${A}/files`);
    switchTo({ kind: 'workspace', slug: 'beta' });
    await screen.findByText(/No files yet/);
    expect(first.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeXhr.all).toHaveLength(1);
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument();
  });

  it('reports an unknown Workspace', async () => {
    server({});
    renderView({ kind: 'workspace', slug: 'nope' });
    expect(await screen.findByText('Workspace not found')).toBeInTheDocument();
  });
});

const chunk = (ordinal: number, content: string, location: Partial<ChunkDto['location']> = {}): ChunkDto => ({
  id: `c${ordinal}`,
  fileId: 'f1',
  ordinal,
  content,
  charCount: content.length,
  location: { startOffset: 0, endOffset: content.length, startLine: 1, endLine: 2, ...location },
});

describe('FilesView ingestion status', () => {
  afterEach(() => vi.useRealTimers());

  it('shows all four status badges', async () => {
    server({
      [G]: ['pending', 'processing', 'indexed', 'failed'].map((st, i) => file({ id: `s${i}`, name: `${st}.md`, ingestionStatus: st as FileDto['ingestionStatus'], ingestionError: st === 'failed' ? 'Unsupported file type' : null })),
    });
    const { container } = renderView({ kind: 'global' });
    await screen.findByText('failed.md', { selector: 'th' });
    for (const st of ['pending', 'processing', 'indexed', 'failed']) expect(container.querySelector(`[data-status="${st}"]`)).not.toBeNull();
    expect(screen.getByText('Unsupported file type')).toBeInTheDocument();
  });

  it('polls only while work is active, updates the row and detail, then stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = server({ [G]: [file({ ingestionStatus: 'pending' })] }, { chunks: { f1: [chunk(0, 'hello')] } });
    const { container } = renderView({ kind: 'global' });
    await screen.findByRole('row', { name: /notes\.md/ });
    await userEvent.click(screen.getByRole('button', { name: /Details/ }));
    s.files[G] = [file({ ingestionStatus: 'indexed', indexedAt: '2026-03-02T11:00:00.000Z', chunkCount: 1 })];
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 10);
    await waitFor(() => expect(container.querySelectorAll('[data-status="indexed"]').length).toBeGreaterThan(0));
    expect(await screen.findByText('2026-03-02 11:00 UTC')).toBeInTheDocument();
    expect(await screen.findByText('hello')).toBeInTheDocument();
    const polls = () => s.seen.filter((x) => x === `GET ${G}/files/f1`).length;
    const n = polls();
    expect(n).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(polls()).toBe(n);
  });

  it('does not poll when nothing is pending or processing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = server({ [G]: [file({ ingestionStatus: 'indexed' })] });
    renderView({ kind: 'global' });
    await screen.findByRole('row', { name: /notes\.md/ });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(s.seen.some((x) => /files\/f1$/.test(x))).toBe(false);
  });

  it('stops polling on unmount and on scope change, and ignores a late poll response', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const s = server({ [G]: [file({ id: 'g', name: 'global.md' })], [A]: [file({ id: 'a', name: 'alpha.md', ingestionStatus: 'indexed' })] });
    const real = fetchMock.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `${G}/files/g`) await gate;
      return real(url, init);
    });
    const { switchTo, unmount } = renderView({ kind: 'global' });
    await screen.findByText('global.md', { selector: 'th' });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 10); // poll request now waits on the gate
    switchTo({ kind: 'workspace', slug: 'alpha' });
    await screen.findByText('alpha.md', { selector: 'th' });
    s.files[G] = [file({ id: 'g', name: 'late.md', ingestionStatus: 'indexed' })];
    release();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(screen.queryByText('late.md')).not.toBeInTheDocument();
    expect(s.seen.filter((x) => x === `GET ${G}/files/g`)).toHaveLength(1);
    unmount();
    const before = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('keeps loaded pages while polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server({ [G]: [file({ id: 'x1', name: 'one.md', ingestionStatus: 'indexed' }), file({ id: 'x2', name: 'two.md', ingestionStatus: 'pending' })] }, { pageSize: 1 });
    renderView({ kind: 'global' });
    await screen.findByText('one.md', { selector: 'th' });
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('two.md', { selector: 'th' });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 10);
    expect(screen.getByText('one.md', { selector: 'th' })).toBeInTheDocument();
    expect(screen.getByText('two.md', { selector: 'th' })).toBeInTheDocument();
  });
});

describe('FilesView re-index', () => {
  it('re-indexes a failed file with pending feedback and shows it as pending', async () => {
    const s = server({ [G]: [file({ ingestionStatus: 'failed', ingestionError: 'Embedding failed' })] });
    renderView({ kind: 'global' });
    const row = await screen.findByRole('row', { name: /notes\.md/ });
    await userEvent.click(within(row).getByRole('button', { name: /Re-index/ }));
    await waitFor(() => expect(s.seen).toContain(`POST ${G}/files/f1/reindex`));
    await waitFor(() => expect(within(screen.getByRole('row', { name: /notes\.md/ })).queryByText('Embedding failed')).not.toBeInTheDocument());
    expect(screen.getByRole('row', { name: /notes\.md/ }).querySelector('[data-status="pending"]')).not.toBeNull();
  });

  it('shows an error when re-indexing is refused and keeps the failure', async () => {
    server({ [G]: [file({ ingestionStatus: 'failed', ingestionError: 'Embedding failed' })] }, { reindexFail: 403 });
    renderView({ kind: 'global' });
    await userEvent.click(await screen.findByRole('button', { name: /Re-index/ }));
    expect(await screen.findByText('You are not allowed to re-index this file.')).toBeInTheDocument();
    expect(screen.getByText('Embedding failed')).toBeInTheDocument();
  });

  it('reports a network failure', async () => {
    server({ [G]: [file({ ingestionStatus: 'failed' })] });
    const real = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('offline');
      return real(url, init);
    });
    renderView({ kind: 'global' });
    await userEvent.click(await screen.findByRole('button', { name: /Re-index/ }));
    expect(await screen.findByText(/Could not reach the server/)).toBeInTheDocument();
  });
});

describe('FilesView chunk preview', () => {
  const open = async () => {
    await userEvent.click(await screen.findByRole('button', { name: /Details/ }));
  };

  it('shows indexed time, count, section path and line range, with paging', async () => {
    const chunks = Array.from({ length: 12 }, (_, i) => chunk(i, `part ${i}`, i === 0 ? { headingPath: ['Intro', 'Setup'], startLine: 3, endLine: 9 } : { startLine: 10 + i, endLine: 10 + i }));
    server({ [G]: [file({ ingestionStatus: 'indexed', indexedAt: '2026-03-02T11:00:00.000Z', chunkCount: 12 })] }, { chunks: { f1: chunks } });
    renderView({ kind: 'global' });
    await open();
    expect(await screen.findByText(/Intro › Setup · lines 3–9/)).toBeInTheDocument();
    expect(screen.getByText('2026-03-02 11:00 UTC')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.queryByText('part 11')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load more chunks' }));
    expect(await screen.findByText('part 11')).toBeInTheDocument();
    expect(screen.getByText(/· line 21/)).toBeInTheDocument();
  });

  it('shows empty and failure states', async () => {
    server({ [G]: [file({ ingestionStatus: 'pending' })] }, { chunks: { f1: [] } });
    const first = renderView({ kind: 'global' });
    await open();
    expect(await screen.findByText('No content has been indexed for this file yet.')).toBeInTheDocument();
    first.unmount();
    fetchMock.mockReset();
    server({ [G]: [file({ ingestionStatus: 'indexed' })] }, { chunkFail: 500 });
    renderView({ kind: 'global' });
    await open();
    expect(await screen.findByText('Could not load the preview. Please try again.')).toBeInTheDocument();
  });

  it('renders hostile content as text and logs nothing', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script># [x](javascript:alert(1))';
    server({ [G]: [file({ ingestionStatus: 'indexed' })] }, { chunks: { f1: [chunk(0, evil)] } });
    const { container } = renderView({ kind: 'global' });
    await open();
    const pre = await screen.findByText(evil);
    expect(pre.tagName).toBe('PRE');
    expect(container.querySelector('aside img, aside script, aside a[href^="javascript"]')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    spies.forEach((x) => x.mockRestore());
  });

  it('never shows chunks of another scope after switching', async () => {
    server(
      { [G]: [file({ id: 'f1', name: 'g.md', ingestionStatus: 'indexed' })], [A]: [file({ id: 'f1', name: 'a.md', ingestionStatus: 'indexed' })] },
      { chunks: { f1: [chunk(0, 'secret global text')] } },
    );
    const real = fetchMock.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith(`${G}/files/f1/chunks`)) await gate;
      return real(url, init);
    });
    const { switchTo } = renderView({ kind: 'global' });
    await open();
    switchTo({ kind: 'workspace', slug: 'alpha' });
    await screen.findByText('a.md', { selector: 'th' });
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('secret global text')).not.toBeInTheDocument();
    expect(screen.queryByText('Content preview')).not.toBeInTheDocument();
  });
});
