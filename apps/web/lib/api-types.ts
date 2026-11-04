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
