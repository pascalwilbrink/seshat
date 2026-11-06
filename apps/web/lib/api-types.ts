import type { Permission } from '@seshat/domain';

export interface WorkspaceDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OverviewDto =
  | { scope: 'global'; name: string }
  | { scope: 'workspace'; id: string; name: string; slug: string; description: string | null; createdAt: string };

export const USAGE_WINDOWS = [7, 30, 90] as const;
export type UsageWindowDays = (typeof USAGE_WINDOWS)[number];
export type McpOutcome = 'ok' | 'validation_error' | 'forbidden' | 'not_found' | 'unknown_tool' | 'internal_error';

/** `GET .../usage/overview?days=`: one aggregate per scope and window. Only ids, counts, tool names and Workspace identity; never titles or content. */
export interface UsageOverviewDto {
  scope: 'global' | 'workspace';
  workspaceId: string | null;
  window: { days: UsageWindowDays; from: string; to: string };
  files: { total: number; indexed: number; failed: number };
  memories: { total: number; active: number; superseded: number };
  mcp: { calls: number; errors: number; errorRate: number };
  unused: { files: number; memories: number };
  accessesDaily: { day: string; total: number; byChannel: Record<'ui' | 'api' | 'mcp', number> }[];
  callsDaily: { day: string; total: number; byOutcome: Record<McpOutcome, number> }[];
  topTools: { tool: string; calls: number }[];
  topFiles: { id: string; count: number }[];
  topMemories: { id: string; count: number }[];
  /** Global only; null in a Workspace. */
  callsByWorkspace: { workspaceId: string; slug: string; name: string; calls: number }[] | null;
}

export type ApiKeyStatus = 'active' | 'revoked' | 'expired';

/** Safe key metadata as returned by the API: never a secret or digest. */
export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  permissions: Permission[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  status: ApiKeyStatus;
}

/** The creation response is the only one that carries the full key. */
export interface CreatedApiKeyDto {
  apiKey: ApiKeyDto;
  secret: string;
}

