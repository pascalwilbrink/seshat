import type { CollectionDto } from './collection.dto.js';

/** A `collections` row joined with its same-scope file count (raw column names). */
export interface CollectionRow {
  id: string;
  name: string;
  description: string | null;
  file_count: string | number;
  created_at: Date | string;
  updated_at: Date | string;
}

export function toCollectionDto(r: CollectionRow): CollectionDto {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    fileCount: Number(r.file_count),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
