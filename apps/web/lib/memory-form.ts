import type { MemoryDto, MemoryType } from './api-types';

/** Server bounds (apps/api memory.entity.ts / tag.entity.ts), checked here only for early feedback. */
export const MEMORY_LIMITS = { content: 10000, title: 200, source: 500, tags: 100, tagName: 50 } as const;
const TAG_PATTERN = /^[a-z0-9_.:/-]+$/;

export interface MemoryFormValues {
  type: MemoryType;
  title: string;
  content: string;
  tags: string;
  confidence: string;
  source: string;
}

export const EMPTY_FORM: MemoryFormValues = { type: 'fact', title: '', content: '', tags: '', confidence: '', source: '' };

export function formFromMemory(m: MemoryDto): MemoryFormValues {
  return {
    type: m.type,
    title: m.title ?? '',
    content: m.content,
    tags: m.tags.join(', '),
    confidence: m.confidence === null ? '' : String(m.confidence),
    source: m.source ?? '',
  };
}

const points = (s: string) => [...s].length;

/** Trims, lowercases and de-duplicates a comma/newline separated tag list (same normalization as the server). */
export function parseTags(raw: string): string[] {
  return [...new Set(raw.split(/[,\n]/).map((t) => t.trim().toLowerCase()).filter((t) => t !== ''))];
}

export type FormErrors = Partial<Record<'type' | 'title' | 'content' | 'tags' | 'confidence' | 'source', string>>;

export function validateForm(v: MemoryFormValues): FormErrors {
  const e: FormErrors = {};
  if (v.content.trim() === '') e.content = 'Content is required.';
  else if (points(v.content) > MEMORY_LIMITS.content) e.content = `Content can be at most ${MEMORY_LIMITS.content} characters.`;
  if (points(v.title) > MEMORY_LIMITS.title) e.title = `Title can be at most ${MEMORY_LIMITS.title} characters.`;
  if (points(v.source) > MEMORY_LIMITS.source) e.source = `Source can be at most ${MEMORY_LIMITS.source} characters.`;
  if (v.confidence.trim() !== '') {
    const n = Number(v.confidence);
    if (!Number.isFinite(n) || n < 0 || n > 1) e.confidence = 'Confidence must be a number between 0 and 1.';
  }
  const tags = parseTags(v.tags);
  if (tags.length > MEMORY_LIMITS.tags) e.tags = `At most ${MEMORY_LIMITS.tags} tags.`;
  else if (tags.some((t) => t.length > MEMORY_LIMITS.tagName || !TAG_PATTERN.test(t)))
    e.tags = `Tags are 1-${MEMORY_LIMITS.tagName} characters: letters, digits, "-", "_", ".", ":" and "/".`;
  return e;
}

/** Optional fields: an empty input is null (clears on PUT, omitted on POST). */
const orNull = (s: string): string | null => (s.trim() === '' ? null : s);

/** POST body. Never contains provenance, scope, status or lifecycle fields. */
export function buildCreateBody(v: MemoryFormValues, supersedes: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = { type: v.type, content: v.content, tags: parseTags(v.tags) };
  if (orNull(v.title) !== null) body.title = v.title;
  if (orNull(v.source) !== null) body.source = v.source;
  if (v.confidence.trim() !== '') body.confidence = Number(v.confidence);
  if (supersedes) body.supersedes = supersedes;
  return body;
}

/** PUT body: full replacement of every editable field; existing metadata is carried over untouched. */
export function buildUpdateBody(v: MemoryFormValues, existing: MemoryDto): Record<string, unknown> {
  return {
    type: v.type,
    content: v.content,
    title: orNull(v.title),
    metadata: existing.metadata,
    confidence: v.confidence.trim() === '' ? null : Number(v.confidence),
    source: orNull(v.source),
    tags: parseTags(v.tags),
  };
}