/** A Collection as returned by the API; `fileCount` counts files of the same scope only. */
export interface CollectionDto {
  id: string;
  name: string;
  description: string | null;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

export type IngestionStatus = 'pending' | 'processing' | 'indexed' | 'failed';
export const INGESTION_STATUSES: readonly IngestionStatus[] = ['pending', 'processing', 'indexed', 'failed'];

/** File metadata as returned by the API; the original content and storage location are never part of it. */
export interface FileDto {
  id: string;
  scope: 'global' | 'workspace';
  workspaceId: string | null;
  name: string;
  extension: string | null;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  collectionId: string | null;
  tags: string[];
  ingestionStatus: IngestionStatus;
  /** Allowlisted, fixed failure text of the last ingestion; null otherwise. */
  ingestionError: string | null;
  /** When the file last reached `indexed`; null until then. */
  indexedAt: string | null;
  /** Number of chunks stored for the file. */
  chunkCount: number;
  /** Server-owned provenance; `createdBy` is null for files that predate it. */
  provenance: {
    createdBy: { kind: 'admin' | 'api_key'; keyId: string | null; keyName: string | null } | null;
    client: { name: string; version: string | null } | null;
  };
  /** Admin list responses only: accesses in the last 30 UTC days, and the last access ever (null if never accessed). */
  accessCount30d?: number;
  lastAccessedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Where a chunk sits in its original. Embeddings are never part of the API response. */
export interface ChunkLocationDto {
  section?: string;
  headingPath?: string[];
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  page?: number;
}

export interface ChunkDto {
  id: string;
  fileId: string;
  ordinal: number;
  content: string;
  charCount: number;
  location: ChunkLocationDto;
}

export interface ChunkPageDto {
  items: ChunkDto[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface FilePageDto {
  items: FileDto[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface TagDto {
  id: string;
  name: string;
  scope: 'global' | 'workspace';
  workspaceId: string | null;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

export const MEMORY_TYPES = ['fact', 'decision', 'preference', 'experience', 'procedure', 'context'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryStatus = 'active' | 'superseded';
export const MEMORY_LIST_STATUSES = ['active', 'superseded', 'all'] as const;
export type MemoryListStatus = (typeof MEMORY_LIST_STATUSES)[number];
export type MemoryEmbeddingStatus = 'pending' | 'ready' | 'failed';

/** Memory as returned by the API. Titles, content, tags, metadata and provenance names are untrusted text. */
export interface MemoryDto {
  id: string;
  scope: 'global' | 'workspace';
  workspaceId: string | null;
  type: MemoryType;
  content: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
  confidence: number | null;
  source: string | null;
  tags: string[];
  status: MemoryStatus;
  /** Successor in the same scope; null unless superseded, and cleared when the successor is forgotten. */
  supersededBy: string | null;
  provenance: {
    createdBy: { kind: 'admin' | 'api_key'; keyId: string | null; keyName: string | null };
    client: { name: string; version: string | null } | null;
  };
  embeddingStatus: MemoryEmbeddingStatus;
  embeddingModel: string | null;
  /** Admin list responses only: accesses in the last 30 UTC days, and the last access ever (null if never accessed). */
  accessCount30d?: number;
  lastAccessedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryPageDto {
  items: MemoryDto[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

/** Similar active Memory of the same scope offered after a create. Untrusted text. */
export interface MemoryHintDto {
  id: string;
  type: string;
  preview: string;
}

/** Create response: the saved (or reused) Memory, whether it was a duplicate, and similar-Memory hints. */
export type CreateMemoryResultDto = MemoryDto & { deduplicated: boolean; hints: MemoryHintDto[] };

/** Where a search result lives. Global is a scope, never a Workspace. */
export type SearchResultScopeDto = { kind: 'global' } | { kind: 'workspace'; id: string; slug: string };

interface SearchResultBaseDto {
  score: number;
  vectorRank: number | null;
  keywordRank: number | null;
  scope: SearchResultScopeDto;
  /** Untrusted text. */
  content: string;
}

export interface ChunkSearchResultDto extends SearchResultBaseDto {
  kind: 'chunk';
  id: string;
  file: { id: string; name: string };
  collectionId: string | null;
  ordinal: number;
  location: ChunkLocationDto;
}

export interface MemorySearchResultDto extends SearchResultBaseDto {
  kind: 'memory';
  id: string;
  memoryType: MemoryType;
  title: string | null;
  tags: string[];
  status: MemoryStatus;
  confidence: number | null;
  source: string | null;
  provenance: MemoryDto['provenance'];
  updatedAt: string;
}

export type SearchResultDto = ChunkSearchResultDto | MemorySearchResultDto;

/** Deliberately without totals or excluded counts. `degraded` is present only for keyword-only results. */
export interface SearchResponseDto {
  results: SearchResultDto[];
  degraded?: 'keyword_only';
}

export type SearchKind = 'files' | 'memories';

/** The body of `POST .../search`. Only the validated contract; optional fields are omitted, never sent empty. */
export interface SearchRequestDto {
  query: string;
  types: SearchKind[];
  collectionIds?: string[];
  fileIds?: string[];
  tags?: string[];
  tagMatch?: 'any' | 'all';
  memoryTypes?: MemoryType[];
  includeSuperseded?: boolean;
  /** Workspace route only. */
  includeGlobal?: boolean;
  limit: number;
  minScore?: number;
}

export type UsageChannel = 'ui' | 'api' | 'mcp';
export type UsageAccessKind = 'read' | 'retrieved';

/** `GET .../files/:id/usage` and `.../memories/:id/usage`: counts only, never names or content. */
export interface ResourceUsageDto {
  resource: 'file' | 'memory';
  id: string;
  scope: 'global' | 'workspace';
  workspaceId: string | null;
  window: { days: number; from: string; to: string };
  lifetime: { total: number; byChannel: Record<UsageChannel, number>; byKind: Record<UsageAccessKind, number> };
  lastAccessedAt: string | null;
  daily: { day: string; total: number; byChannel: Record<UsageChannel, number>; byKind: Record<UsageAccessKind, number> }[];
}
