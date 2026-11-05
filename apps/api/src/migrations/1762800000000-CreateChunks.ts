import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `chunks` (embedded pieces of files) and adds `indexed_at` / `chunk_count` to `files`.
 *
 * - `embedding` is `vector(1536)`; the API refuses to start when EMBEDDING_DIMENSION differs (checked against the real column).
 * - Scope columns are copied from the file, with the same null-iff-global check and a generated `scope_key` as every
 *   scoped table. `FK_chunks_file_scope (file_id, scope_key) -> files(id, scope_key)` ON DELETE CASCADE removes chunks
 *   with their file and makes a chunk/file scope mismatch impossible. Cascading *from the referenced file* is
 *   supported by PostgreSQL; what it refuses for a generated referencing column are SET NULL / SET DEFAULT and ON UPDATE
 *   CASCADE, which are not used (ON UPDATE RESTRICT).
 */
export class CreateChunks1762800000000 implements MigrationInterface {
  name = 'CreateChunks1762800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "files" ADD COLUMN "indexed_at" TIMESTAMP WITH TIME ZONE');
    await queryRunner.query('ALTER TABLE "files" ADD COLUMN "chunk_count" integer NOT NULL DEFAULT 0');
    await queryRunner.query('ALTER TABLE "files" ADD CONSTRAINT "CK_files_chunk_count" CHECK ("chunk_count" >= 0)');

    await queryRunner.query(`CREATE TABLE "chunks" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "scope" character varying(16) NOT NULL,
      "workspace_id" uuid,
      "scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'global' ELSE "workspace_id"::text END) STORED NOT NULL,
      "file_id" uuid NOT NULL,
      "ordinal" integer NOT NULL,
      "content" text NOT NULL,
      "location" jsonb NOT NULL,
      "char_count" integer NOT NULL,
      "content_hash" character(64) NOT NULL,
      "embedding" vector(1536) NOT NULL,
      "embedding_model" character varying(255) NOT NULL,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_chunks_id" PRIMARY KEY ("id"),
      CONSTRAINT "CK_scope_workspace_consistency" CHECK (("scope" = 'global' AND "workspace_id" IS NULL) OR ("scope" = 'workspace' AND "workspace_id" IS NOT NULL)),
      CONSTRAINT "FK_chunks_workspace_id" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT "FK_chunks_file_scope" FOREIGN KEY ("file_id", "scope_key") REFERENCES "files"("id", "scope_key") ON DELETE CASCADE ON UPDATE RESTRICT,
      CONSTRAINT "UQ_chunks_file_id_ordinal" UNIQUE ("file_id", "ordinal"),
      CONSTRAINT "CK_chunks_ordinal" CHECK ("ordinal" >= 0),
      CONSTRAINT "CK_chunks_char_count" CHECK ("char_count" = char_length("content")),
      CONSTRAINT "CK_chunks_content_hash_format" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
      CONSTRAINT "CK_chunks_embedding_model_length" CHECK (char_length("embedding_model") BETWEEN 1 AND 255)
    )`);
    await queryRunner.query('CREATE INDEX "IDX_chunks_scope_workspace_id" ON "chunks" ("scope", "workspace_id")');
    await queryRunner.query('CREATE INDEX "IDX_chunks_file_id" ON "chunks" ("file_id")');
    await queryRunner.query('CREATE INDEX "IDX_chunks_embedding_hnsw" ON "chunks" USING hnsw ("embedding" vector_cosine_ops)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "chunks"');
    await queryRunner.query('ALTER TABLE "files" DROP CONSTRAINT "CK_files_chunk_count"');
    await queryRunner.query('ALTER TABLE "files" DROP COLUMN "chunk_count"');
    await queryRunner.query('ALTER TABLE "files" DROP COLUMN "indexed_at"');
  }
}
