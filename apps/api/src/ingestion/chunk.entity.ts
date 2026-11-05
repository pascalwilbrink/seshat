import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, Unique } from 'typeorm';
import { vectorColumn } from '../database/vector-column.js';
import { FileRecord } from '../files/file.entity.js';
import { ScopedEntity } from '../scopes/scoped.entity.js';

/**
 * Physical dimension of `chunks.embedding`. Fixed by the migration; EMBEDDING_DIMENSION must equal it and the API
 * checks the real column at startup (database/embedding-dimension-guard.ts). Changing it needs a new migration and a
 * re-index of every file.
 */
export const CHUNK_VECTOR_DIMENSION = 1536;

/** Where a chunk sits in the original text (see `Document`): offsets are half-open UTF-16 ranges, lines are 1-based. */
export interface ChunkLocation {
  /** Nearest heading text, when the format has headings. */
  section?: string;
  /** Heading path from the top level down to the section. */
  headingPath?: string[];
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  page?: number;
}

/**
 * One embedded piece of a file. `scope` and `workspace_id` are copied from the file and the composite FK
 * `(file_id, scope_key) -> files(id, scope_key)` makes the database reject a chunk whose scope differs from its file's.
 * Deleting the file (or a Workspace through its files) deletes its chunks and vectors.
 */
@Entity({ name: 'chunks' })
@Check('CK_chunks_ordinal', '"ordinal" >= 0')
@Check('CK_chunks_char_count', '"char_count" = char_length("content")')
@Check('CK_chunks_content_hash_format', `"content_hash" ~ '^[0-9a-f]{64}$'`)
@Check('CK_chunks_embedding_model_length', 'char_length("embedding_model") BETWEEN 1 AND 255')
@Unique('UQ_chunks_file_id_ordinal', ['fileId', 'ordinal'])
@Index('IDX_chunks_file_id', ['fileId'])
// The HNSW cosine index on "embedding" is owned by the migration.
export class Chunk extends ScopedEntity {
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

  @Column({ name: 'file_id', type: 'uuid' })
  fileId!: string;

  @ManyToOne(() => FileRecord, { onDelete: 'CASCADE', onUpdate: 'RESTRICT' })
  @JoinColumn({ name: 'file_id' })
  file?: FileRecord;

  @Column({ name: 'ordinal', type: 'integer' })
  ordinal!: number;

  @Column({ name: 'content', type: 'text' })
  content!: string;

  /** Generated `to_tsvector('simple', content)` (owned by the migration, GIN-indexed); never written or loaded by the app. */
  @Column({
    name: 'content_tsv',
    type: 'tsvector',
    generatedType: 'STORED',
    asExpression: `to_tsvector('simple'::regconfig, "content")`,
    insert: false,
    update: false,
    select: false,
  })
  contentTsv?: string;

  @Column({ name: 'location', type: 'jsonb' })
  location!: ChunkLocation;

  @Column({ name: 'char_count', type: 'integer' })
  charCount!: number;

  /** Lowercase hex SHA-256 of `content`. */
  @Column({ name: 'content_hash', type: 'char', length: 64 })
  contentHash!: string;

  @Column({ name: 'embedding', ...vectorColumn(CHUNK_VECTOR_DIMENSION) })
  embedding!: number[];

  @Column({ name: 'embedding_model', type: 'varchar', length: 255 })
  embeddingModel!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt!: Date;
}
