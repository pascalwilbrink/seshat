'use client';

import Link from 'next/link';
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Search as SearchIcon } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import {
  MEMORY_TYPES,
  type CollectionDto,
  type FileDto,
  type FilePageDto,
  type MemoryType,
  type SearchKind,
  type SearchRequestDto,
  type SearchResponseDto,
  type SearchResultDto,
  type TagDto,
  type WorkspaceDto,
} from '@/lib/api-types';
import { readFormError } from '@/lib/form-errors';
import { describeLocation, excerpt, highlightSegments, resultHref } from '@/lib/search';
import { GLOBAL_OVERVIEW_PATH, type Scope } from '@/lib/scope';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from './empty-state';
import { ErrorState } from './error-state';
import { ScopeBadge } from './scope-badge';
import { StatusBadge } from './status-badge';
import { TypeBadge } from './memory-badges';
import { useWorkspaces } from './workspaces-provider';

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const SESSION = 'Your session has expired. Log in again to continue.';
const FORBIDDEN = 'You are not allowed to search with these options. Change the selection and try again.';
export const OPTION_LIMIT = 100;
export const DEFAULT_LIMIT = 10;

async function failureText(res: Response): Promise<{ message: string; session: boolean }> {
  if (res.status === 401) return { message: SESSION, session: true };
  if (res.status === 403) return { message: FORBIDDEN, session: false };
  return { message: (await readFormError(res)).message, session: false };
}

/** Search of Global or one Workspace. Queries, results and option names are untrusted text; nothing is rendered as HTML. */
export function SearchView({ scope }: { scope: Scope }) {
  if (scope.kind === 'global') return <SearchPanel key="global" base="/api/global" label="Global" workspace={false} />;
  return <WorkspaceSearch slug={scope.slug} />;
}

function Heading({ children }: { children?: ReactNode }) {
  return <h1 className="mb-4 text-2xl font-semibold tracking-tight break-words">Search{children}</h1>;
}

function WorkspaceSearch({ slug }: { slug: string }) {
  const { state, reload } = useWorkspaces();
  if (state.status === 'loading') {
    return (
      <section aria-busy="true">
        <Heading />
        <p role="status" className="text-muted-foreground">
          Loading…
        </p>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section>
        <Heading />
        <ErrorState message="Could not load Workspaces." onRetry={reload} />
      </section>
    );
  }
  const workspace: WorkspaceDto | undefined = state.workspaces.find((w) => w.slug === slug);
  if (!workspace) {
    return (
      <section>
        <h1 className="mb-4 text-2xl font-semibold tracking-tight break-words">Workspace not found</h1>
        <p className="text-muted-foreground">This Workspace does not exist or is not available to you.</p>
        <Link href={GLOBAL_OVERVIEW_PATH} className="rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
          Go to Global Overview
        </Link>
      </section>
    );
  }
  // Keyed by id: another Workspace never inherits a query, filters, options or results.
  return <SearchPanel key={workspace.id} base={`/api/workspaces/${encodeURIComponent(workspace.id)}`} label={`Workspace · ${workspace.name}`} workspace />;
}

interface Form {
  query: string;
  files: boolean;
  memories: boolean;
  collectionId: string;
  fileId: string;
  tags: string[];
  tagMatch: 'any' | 'all';
  memoryType: '' | MemoryType;
  includeSuperseded: boolean;
  includeGlobal: boolean;
  limit: string;
  minScore: string;
}
const INITIAL: Form = {
  query: '',
  files: true,
  memories: true,
  collectionId: '',
  fileId: '',
  tags: [],
  tagMatch: 'any',
  memoryType: '',
  includeSuperseded: false,
  includeGlobal: false,
  limit: String(DEFAULT_LIMIT),
  minScore: '',
};

type FieldErrors = Partial<Record<'query' | 'limit' | 'minScore', string>>;

