import type { ChunkLocationDto, SearchResultDto, SearchResultScopeDto } from './api-types';
import { scopeHref } from './scope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TERMS = 20;
const EXCERPT_CHARS = 500;
const EXCERPT_LEAD = 150;

export interface Segment {
  text: string;
  match: boolean;
}

/**
 * Terms worth highlighting in a websearch-style query: words and quoted phrases without operators.
 * Negated terms (`-word`) and the `or` operator are not highlighted.
 */
export function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  const re = /(-?)"([^"]+)"|(-?)(\S+)/g;
  for (const m of query.matchAll(re)) {
    const negated = (m[1] ?? m[3]) === '-';
    const raw = (m[2] ?? m[4] ?? '').replace(/^["']+|["']+$/g, '').trim();
    if (negated || raw.length < 2 || raw.toLowerCase() === 'or') continue;
    terms.add(raw.toLowerCase());
    if (terms.size >= MAX_TERMS) break;
  }
  return [...terms].sort((a, b) => b.length - a.length);
}

/**
 * Splits plain text into matching and non-matching segments. The result is rendered as React text nodes, so
 * no markup in the text or in the query is ever interpreted.
 */
export function highlightSegments(text: string, query: string): Segment[] {
  const terms = queryTerms(query);
  if (terms.length === 0 || text.length === 0) return [{ text, match: false }];
  const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'giu');
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0) continue;
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), match: false });
    out.push({ text: m[0], match: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), match: false });
  return out.length > 0 ? out : [{ text, match: false }];
}

/** A bounded excerpt that starts shortly before the first matching term. Plain text in, plain text out. */
export function excerpt(content: string, query: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (text.length <= EXCERPT_CHARS) return text;
  const lower = text.toLowerCase();
  let first = -1;
  for (const t of queryTerms(query)) {
    const at = lower.indexOf(t);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  const start = first > EXCERPT_LEAD ? first - EXCERPT_LEAD : 0;
  const end = Math.min(text.length, start + EXCERPT_CHARS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function describeLocation(l: ChunkLocationDto): string {
  const path = l.headingPath && l.headingPath.length > 0 ? l.headingPath.join(' › ') : (l.section ?? null);
  const lines = l.startLine === l.endLine ? `line ${l.startLine}` : `lines ${l.startLine}–${l.endLine}`;
  const parts = [path, l.page != null ? `page ${l.page}` : null, lines].filter((p): p is string => Boolean(p));
  return parts.join(' · ');
}

function resultScope(s: SearchResultScopeDto) {
  return s.kind === 'global' ? ({ kind: 'global' } as const) : ({ kind: 'workspace', slug: s.slug } as const);
}

/**
 * Where a result opens, built from the result's own scope (never the page's): a Global result on a Workspace
 * page opens the Global detail. Chunks open their file with the chunk selected, Memories open their detail.
 */
export function resultHref(r: SearchResultDto): string {
  const scope = resultScope(r.scope);
  if (r.kind === 'chunk') {
    const p = new URLSearchParams({ file: r.file.id, chunk: r.id, ordinal: String(r.ordinal) });
    return `${scopeHref(scope, 'files')}?${p.toString()}`;
  }
  return `${scopeHref(scope, 'memories')}?${new URLSearchParams({ memory: r.id }).toString()}`;
}

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const uuid = (v: string | string[] | undefined) => {
  const s = one(v);
  return s && UUID.test(s) ? s : null;
};

export interface FileFocus {
  fileId: string;
  chunkId: string | null;
  ordinal: number | null;
}

/** The file (and chunk) a search link points at. Anything that is not a UUID or a small integer is ignored. */
export function parseFileFocus(params: Params): FileFocus | null {
  const fileId = uuid(params.file);
  if (!fileId) return null;
  const raw = one(params.ordinal);
  const n = raw !== undefined && /^\d{1,7}$/.test(raw) ? Number(raw) : null;
  return { fileId, chunkId: uuid(params.chunk), ordinal: n };
}

export function parseMemoryFocus(params: Params): string | null {
  return uuid(params.memory);
}
