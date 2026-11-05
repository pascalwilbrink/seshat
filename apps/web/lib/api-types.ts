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
