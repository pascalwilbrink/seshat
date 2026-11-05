import type { ChunkLocation } from './chunk.entity.js';

/**
 * A chunk as shown to clients: content and source location only. Never the embedding, its model, the content hash,
 * the storage key or any scope column.
 */
export interface ChunkDto {
  id: string;
  fileId: string;
  ordinal: number;
  content: string;
  charCount: number;
  location: ChunkLocation;
}

export interface ChunkPage {
  items: ChunkDto[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface ChunkRow {
  id: string;
  file_id: string;
  ordinal: number;
  content: string;
  char_count: number;
  location: unknown;
}

/** Copies the known location fields one by one so nothing unexpected stored in the JSON can leak. */
export function toChunkLocation(raw: unknown): ChunkLocation {
  const l = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: ChunkLocation = {
    startOffset: Number(l.startOffset ?? 0),
    endOffset: Number(l.endOffset ?? 0),
    startLine: Number(l.startLine ?? 1),
    endLine: Number(l.endLine ?? 1),
  };
  if (typeof l.section === 'string') out.section = l.section;
  if (Array.isArray(l.headingPath)) out.headingPath = l.headingPath.filter((h): h is string => typeof h === 'string');
  if (typeof l.page === 'number') out.page = l.page;
  return out;
}

export function toChunkDto(r: ChunkRow): ChunkDto {
  return { id: r.id, fileId: r.file_id, ordinal: r.ordinal, content: r.content, charCount: r.char_count, location: toChunkLocation(r.location) };
}
