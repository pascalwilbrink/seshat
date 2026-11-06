import { z } from 'zod';
import { isValidTagName, normalizeTagName } from '../tags/tag-name.js';
import {
  MEMORY_CONTENT_MAX,
  MEMORY_METADATA_MAX_BYTES,
  MEMORY_SOURCE_MAX,
  MEMORY_TITLE_MAX,
  MEMORY_TYPES,
  type Memory,
  type MemoryCreatedByKind,
  type MemoryEmbeddingStatus,
  type MemoryStatus,
  type MemoryType,
} from './memory.entity.js';
import type { MemoryHint } from './memory-embedding.coordinator.js';
import { normalizeMemoryContent } from './memory-content.js';

/** Counts Unicode code points, like Postgres `char_length`, not UTF-16 units. */
const codePoints = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

const type = z.enum(MEMORY_TYPES, { error: 'Type must be one of fact, decision, preference, experience, procedure, context' });

const content = z
  .string({ error: 'Content must be a string' })
  .refine((s) => s.length <= MEMORY_CONTENT_MAX * 2 && codePoints(s) <= MEMORY_CONTENT_MAX, 'Content is too long')
  .refine((s) => normalizeMemoryContent(s).length >= 1, 'Content must not be empty');

const title = z
  .string({ error: 'Title must be a string or null' })
  .refine((s) => s.length <= MEMORY_TITLE_MAX * 2 && codePoints(s) <= MEMORY_TITLE_MAX, 'Title is too long');

const source = z
  .string({ error: 'Source must be a string or null' })
  .refine((s) => s.length <= MEMORY_SOURCE_MAX * 2 && codePoints(s) <= MEMORY_SOURCE_MAX, 'Source is too long');

const confidence = z.number({ error: 'Confidence must be a number or null' }).min(0, 'Confidence must be between 0 and 1').max(1, 'Confidence must be between 0 and 1');

/** A JSON object (not an array, null or primitive) whose UTF-8 JSON text is at most 8 KB. */
const metadata = z
  .record(z.string(), z.json(), { error: 'Metadata must be a JSON object or null' })
  .refine((v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= MEMORY_METADATA_MAX_BYTES, 'Metadata is too large');

/** Normalized (trim, lowercase), validated and de-duplicated tag names. */
const tags = z
  .array(
    z
      .string({ error: 'Tags must be strings' })
      .transform(normalizeTagName)
      .refine(isValidTagName, 'Invalid tag name'),
    { error: 'Tags must be an array' },
  )
  .max(100, 'Too many tags')
  .transform((names) => [...new Set(names)]);

const uuid = z.uuid({ error: 'Must be a UUID' });

/**
 * `POST` body. Strict: provenance (`createdBy*`, `client*`, `provenance`), scope, status, hash, embedding and every
 * other unknown field are rejected with 400, never ignored. Optional fields may be omitted or null.
 */
export const createMemorySchema = z.strictObject({
  type,
  content,
  title: title.nullish(),
  metadata: metadata.nullish(),
  confidence: confidence.nullish(),
  source: source.nullish(),
  tags: tags.optional(),
  supersedes: uuid.nullish(),
});
export type CreateMemoryInput = z.infer<typeof createMemorySchema>;

/**
 * `PUT` body: full replacement. Every editable field is required; optional values are cleared with an explicit `null`
 * and a missing field is a 400 naming it. `supersedes`, scope, status, hash, embedding and provenance are unknown fields.
 */
export const updateMemorySchema = z.strictObject({
  type,
  content,
  title: title.nullable(),
  metadata: metadata.nullable(),
  confidence: confidence.nullable(),
  source: source.nullable(),
  tags,
});
export type UpdateMemoryInput = z.infer<typeof updateMemorySchema>;

/** Allowlisted Memory response. Never includes the embedding, the content hash, key digests or authentication data. */
export interface MemoryDto {
  /** Admin list responses only (absent for API keys): accesses in the last 30 UTC days and the last access ever. */
  accessCount30d?: number;
  lastAccessedAt?: string | null;
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
  /** Id of the successor in the same scope; null unless superseded (and cleared when the successor is forgotten). */
  supersededBy: string | null;
  provenance: {
    createdBy: { kind: MemoryCreatedByKind; keyId: string | null; keyName: string | null };
    client: { name: string; version: string | null } | null;
  };
  embeddingStatus: MemoryEmbeddingStatus;
  embeddingModel: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Explicit field-by-field projection: a new entity column never reaches a response by accident. */
export function toMemoryDto(m: Memory, tagNames: readonly string[]): MemoryDto {
  return {
    id: m.id,
    scope: m.scope,
    workspaceId: m.workspaceId,
    type: m.type,
    content: m.content,
    title: m.title,
    metadata: m.metadata,
    confidence: m.confidence,
    source: m.source,
    tags: [...tagNames],
    status: m.status,
    supersededBy: m.supersededBy,
    provenance: {
      createdBy: { kind: m.createdByKind, keyId: m.createdByKeyId, keyName: m.createdByKeyName },
      client: m.clientName ? { name: m.clientName, version: m.clientVersion } : null,
    },
    embeddingStatus: m.embeddingStatus,
    embeddingModel: m.embeddingModel,
    createdAt: new Date(m.createdAt).toISOString(),
    updatedAt: new Date(m.updatedAt).toISOString(),
  };
}

/** `POST .../memories/:memoryId/supersede` body: the already-saved successor. Strict: nothing else is accepted. */
export const supersedeMemorySchema = z.strictObject({ successorId: uuid });
export type SupersedeMemoryInput = z.infer<typeof supersedeMemorySchema>;

export type { MemoryHint };

/**
 * Create response: the Memory, whether an existing active duplicate was reused instead of inserting, and up to three
 * similar active Memories of the same scope (id, type, short preview). `hints` is empty when no new vector is available
 * (a deduplicated create, or an embedding that is still pending). Nothing is ever merged or changed automatically.
 */
export type CreateMemoryResult = MemoryDto & { deduplicated: boolean; hints: MemoryHint[] };
