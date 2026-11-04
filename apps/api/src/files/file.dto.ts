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
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
