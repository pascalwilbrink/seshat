import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the scoped `collections`, `tags`, `files` and `file_tags` tables.
 *
 * Scope safety lives in the database, not only in DTO validation:
 * - every scoped table has `scope`, `workspace_id` (restricting FK to workspaces), the null-iff-global check and a
 *   (scope, workspace_id) index, exactly like ScopedEntity;
 * - `scope_key` is a generated, never-null scope identity ('global' or the Workspace uuid). Unlike a nullable
 *   `workspace_id`, it works in unique indexes and composite foreign keys, so Global is enforced like a Workspace;
 * - `files.collection_id` and `file_tags` reference `(id, scope_key)`, so a file can only join a Collection or Tag of
 *   its own scope. PostgreSQL refuses `ON DELETE SET NULL` on a key containing a generated column, so a BEFORE DELETE
 *   trigger on `collections` clears `files.collection_id` instead (files are kept, nothing else changes);
 * - `tags` knows nothing about files, so a later `memory_tags` join can reuse it.
 */
export class CreateFilesCollectionsTags1762600000000 implements MigrationInterface {
  name = 'CreateFilesCollectionsTags1762600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const scoped = (table: string) => `
      "scope" character varying(16) NOT NULL,
      "workspace_id" uuid,
      "scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'global' ELSE "workspace_id"::text END) STORED NOT NULL,
      CONSTRAINT "CK_scope_workspace_consistency" CHECK (("scope" = 'global' AND "workspace_id" IS NULL) OR ("scope" = 'workspace' AND "workspace_id" IS NOT NULL)),
      CONSTRAINT "FK_${table}_workspace_id" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT`;

    await queryRunner.query(`CREATE TABLE "collections" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      ${scoped('collections')},
      "name" character varying(100) NOT NULL,
      "description" text,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_collections_id" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_collections_id_scope_key" UNIQUE ("id", "scope_key"),
      CONSTRAINT "CK_collections_name_length" CHECK (char_length("name") BETWEEN 1 AND 100),
      CONSTRAINT "CK_collections_name_not_blank" CHECK (btrim("name") <> '')
    )`);
    await queryRunner.query('CREATE INDEX "IDX_collections_scope_workspace_id" ON "collections" ("scope", "workspace_id")');
    // Case-insensitive uniqueness per scope; scope_key makes Global (NULL workspace_id) unique too.
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_collections_scope_key_lower_name" ON "collections" ("scope_key", lower("name"))');

    await queryRunner.query(`CREATE TABLE "tags" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      ${scoped('tags')},
      "name" character varying(50) NOT NULL,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_tags_id" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_tags_id_scope_key" UNIQUE ("id", "scope_key"),
      CONSTRAINT "UQ_tags_scope_key_name" UNIQUE ("scope_key", "name"),
      CONSTRAINT "CK_tags_name_length" CHECK (char_length("name") BETWEEN 1 AND 50),
      CONSTRAINT "CK_tags_name_format" CHECK ("name" ~ '^[a-z0-9_.:/-]+$')
    )`);
    await queryRunner.query('CREATE INDEX "IDX_tags_scope_workspace_id" ON "tags" ("scope", "workspace_id")');

    await queryRunner.query(`CREATE TABLE "files" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      ${scoped('files')},
      "name" character varying(255) NOT NULL,
      "extension" character varying(32),
      "mime_type" character varying(255) NOT NULL,
      "size_bytes" bigint NOT NULL,
      "sha256" character(64) NOT NULL,
      "storage_key" character varying(512) NOT NULL,
      "collection_id" uuid,
      "ingestion_status" character varying(16) NOT NULL DEFAULT 'pending',
      "ingestion_error" text,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_files_id" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_files_id_scope_key" UNIQUE ("id", "scope_key"),
      CONSTRAINT "UQ_files_storage_key" UNIQUE ("storage_key"),
      CONSTRAINT "CK_files_name_length" CHECK (char_length("name") BETWEEN 1 AND 255),
      CONSTRAINT "CK_files_extension_format" CHECK ("extension" IS NULL OR "extension" ~ '^[a-z0-9]{1,32}$'),
      CONSTRAINT "CK_files_size_bytes" CHECK ("size_bytes" >= 0),
      CONSTRAINT "CK_files_sha256_format" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
      CONSTRAINT "CK_files_ingestion_status" CHECK ("ingestion_status" IN ('pending', 'processing', 'indexed', 'failed')),
      CONSTRAINT "FK_files_collection_scope" FOREIGN KEY ("collection_id", "scope_key") REFERENCES "collections"("id", "scope_key") ON DELETE NO ACTION ON UPDATE RESTRICT
    )`);
    await queryRunner.query(`CREATE FUNCTION "fn_collections_clear_membership"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE "files" SET "collection_id" = NULL WHERE "collection_id" = OLD."id";
        RETURN OLD;
      END $$`);
    await queryRunner.query(
      'CREATE TRIGGER "TR_collections_clear_membership" BEFORE DELETE ON "collections" FOR EACH ROW EXECUTE FUNCTION "fn_collections_clear_membership"()',
    );
    await queryRunner.query('CREATE INDEX "IDX_files_scope_workspace_id" ON "files" ("scope", "workspace_id")');
    await queryRunner.query('CREATE INDEX "IDX_files_scope_key_created_at_id" ON "files" ("scope_key", "created_at" DESC, "id" DESC)');
    await queryRunner.query('CREATE INDEX "IDX_files_collection_id" ON "files" ("collection_id")');
    await queryRunner.query('CREATE INDEX "IDX_files_scope_key_ingestion_status" ON "files" ("scope_key", "ingestion_status")');

    await queryRunner.query(`CREATE TABLE "file_tags" (
      "file_id" uuid NOT NULL,
      "tag_id" uuid NOT NULL,
      "scope_key" text NOT NULL,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_file_tags" PRIMARY KEY ("file_id", "tag_id"),
      CONSTRAINT "FK_file_tags_file_scope" FOREIGN KEY ("file_id", "scope_key") REFERENCES "files"("id", "scope_key") ON DELETE CASCADE ON UPDATE RESTRICT,
      CONSTRAINT "FK_file_tags_tag_scope" FOREIGN KEY ("tag_id", "scope_key") REFERENCES "tags"("id", "scope_key") ON DELETE CASCADE ON UPDATE RESTRICT
    )`);
    await queryRunner.query('CREATE INDEX "IDX_file_tags_tag_id" ON "file_tags" ("tag_id")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "file_tags"');
    await queryRunner.query('DROP TRIGGER "TR_collections_clear_membership" ON "collections"');
    await queryRunner.query('DROP FUNCTION "fn_collections_clear_membership"()');
    await queryRunner.query('DROP TABLE "files"');
    await queryRunner.query('DROP TABLE "tags"');
    await queryRunner.query('DROP TABLE "collections"');
  }
}
