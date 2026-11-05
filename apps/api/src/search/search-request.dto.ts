import { z } from 'zod';
import { MEMORY_TYPES, type MemoryType } from '../memories/memory.entity.js';
import { isValidTagName, normalizeTagName } from '../tags/tag-name.js';
import { isUuid } from '../scopes/scope-ref.js';
import { CONTEXT_MAX_CHARS_DEFAULT, CONTEXT_MAX_CHARS_MAX, CONTEXT_MIN_CHARS } from './context-formatter.js';
import { SEARCH_TYPES, type SearchType } from './search-plan.js';

export const SEARCH_QUERY_MAX = 2000;
export const SEARCH_LIMIT_DEFAULT = 10;
export const SEARCH_LIMIT_MAX = 50;
/** Upper bound of every id/tag filter list; keeps SQL parameter lists bounded. */
export const SEARCH_FILTER_LIST_MAX = 100;
export const TAG_MATCH_VALUES = ['any', 'all'] as const;
export type TagMatch = (typeof TAG_MATCH_VALUES)[number];

/** Counts Unicode code points, like Postgres `char_length`. */
const codePoints = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

const dedupe = <T>(items: readonly T[]): T[] => [...new Set(items)];

const query = z
  .string({ error: 'Query must be a string' })
  .refine((s) => s.length <= SEARCH_QUERY_MAX * 2 && codePoints(s) <= SEARCH_QUERY_MAX, `Query must be at most ${SEARCH_QUERY_MAX} characters`)
  .refine((s) => s.trim().length >= 1, 'Query must not be empty')
  .transform((s) => s.trim());

const types = z
  .array(z.enum(SEARCH_TYPES, { error: 'Types must be files or memories' }), { error: 'Types must be an array' })
  .min(1, 'Select at least one type')
  .max(SEARCH_FILTER_LIST_MAX, 'Too many types')
  .transform((v) => dedupe(v));

const uuidList = (label: string) =>
  z
    .array(z.string({ error: `${label} must be strings` }).refine(isUuid, `${label} must be UUIDs`), { error: `${label} must be an array` })
    .min(1, `${label} must not be empty; omit the field instead`)
    .max(SEARCH_FILTER_LIST_MAX, `Too many ${label}`)
    .transform((v) => dedupe(v.map((id) => id.toLowerCase())));

const tags = z
  .array(
    z
      .string({ error: 'Tags must be strings' })
      .transform(normalizeTagName)
      .refine(isValidTagName, 'Invalid tag name'),
    { error: 'Tags must be an array' },
  )
  .min(1, 'Tags must not be empty; omit the field instead')
  .max(SEARCH_FILTER_LIST_MAX, 'Too many tags')
  .transform((v) => dedupe(v));

const memoryTypes = z
  .array(z.enum(MEMORY_TYPES, { error: 'Memory types must be fact, decision, preference, experience, procedure or context' }), {
    error: 'Memory types must be an array',
  })
  .min(1, 'Memory types must not be empty; omit the field instead')
  .max(SEARCH_FILTER_LIST_MAX, 'Too many memory types')
  .transform((v) => dedupe(v));

/** Fields shared by the Global and the Workspace request. */
const sharedShape = {
  query,
  types: types.default(['files', 'memories']),
  collectionIds: uuidList('Collection ids').optional(),
  fileIds: uuidList('File ids').optional(),
  tags: tags.optional(),
  tagMatch: z.enum(TAG_MATCH_VALUES, { error: 'Tag match must be any or all' }).default('any'),
  memoryTypes: memoryTypes.optional(),
  includeSuperseded: z.boolean({ error: 'Include superseded must be a boolean' }).default(false),
  limit: z
    .number({ error: 'Limit must be a number' })
    .int('Limit must be an integer')
    .min(1, 'Limit must be at least 1')
    .max(SEARCH_LIMIT_MAX, `Limit must be at most ${SEARCH_LIMIT_MAX}`)
    .default(SEARCH_LIMIT_DEFAULT),
  /**
   * Minimum FUSED score (sum of 1/(60 + rank) over the rankings an item appears in), not a raw cosine distance or
   * similarity. Applied after fusion and before the cut to `limit`.
   */
  minScore: z.number({ error: 'Minimum score must be a finite number' }).finite('Minimum score must be a finite number').optional(),
};