/** Builds the validated search contract from the form, or the field errors. Inapplicable filters are never sent. */
export function buildRequest(f: Form, workspace: boolean): { ok: true; body: SearchRequestDto } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const query = f.query.trim();
  if (!query) errors.query = 'Enter something to search for.';
  else if ([...query].length > 2000) errors.query = 'Query must be at most 2000 characters.';
  const limit = Number(f.limit);
  if (f.limit.trim() === '' || !Number.isInteger(limit) || limit < 1 || limit > 50) errors.limit = 'Enter a whole number from 1 to 50.';
  let minScore: number | undefined;
  if (f.minScore.trim() !== '') {
    minScore = Number(f.minScore);
    if (!Number.isFinite(minScore)) errors.minScore = 'Enter a number.';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const types: SearchKind[] = [...(f.files ? (['files'] as const) : []), ...(f.memories ? (['memories'] as const) : [])];
  const body: SearchRequestDto = { query, types, limit };
  if (f.files && f.collectionId) body.collectionIds = [f.collectionId];
  if (f.files && f.fileId) body.fileIds = [f.fileId];
  if (f.tags.length > 0) {
    body.tags = f.tags;
    body.tagMatch = f.tagMatch;
  }
  if (f.memories && f.memoryType) body.memoryTypes = [f.memoryType];
  if (f.memories && f.includeSuperseded) body.includeSuperseded = true;
  if (workspace) body.includeGlobal = f.includeGlobal;
  if (minScore !== undefined) body.minScore = minScore;
  return { ok: true, body };
}

type ResultState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string; session: boolean; body: SearchRequestDto }
  | { status: 'ready'; query: string; results: SearchResultDto[]; degraded: boolean };

interface Options {
  collections: CollectionDto[];
  files: FileDto[];
  tags: TagDto[];
  /** True when the scope's options could not be read (for example missing permission); filters then stay unavailable. */
  unavailable: boolean;
}
const NO_OPTIONS: Options = { collections: [], files: [], tags: [], unavailable: false };

