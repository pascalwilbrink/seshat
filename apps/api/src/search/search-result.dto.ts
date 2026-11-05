import type { ChunkLocation } from '../ingestion/chunk.entity.js';
import { toChunkLocation } from '../ingestion/chunk.dto.js';
import type { MemoryCreatedByKind, MemoryStatus, MemoryType } from '../memories/memory.entity.js';

/** Where a result lives. Global is a scope, never a Workspace. */
export type SearchResultScope = { kind: 'global' } | { kind: 'workspace'; id: string; slug: string };

/** Fields shared by every result. */
interface SearchResultBase {
  /** Fused (reciprocal rank fusion) score: the sum of 1/(60 + rank) over the rankings the item appears in. Higher is better. */
  score: number;
  /** 1-based position in the vector ranking; null when the item was not a vector candidate (keyword only, or degraded). */
  vectorRank: number | null;
  /** 1-based position in the keyword ranking; null when the item was not a keyword candidate. */
  keywordRank: number | null;
  scope: SearchResultScope;
  content: string;
}

export interface ChunkSearchResult extends SearchResultBase {
  kind: 'chunk';
  /** Chunk id. */
  id: string;
  file: { id: string; name: string };
  collectionId: string | null;
  ordinal: number;
  location: ChunkLocation;
}

export interface MemorySearchResult extends SearchResultBase {
  kind: 'memory';
  /** Memory id. */
  id: string;
  memoryType: MemoryType;
  title: string | null;
  tags: string[];
  status: MemoryStatus;
  confidence: number | null;
  source: string | null;
  provenance: {
    createdBy: { kind: MemoryCreatedByKind; keyId: string | null; keyName: string | null };
    client: { name: string; version: string | null } | null;
  };
  updatedAt: string;
}

export type SearchResult = ChunkSearchResult | MemorySearchResult;

/**
 * The response. Deliberately has no total, no count of candidates or excluded items, no vectors, storage keys or
 * authentication data. `degraded` is present only when the query could not be embedded and results are keyword-only.
 */
export interface SearchResponse {
  results: SearchResult[];
  degraded?: 'keyword_only';
}

/** Rank/score inputs of one fused item. */
export interface FusedScores {
  score: number;
  vectorRank: number | null;
  keywordRank: number | null;
}

/** Row-shaped input for the chunk projection. Extra properties on the object passed in are never copied. */
export interface ChunkResultSource extends FusedScores {
  id: string;
  content: string;
  ordinal: number;
  location: unknown;
  fileId: string;
  fileName: string;
  collectionId: string | null;
  scope: SearchResultScope;
}

export interface MemoryResultSource extends FusedScores {
  id: string;
  content: string;
  scope: SearchResultScope;
  type: MemoryType;
  title: string | null;
  tags: readonly string[];
  status: MemoryStatus;
  confidence: number | null;
  source: string | null;
  createdByKind: MemoryCreatedByKind;
  createdByKeyId: string | null;
  createdByKeyName: string | null;
  clientName: string | null;
  clientVersion: string | null;
  updatedAt: Date | string;
}

const projectScope = (s: SearchResultScope): SearchResultScope =>
  s.kind === 'global' ? { kind: 'global' } : { kind: 'workspace', id: s.id, slug: s.slug };

/** Explicit field-by-field projection: a new column or join field never reaches a response by accident. */
export function toChunkSearchResult(s: ChunkResultSource): ChunkSearchResult {
  return {
    kind: 'chunk',
    id: s.id,
    score: s.score,
    vectorRank: s.vectorRank,
    keywordRank: s.keywordRank,
    scope: projectScope(s.scope),
    content: s.content,
    file: { id: s.fileId, name: s.fileName },
    collectionId: s.collectionId,
    ordinal: s.ordinal,
    location: toChunkLocation(s.location),
  };
}

export function toMemorySearchResult(s: MemoryResultSource): MemorySearchResult {
  return {
    kind: 'memory',
    id: s.id,
    score: s.score,
    vectorRank: s.vectorRank,
    keywordRank: s.keywordRank,
    scope: projectScope(s.scope),
    content: s.content,
    memoryType: s.type,
    title: s.title,
    tags: [...s.tags],
    status: s.status,
    confidence: s.confidence,
    source: s.source,
    provenance: {
      createdBy: { kind: s.createdByKind, keyId: s.createdByKeyId, keyName: s.createdByKeyName },
      client: s.clientName ? { name: s.clientName, version: s.clientVersion } : null,
    },
    updatedAt: new Date(s.updatedAt).toISOString(),
  };
}