/** `POST /api/global/search`. Strict: `includeGlobal` and anything unknown is a 400. */
export const globalSearchRequestSchema = z.strictObject(sharedShape);

/** `POST /api/workspaces/:workspaceId/search`. `includeGlobal` exists only here and is off by default. */
export const workspaceSearchRequestSchema = z.strictObject({
  ...sharedShape,
  includeGlobal: z.boolean({ error: 'Include Global must be a boolean' }).default(false),
});

/** Context requests are search requests plus the character budget of the returned text. */
const maxChars = z
  .number({ error: 'Max chars must be a number' })
  .int('Max chars must be an integer')
  .min(CONTEXT_MIN_CHARS, `Max chars must be at least ${CONTEXT_MIN_CHARS}, the size of the mandatory warning and delimiters`)
  .max(CONTEXT_MAX_CHARS_MAX, `Max chars must be at most ${CONTEXT_MAX_CHARS_MAX}`)
  .default(CONTEXT_MAX_CHARS_DEFAULT);

/** `POST /api/global/context`. */
export const globalContextRequestSchema = z.strictObject({ ...sharedShape, maxChars });
/** `POST /api/workspaces/:workspaceId/context`. */
export const workspaceContextRequestSchema = z.strictObject({ ...sharedShape, includeGlobal: workspaceSearchRequestSchema.shape.includeGlobal, maxChars });
export type GlobalContextRequest = z.infer<typeof globalContextRequestSchema>;
export type WorkspaceContextRequest = z.infer<typeof workspaceContextRequestSchema>;

export type GlobalSearchRequest = z.infer<typeof globalSearchRequestSchema>;
export type WorkspaceSearchRequest = z.infer<typeof workspaceSearchRequestSchema>;
/** The validated request as the retrieval layer sees it (`includeGlobal` is false for the Global route). */
export type SearchRequest = Omit<WorkspaceSearchRequest, 'includeGlobal'> & { includeGlobal: boolean };

/** Normalizes a validated request of either route to one shape. */
export function toSearchRequest(request: GlobalSearchRequest | WorkspaceSearchRequest): SearchRequest {
  return { ...request, includeGlobal: 'includeGlobal' in request ? request.includeGlobal : false };
}

/** Filters that constrain chunks of files. Memories are never in Collections, so these never constrain Memories. */
export interface ChunkFilters {
  readonly collectionIds: readonly string[] | null;
  readonly fileIds: readonly string[] | null;
  readonly tags: readonly string[] | null;
  readonly tagMatch: TagMatch;
}

/** Filters that constrain Memories. `types` null means every type. */
export interface MemoryFilters {
  readonly types: readonly MemoryType[] | null;
  readonly includeSuperseded: boolean;
  readonly tags: readonly string[] | null;
  readonly tagMatch: TagMatch;
}

/**
 * The single definition of which filter constrains which kind, so every query branch agrees:
 * - Collection and file filters constrain chunks only (the file's Collection / the chunk's file).
 * - Memory type and superseded filters constrain Memories only.
 * - Tags constrain both (file tags for chunks, memory tags for Memories), with the same any/all semantics.
 * A filter that does not apply to a kind never narrows that kind: `collectionIds` with a Memory in the result set
 * leaves the Memory candidates alone. Filter ids are never checked for existence or access; an id the caller cannot
 * see simply matches nothing (callers must not look it up).
 */
export function splitSearchFilters(request: Pick<SearchRequest, 'collectionIds' | 'fileIds' | 'tags' | 'tagMatch' | 'memoryTypes' | 'includeSuperseded'>): {
  chunk: ChunkFilters;
  memory: MemoryFilters;
} {
  return {
    chunk: {
      collectionIds: request.collectionIds ?? null,
      fileIds: request.fileIds ?? null,
      tags: request.tags ?? null,
      tagMatch: request.tagMatch,
    },
    memory: {
      types: request.memoryTypes ?? null,
      includeSuperseded: request.includeSuperseded,
      tags: request.tags ?? null,
      tagMatch: request.tagMatch,
    },
  };
}

export type { SearchType };
