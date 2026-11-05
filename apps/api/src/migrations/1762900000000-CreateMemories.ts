import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `memories` and `memory_tags`.
 *
 * - Scope columns, the null-iff-global check and the generated `scope_key` follow every other scoped table.
 * - `memories.embedding` is a nullable `vector(1536)`; `embedding_status = 'ready'` holds exactly when a vector is present.
 * - Provenance columns are a server-written snapshot. `created_by_key_id` has no FK on purpose (a snapshot must
 *   survive key deletion).
 * - `superseded_by` references `(id, scope_key)` of the same table (successor in the same scope, no self-link).
 *   PostgreSQL refuses `ON DELETE SET NULL` on a composite key containing a generated column, so the FK is NO ACTION
 *   and a BEFORE DELETE trigger clears incoming links first. Predecessors stay `superseded` (the status check allows a
 *   superseded Memory without a link, never an active one with a link).
 * - Partial unique index `(scope_key, type, content_hash) WHERE status = 'active'` makes exact-duplicate detection
 *   race-safe.
 * - `memory_tags` references `(memory_id, scope_key)` and `(tag_id, scope_key)`, so a join across scopes is impossible;
 *   deleting a Memory or a Tag cascades to the join rows only. The shared `tags` table is reused unchanged.
 */
export class CreateMemories1762900000000 implements MigrationInterface {
  name = 'CreateMemories1762900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "memories" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "scope" character varying(16) NOT NULL,
      "workspace_id" uuid,
      "scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'global' ELSE "workspace_id"::text END) STORED NOT NULL,
      "type" character varying(16) NOT NULL,
      "content" text NOT NULL,
      "title" character varying(200),
      "metadata" jsonb,
      "confidence" double precision,
      "source" character varying(500),
      "status" character varying(16) NOT NULL DEFAULT 'active',
      "superseded_by" uuid,
      "created_by_kind" character varying(16) NOT NULL,
      "created_by_key_id" uuid,
      "created_by_key_name" character varying(100),
      "client_name" character varying(200),
      "client_version" character varying(100),
      "content_hash" character(64) NOT NULL,
      "embedding" vector(1536),
      "embedding_model" character varying(255),
      "embedding_status" character varying(16) NOT NULL DEFAULT 'pending',
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_memories_id" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_memories_id_scope_key" UNIQUE ("id", "scope_key"),
      CONSTRAINT "CK_scope_workspace_consistency" CHECK (("scope" = 'global' AND "workspace_id" IS NULL) OR ("scope" = 'workspace' AND "workspace_id" IS NOT NULL)),
      CONSTRAINT "FK_memories_workspace_id" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT "CK_memories_type" CHECK ("type" IN ('fact', 'decision', 'preference', 'experience', 'procedure', 'context')),
      CONSTRAINT "CK_memories_content_length" CHECK (char_length("content") BETWEEN 1 AND 10000),
      CONSTRAINT "CK_memories_title_length" CHECK ("title" IS NULL OR char_length("title") BETWEEN 1 AND 200),
      CONSTRAINT "CK_memories_metadata_object" CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object'),
      CONSTRAINT "CK_memories_metadata_size" CHECK ("metadata" IS NULL OR octet_length("metadata"::text) <= 8192),
      CONSTRAINT "CK_memories_confidence_range" CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
      CONSTRAINT "CK_memories_source_length" CHECK ("source" IS NULL OR char_length("source") BETWEEN 1 AND 500),
      CONSTRAINT "CK_memories_status" CHECK ("status" IN ('active', 'superseded')),
      CONSTRAINT "CK_memories_no_self_supersession" CHECK ("superseded_by" IS NULL OR "superseded_by" <> "id"),
      CONSTRAINT "CK_memories_link_requires_superseded" CHECK ("superseded_by" IS NULL OR "status" = 'superseded'),
      CONSTRAINT "CK_memories_created_by_kind" CHECK ("created_by_kind" IN ('admin', 'api_key')),
      CONSTRAINT "CK_memories_created_by_consistency" CHECK (
        ("created_by_kind" = 'admin' AND "created_by_key_id" IS NULL AND "created_by_key_name" IS NULL)
        OR ("created_by_kind" = 'api_key' AND "created_by_key_id" IS NOT NULL AND "created_by_key_name" IS NOT NULL)),
      CONSTRAINT "CK_memories_client_name_length" CHECK ("client_name" IS NULL OR char_length("client_name") BETWEEN 1 AND 200),
      CONSTRAINT "CK_memories_client_version_length" CHECK ("client_version" IS NULL OR (char_length("client_version") BETWEEN 1 AND 100 AND "client_name" IS NOT NULL)),
      CONSTRAINT "CK_memories_content_hash_format" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
      CONSTRAINT "CK_memories_embedding_status" CHECK ("embedding_status" IN ('pending', 'ready', 'failed')),
      CONSTRAINT "CK_memories_embedding_ready_consistency" CHECK (("embedding_status" = 'ready') = ("embedding" IS NOT NULL AND "embedding_model" IS NOT NULL)),
      CONSTRAINT "FK_memories_superseded_by_scope" FOREIGN KEY ("superseded_by", "scope_key") REFERENCES "memories"("id", "scope_key") ON DELETE NO ACTION ON UPDATE RESTRICT
    )`);
    await queryRunner.query(`CREATE FUNCTION "fn_memories_clear_incoming_links"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE "memories" SET "superseded_by" = NULL WHERE "superseded_by" = OLD."id";
        RETURN OLD;
      END $$`);
    await queryRunner.query(
      'CREATE TRIGGER "TR_memories_clear_incoming_links" BEFORE DELETE ON "memories" FOR EACH ROW EXECUTE FUNCTION "fn_memories_clear_incoming_links"()',
    );
    await queryRunner.query('CREATE INDEX "IDX_memories_scope_workspace_id" ON "memories" ("scope", "workspace_id")');
    await queryRunner.query(
      'CREATE UNIQUE INDEX "UQ_memories_active_scope_key_type_content_hash" ON "memories" ("scope_key", "type", "content_hash") WHERE "status" = \'active\'',
    );
    await queryRunner.query('CREATE INDEX "IDX_memories_scope_key_created_at_id" ON "memories" ("scope_key", "created_at" DESC, "id" DESC)');
    await queryRunner.query('CREATE INDEX "IDX_memories_scope_key_updated_at_id" ON "memories" ("scope_key", "updated_at" DESC, "id" DESC)');
    await queryRunner.query('CREATE INDEX "IDX_memories_scope_key_status_type" ON "memories" ("scope_key", "status", "type")');
    await queryRunner.query('CREATE INDEX "IDX_memories_superseded_by" ON "memories" ("superseded_by") WHERE "superseded_by" IS NOT NULL');
    await queryRunner.query('CREATE INDEX "IDX_memories_scope_key_embedding_status" ON "memories" ("scope_key", "embedding_status")');
    await queryRunner.query('CREATE INDEX "IDX_memories_embedding_hnsw" ON "memories" USING hnsw ("embedding" vector_cosine_ops)');

    await queryRunner.query(`CREATE TABLE "memory_tags" (
      "memory_id" uuid NOT NULL,
      "tag_id" uuid NOT NULL,
      "scope_key" text NOT NULL,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_memory_tags" PRIMARY KEY ("memory_id", "tag_id"),
      CONSTRAINT "FK_memory_tags_memory_scope" FOREIGN KEY ("memory_id", "scope_key") REFERENCES "memories"("id", "scope_key") ON DELETE CASCADE ON UPDATE RESTRICT,
      CONSTRAINT "FK_memory_tags_tag_scope" FOREIGN KEY ("tag_id", "scope_key") REFERENCES "tags"("id", "scope_key") ON DELETE CASCADE ON UPDATE RESTRICT
    )`);
    await queryRunner.query('CREATE INDEX "IDX_memory_tags_tag_id" ON "memory_tags" ("tag_id")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "memory_tags"');
    await queryRunner.query('DROP TRIGGER "TR_memories_clear_incoming_links" ON "memories"');
    await queryRunner.query('DROP FUNCTION "fn_memories_clear_incoming_links"()');
    await queryRunner.query('DROP TABLE "memories"');
  }
}
