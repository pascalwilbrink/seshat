import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn, Unique, UpdateDateColumn } from 'typeorm';
import { vectorColumn } from '../database/vector-column.js';
import { ScopedEntity } from '../scopes/scoped.entity.js';

export const MEMORY_TYPES = ['fact', 'decision', 'preference', 'experience', 'procedure', 'context'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export const MEMORY_STATUSES = ['active', 'superseded'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export const MEMORY_EMBEDDING_STATUSES = ['pending', 'ready', 'failed'] as const;
export type MemoryEmbeddingStatus = (typeof MEMORY_EMBEDDING_STATUSES)[number];
export const MEMORY_CREATED_BY_KINDS = ['admin', 'api_key'] as const;
export type MemoryCreatedByKind = (typeof MEMORY_CREATED_BY_KINDS)[number];

export const MEMORY_CONTENT_MAX = 10000;
export const MEMORY_TITLE_MAX = 200;
export const MEMORY_SOURCE_MAX = 500;
/** Maximum size of the metadata JSON text in bytes (UTF-8). */
export const MEMORY_METADATA_MAX_BYTES = 8192;
/** Physical dimension of `memories.embedding`; same as chunks, fixed by the migration. */
export const MEMORY_VECTOR_DIMENSION = 1536;

/**
 * A persistent knowledge record in Global or one Workspace. Not a document: it never belongs to a Collection.
 * Provenance (`createdBy*`, `client*`) is a snapshot written by the server once and never updated; `createdByKeyId`
 * deliberately has no FK so it survives key deletion. `contentHash` is the hash of the normalized content
 * (see memory-content.ts). `supersededBy` points to the successor in the same scope (composite FK with `scope_key`);
 * deleting the successor clears the link through a trigger and keeps the `superseded` status.
 * Constraints, the partial unique index (active scope/type/hash), indexes and the HNSW index are owned by the migration.
 */
@Entity({ name: 'memories' })
@Check('CK_memories_type', `"type" IN ('fact', 'decision', 'preference', 'experience', 'procedure', 'context')`)
@Check('CK_memories_content_length', 'char_length("content") BETWEEN 1 AND 10000')
@Check('CK_memories_status', `"status" IN ('active', 'superseded')`)
@Unique('UQ_memories_id_scope_key', ['id', 'scopeKey'])
export class Memory extends ScopedEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({
    name: 'scope_key',
    type: 'text',
    generatedType: 'STORED',
    asExpression: `CASE WHEN "workspace_id" IS NULL THEN 'global' ELSE "workspace_id"::text END`,
    insert: false,
    update: false,
  })
  scopeKey!: string;

  @Column({ name: 'type', type: 'varchar', length: 16 })
  type!: MemoryType;

  @Column({ name: 'content', type: 'text' })
  content!: string;

  @Column({ name: 'title', type: 'varchar', length: MEMORY_TITLE_MAX, nullable: true })
  title!: string | null;

  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ name: 'confidence', type: 'double precision', nullable: true })
  confidence!: number | null;

  @Column({ name: 'source', type: 'varchar', length: MEMORY_SOURCE_MAX, nullable: true })
  source!: string | null;

  @Column({ name: 'status', type: 'varchar', length: 16, default: 'active' })
  status!: MemoryStatus;

  @Column({ name: 'superseded_by', type: 'uuid', nullable: true })
  supersededBy!: string | null;

  @Column({ name: 'created_by_kind', type: 'varchar', length: 16 })
  createdByKind!: MemoryCreatedByKind;

  @Column({ name: 'created_by_key_id', type: 'uuid', nullable: true })
  createdByKeyId!: string | null;

  @Column({ name: 'created_by_key_name', type: 'varchar', length: 100, nullable: true })
  createdByKeyName!: string | null;

  @Column({ name: 'client_name', type: 'varchar', length: 200, nullable: true })
  clientName!: string | null;

  @Column({ name: 'client_version', type: 'varchar', length: 100, nullable: true })
  clientVersion!: string | null;

  @Index('IDX_memories_scope_key_type_content_hash')
  @Column({ name: 'content_hash', type: 'char', length: 64 })
  contentHash!: string;

  @Column({ name: 'embedding', ...vectorColumn(MEMORY_VECTOR_DIMENSION), nullable: true })
  embedding!: number[] | null;

  @Column({ name: 'embedding_model', type: 'varchar', length: 255, nullable: true })
  embeddingModel!: string | null;

  @Column({ name: 'embedding_status', type: 'varchar', length: 16, default: 'pending' })
  embeddingStatus!: MemoryEmbeddingStatus;

  /** Bumped whenever the embedding input (content or title) changes or a retry is requested; guards every embedding write. */
  @Column({ name: 'embedding_generation', type: 'int', default: 0 })
  embeddingGeneration!: number;

  /** Set when a job for the current generation was queued; null means the pending record still needs scheduling (outbox). */
  @Column({ name: 'embedding_scheduled_at', type: 'timestamp with time zone', nullable: true })
  embeddingScheduledAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updatedAt!: Date;
}
