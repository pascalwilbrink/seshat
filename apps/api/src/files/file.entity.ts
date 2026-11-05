import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn, Unique, UpdateDateColumn } from 'typeorm';
import { ScopedEntity } from '../scopes/scoped.entity.js';

export const INGESTION_STATUSES = ['pending', 'processing', 'indexed', 'failed'] as const;
export type IngestionStatus = (typeof INGESTION_STATUSES)[number];

/** `bigint` arrives from pg as a string; sizes stay far below 2^53 so a number is exact. */
const bigintAsNumber = { to: (v: number) => v, from: (v: string | number) => Number(v) };

/**
 * An original uploaded file in Global or one Workspace. The stored bytes live behind FileStorage under `storageKey`
 * (internal: never part of a DTO). `collectionId` is optional and must be in the same scope: the composite FK
 * `(collection_id, scope_key)` enforces it in the database.
 */
@Entity({ name: 'files' })
@Check('CK_files_name_length', 'char_length("name") BETWEEN 1 AND 255')
@Check('CK_files_extension_format', `"extension" IS NULL OR "extension" ~ '^[a-z0-9]{1,32}$'`)
@Check('CK_files_size_bytes', '"size_bytes" >= 0')
@Check('CK_files_sha256_format', `"sha256" ~ '^[0-9a-f]{64}$'`)
@Check('CK_files_chunk_count', '"chunk_count" >= 0')
@Check('CK_files_ingestion_status', `"ingestion_status" IN ('pending', 'processing', 'indexed', 'failed')`)
@Unique('UQ_files_id_scope_key', ['id', 'scopeKey'])
@Unique('UQ_files_storage_key', ['storageKey'])
@Index('IDX_files_collection_id', ['collectionId'])
@Index('IDX_files_scope_key_ingestion_status', ['scopeKey', 'ingestionStatus'])
// The newest-first index (scope_key, created_at DESC, id DESC) is owned by the migration.
export class FileRecord extends ScopedEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  /** DB-generated scope identity ('global' or the Workspace uuid); read-only. */
  @Column({
    name: 'scope_key',
    type: 'text',
    generatedType: 'STORED',
    asExpression: `CASE WHEN "workspace_id" IS NULL THEN 'global' ELSE "workspace_id"::text END`,
    insert: false,
    update: false,
  })
  scopeKey!: string;

  /** Sanitized display name (never a path). */
  @Column({ name: 'name', type: 'varchar', length: 255 })
  name!: string;

  @Column({ name: 'extension', type: 'varchar', length: 32, nullable: true })
  extension!: string | null;

  @Column({ name: 'mime_type', type: 'varchar', length: 255 })
  mimeType!: string;

  @Column({ name: 'size_bytes', type: 'bigint', transformer: bigintAsNumber })
  sizeBytes!: number;

  @Column({ name: 'sha256', type: 'char', length: 64 })
  sha256!: string;

  /** Internal FileStorage key; excluded from every DTO. */
  @Column({ name: 'storage_key', type: 'varchar', length: 512 })
  storageKey!: string;

  @Column({ name: 'collection_id', type: 'uuid', nullable: true })
  collectionId!: string | null;

  @Column({ name: 'ingestion_status', type: 'varchar', length: 16, default: 'pending' })
  ingestionStatus!: IngestionStatus;

  @Column({ name: 'ingestion_error', type: 'text', nullable: true })
  ingestionError!: string | null;

  /** When the file last reached `indexed`; null until then. */
  @Column({ name: 'indexed_at', type: 'timestamp with time zone', nullable: true })
  indexedAt!: Date | null;

  /** Number of chunks currently stored for this file. */
  @Column({ name: 'chunk_count', type: 'integer', default: 0 })
  chunkCount!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updatedAt!: Date;
}
