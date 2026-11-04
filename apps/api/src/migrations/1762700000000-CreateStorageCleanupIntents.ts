import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persisted storage-cleanup ledger. No foreign keys: an intent must survive the deletion of the file or Workspace
 * rows it was captured from.
 */
export class CreateStorageCleanupIntents1762700000000 implements MigrationInterface {
  name = 'CreateStorageCleanupIntents1762700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "storage_cleanup_intents" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "storage_key" character varying(512) NOT NULL,
      "resource_type" character varying(32) NOT NULL,
      "resource_id" uuid NOT NULL,
      "scope_key" text NOT NULL,
      "attempts" integer NOT NULL DEFAULT 0,
      "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "last_error" character varying(100),
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_storage_cleanup_intents_id" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_storage_cleanup_intents_storage_key" UNIQUE ("storage_key"),
      CONSTRAINT "CK_storage_cleanup_intents_attempts" CHECK ("attempts" >= 0)
    )`);
    await queryRunner.query('CREATE INDEX "IDX_storage_cleanup_intents_next_attempt_at" ON "storage_cleanup_intents" ("next_attempt_at")');
    await queryRunner.query('CREATE INDEX "IDX_storage_cleanup_intents_resource_id" ON "storage_cleanup_intents" ("resource_id")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "storage_cleanup_intents"');
  }
}
