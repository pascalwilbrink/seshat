import { z } from 'zod';
import { FILE_NAME_MAX_LENGTH } from './file-name.js';
import type { IngestionStatus } from './file.entity.js';

/** Allowlisted file metadata. Never includes the storage key or any filesystem path. */
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
  /** Allowlisted, fixed failure text of the last ingestion (never a raw provider or driver message); null otherwise. */
  ingestionError: string | null;
  /** When the file last reached `indexed`; null until then. */
  indexedAt: string | null;
  /** Number of chunks stored for the file. */
  chunkCount: number;
  /** Server-owned provenance; `createdBy` is null for files that predate it. Never settable by a client. */
  provenance: {
    createdBy: { kind: 'admin' | 'api_key'; keyId: string | null; keyName: string | null } | null;
    client: { name: string; version: string | null } | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface FileRow {
  id: string;
  scope: 'global' | 'workspace';
  workspace_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string;
  size_bytes: string | number;
  sha256: string;
  collection_id: string | null;
  ingestion_status: IngestionStatus;
  ingestion_error: string | null;
  indexed_at: Date | string | null;
  chunk_count: number | string;
  created_by_kind: 'admin' | 'api_key' | null;
  created_by_key_id: string | null;
  created_by_key_name: string | null;
  client_name: string | null;
  client_version: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export function toFileDto(r: FileRow, tags: string[]): FileDto {
  return {
    id: r.id,
    scope: r.scope,
    workspaceId: r.workspace_id,
    name: r.name,
    extension: r.extension,
    mimeType: r.mime_type,
    sizeBytes: Number(r.size_bytes),
    sha256: r.sha256.trim(),
    collectionId: r.collection_id,
    tags,
    ingestionStatus: r.ingestion_status,
    ingestionError: r.ingestion_error ?? null,
    indexedAt: r.indexed_at ? new Date(r.indexed_at).toISOString() : null,
    chunkCount: Number(r.chunk_count ?? 0),
    provenance: {
      createdBy: r.created_by_kind
        ? { kind: r.created_by_kind, keyId: r.created_by_key_id ?? null, keyName: r.created_by_key_name ?? null }
        : null,
      client: r.client_name ? { name: r.client_name, version: r.client_version ?? null } : null,
    },
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/**
 * `PUT` body: the display name, the Collection (null clears it) and the full tag-name list (replaces the
 * current tags); all three are required. Everything else, including ownership, storage, hash, size and status, is an unknown field (400).
 * Collection and tag contents are validated in the service (uniform 400s).
 */
export const updateFileSchema = z
  .strictObject({
    name: z
      .string({ error: 'Name must be a string' })
      .trim()
      .min(1, 'Name must not be empty')
      .max(FILE_NAME_MAX_LENGTH * 4, 'Name is too long'),
    collectionId: z.string({ error: 'Collection must be a string or null' }).nullable(),
    tags: z.array(z.string({ error: 'Tags must be strings' })).max(100, 'Too many tags'),
  });
export type UpdateFileInput = z.infer<typeof updateFileSchema>;
