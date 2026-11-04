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
  createdAt: string;
  updatedAt: string;
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