function SearchPanel({ base, label, workspace }: { base: string; label: string; workspace: boolean }) {
  const [form, setForm] = useState<Form>(INITIAL);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [result, setResult] = useState<ResultState>({ status: 'idle' });
  const [options, setOptions] = useState<Options>(NO_OPTIONS);
  const inFlight = useRef<AbortController | null>(null);
  const latest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      latest.current++;
      inFlight.current?.abort();
    };
  }, []);

  // Options come from the scope's own Collection, file and tag lists, only for the kinds being searched. A failure
  // (for example a missing permission) leaves the filter empty; nothing is looked up on another route.
  useEffect(() => {
    const ctl = new AbortController();
    const read = async <T,>(path: string): Promise<T | null> => {
      try {
        const res = await apiFetch(`${base}${path}`, { signal: ctl.signal });
        return res.ok ? ((await res.json()) as T) : null;
      } catch {
        return null;
      }
    };
    void (async () => {
      const [collections, files, tags] = await Promise.all([
        form.files ? read<CollectionDto[]>('/collections') : Promise.resolve([] as CollectionDto[]),
        form.files ? read<FilePageDto>(`/files?limit=${OPTION_LIMIT}`) : Promise.resolve({ items: [] as FileDto[] } as FilePageDto),
        read<TagDto[]>('/tags'),
      ]);
      if (ctl.signal.aborted || !mounted.current) return;
      setOptions({ collections: collections ?? [], files: files?.items ?? [], tags: tags ?? [], unavailable: collections === null || files === null || tags === null });
    })();
    return () => ctl.abort();
  }, [base, form.files]);

  const run = useCallback(
    async (body: SearchRequestDto) => {
      inFlight.current?.abort();
      const ctl = new AbortController();
      inFlight.current = ctl;
      const id = ++latest.current;
      const current = () => mounted.current && id === latest.current && !ctl.signal.aborted;
      setResult({ status: 'loading' });
      try {
        const res = await apiFetch(`${base}/search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        if (!current()) return;
        if (!res.ok) {
          const f = await failureText(res);
          if (current()) setResult({ status: 'error', message: f.message, session: f.session, body });
          return;
        }
        const data = (await res.json()) as SearchResponseDto;
        if (current()) setResult({ status: 'ready', query: body.query, results: data.results, degraded: data.degraded === 'keyword_only' });
      } catch {
        if (current()) setResult({ status: 'error', message: NETWORK, session: false, body });
      }
    },
    [base],
  );

  /** Any edit while a request is running cancels it, so a response for older input is never shown. */
  function edit(patch: Partial<Form>) {
    setForm((f) => ({ ...f, ...patch }));
    setErrors({});
    if (inFlight.current && result.status === 'loading') {
      latest.current++;
      inFlight.current.abort();
      inFlight.current = null;
      setResult({ status: 'idle' });
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (result.status === 'loading') return;
    const built = buildRequest(form, workspace);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    void run(built.body);
  }

  const loading = result.status === 'loading';
  const onlyOne = form.files !== form.memories;
  const toggleTag = (name: string, on: boolean) => edit({ tags: on ? [...form.tags, name] : form.tags.filter((t) => t !== name) });

  return (
    <section>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <Heading />
      <p className="mb-4 text-muted-foreground">
        Search the indexed Files and active Memories of this {workspace ? 'Workspace' : 'scope'}. Results cite their source.
      </p>

      <form onSubmit={submit} aria-label="Search knowledge" aria-busy={loading} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="search-query">Query</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="search-query"
              type="search"
              className="min-w-0 flex-1"
              value={form.query}
              onChange={(e) => edit({ query: e.target.value })}
              aria-invalid={errors.query ? true : undefined}
              aria-describedby={errors.query ? 'search-query-error' : undefined}
              placeholder="Ask about a topic, a name or an identifier"
            />
            <Button type="submit" disabled={loading}>
              <SearchIcon aria-hidden="true" />
              {loading ? 'Searching…' : 'Search'}
            </Button>
          </div>
          {errors.query && (
            <p id="search-query-error" className="text-sm text-destructive break-words">
              {errors.query}
            </p>
          )}
        </div>

        <fieldset className="flex flex-wrap items-center gap-4 border-0 p-0">
          <legend className="mb-1 text-sm font-medium">Search in</legend>
          <div className="flex items-center gap-2">
            <Checkbox id="search-files" checked={form.files} disabled={form.files && onlyOne} onCheckedChange={(v) => edit({ files: v === true })} />
            <Label htmlFor="search-files">Files</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="search-memories" checked={form.memories} disabled={form.memories && onlyOne} onCheckedChange={(v) => edit({ memories: v === true })} />
            <Label htmlFor="search-memories">Memories</Label>
          </div>
          <p className="text-sm text-muted-foreground">At least one must stay selected.</p>
        </fieldset>

        <div className="flex flex-row flex-wrap items-end gap-3">
          {form.files && (
            <>
              <div className="flex min-w-0 flex-col gap-1">
                <Label htmlFor="search-collection">Collection</Label>
                <Select id="search-collection" value={form.collectionId} onChange={(e) => edit({ collectionId: e.target.value })}>
                  <option value="">All Collections</option>
                  {options.collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <Label htmlFor="search-file">File</Label>
                <Select id="search-file" value={form.fileId} onChange={(e) => edit({ fileId: e.target.value })}>
                  <option value="">All files</option>
                  {options.files.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              </div>
            </>
          )}
          {form.memories && (
            <div className="flex min-w-0 flex-col gap-1">
              <Label htmlFor="search-memory-type">Memory type</Label>
              <Select id="search-memory-type" value={form.memoryType} onChange={(e) => edit({ memoryType: e.target.value as Form['memoryType'] })}>
                <option value="">Any type</option>
                {MEMORY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor="search-limit">Result limit</Label>
            <Input id="search-limit" type="number" inputMode="numeric" min={1} max={50} className="w-24" value={form.limit} onChange={(e) => edit({ limit: e.target.value })} aria-invalid={errors.limit ? true : undefined} aria-describedby={errors.limit ? 'search-limit-error' : undefined} />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor="search-min-score">Minimum score</Label>
            <Input id="search-min-score" type="text" inputMode="decimal" className="w-28" value={form.minScore} onChange={(e) => edit({ minScore: e.target.value })} placeholder="None" aria-invalid={errors.minScore ? true : undefined} aria-describedby={errors.minScore ? 'search-min-score-error' : 'search-min-score-hint'} />
          </div>
        </div>
        {errors.limit && (
          <p id="search-limit-error" className="text-sm text-destructive break-words">
            {errors.limit}
          </p>
        )}
        {errors.minScore && (
          <p id="search-min-score-error" className="text-sm text-destructive break-words">
            {errors.minScore}
          </p>
        )}
        <p id="search-min-score-hint" className="text-sm text-muted-foreground">
          The minimum score applies to the combined ranking score, which is small (about 0.01 to 0.03). Leave it empty to keep every match.
        </p>

        {(options.tags.length > 0 || form.tags.length > 0) && (
          <fieldset className="flex flex-wrap items-center gap-3 border-0 p-0">
            <legend className="mb-1 text-sm font-medium">Tags</legend>
            {options.tags.map((t) => (
              <div key={t.id} className="flex items-center gap-2">
                <Checkbox id={`search-tag-${t.id}`} checked={form.tags.includes(t.name)} onCheckedChange={(v) => toggleTag(t.name, v === true)} />
                <Label htmlFor={`search-tag-${t.id}`}>{t.name}</Label>
              </div>
            ))}
            <div className="flex min-w-0 flex-col gap-1">
              <Label htmlFor="search-tag-match" className="sr-only">
                Tag matching
              </Label>
              <Select id="search-tag-match" value={form.tagMatch} onChange={(e) => edit({ tagMatch: e.target.value as 'any' | 'all' })}>
                <option value="any">Match any tag</option>
                <option value="all">Match all tags</option>
              </Select>
            </div>
          </fieldset>
        )}
        {options.unavailable && <p className="text-sm text-muted-foreground">Some filter options could not be loaded. You can still search.</p>}

        <div className="flex flex-wrap items-center gap-4">
          {form.memories && (
            <div className="flex items-center gap-2">
              <Checkbox id="search-superseded" checked={form.includeSuperseded} onCheckedChange={(v) => edit({ includeSuperseded: v === true })} />
              <Label htmlFor="search-superseded">Include superseded Memories</Label>
            </div>
          )}
          {workspace && (
            <div className="flex items-center gap-2">
              <Checkbox id="search-include-global" checked={form.includeGlobal} onCheckedChange={(v) => edit({ includeGlobal: v === true })} />
              <Label htmlFor="search-include-global">Include Global</Label>
            </div>
          )}
        </div>
      </form>

      <div className="mt-6" aria-live="polite">
        {result.status === 'idle' && <EmptyState icon={SearchIcon} title="Search your knowledge" description="Enter a query to find matching file passages and Memories." />}
        {result.status === 'loading' && (
          <div role="status" aria-busy="true" aria-label="Searching" className="flex flex-col gap-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
        {result.status === 'error' && (
          <ErrorState title="Search failed" message={result.message} onRetry={result.session ? undefined : () => void run(result.body)} retryLabel="Retry search" />
        )}
        {result.status === 'ready' && (
          <>
            {result.degraded && (
              <p role="status" className="mb-3 rounded-md border border-border bg-muted px-3 py-2 text-sm">
                Showing keyword matches only. Semantic search is unavailable right now, so some relevant results may be missing.
              </p>
            )}
            {result.results.length === 0 ? (
              <EmptyState icon={SearchIcon} title="No results" description="Nothing matched. Try other words, fewer filters, or include more types." />
            ) : (
              <ol aria-label="Search results" className="m-0 flex list-none flex-col gap-3 p-0">
                {result.results.map((r) => (
                  <ResultItem key={`${r.kind}-${r.id}-${r.scope.kind}`} r={r} query={result.query} />
                ))}
              </ol>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightSegments(text, query).map((s, i) =>
        s.match ? (
          <mark key={i} className="rounded-sm bg-primary/30 px-0.5 font-medium text-foreground underline decoration-primary underline-offset-2">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function ResultItem({ r, query }: { r: SearchResultDto; query: string }) {
  const link = 'rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring break-words';
  const scopeText = r.scope.kind === 'global' ? 'Global' : `Workspace ${r.scope.slug}`;
  return (
    <li className="min-w-0 rounded-md border border-border p-3" data-kind={r.kind} data-scope={r.scope.kind}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{r.kind === 'chunk' ? 'File' : 'Memory'}</Badge>
        <ScopeBadge scope={r.scope.kind} aria-label={scopeText} />
        {r.kind === 'memory' && <TypeBadge type={r.memoryType} />}
        {r.kind === 'memory' && r.status === 'superseded' && <StatusBadge status="superseded" />}
        <span className="text-sm text-muted-foreground">Score {r.score.toFixed(4)}</span>
      </div>
      {r.kind === 'chunk' ? (
        <>
          <p className="min-w-0">
            <Link href={resultHref(r)} className={link}>
              {r.file.name}
            </Link>
          </p>
          <p className="text-sm text-muted-foreground break-words">
            Chunk {r.ordinal + 1} · {describeLocation(r.location)}
          </p>
        </>
      ) : (
        <>
          <p className="min-w-0">
            <Link href={resultHref(r)} className={link}>
              {r.title ?? 'Untitled Memory'}
            </Link>
          </p>
          {r.tags.length > 0 && <p className="text-sm text-muted-foreground break-words">Tags: {r.tags.join(', ')}</p>}
        </>
      )}
      <p className="mt-2 text-sm break-words whitespace-pre-wrap">
        <Highlighted text={excerpt(r.content, query)} query={query} />
      </p>
    </li>
  );
}
