import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Embedding generation guard and scheduling marker for `memories`.
 *
 * - `embedding_generation` is bumped by every change of the embedding input (content or title) and by an explicit
 *   retry. Embedding writes are conditional on it, so a late or stale result can never restore an old vector.
 * - `embedding_scheduled_at` is the outbox marker: a `pending` record with a null (or long stale) marker has no
 *   queued job and is picked up by the reconciler, so a lost enqueue never leaves a Memory pending forever.
 */
export class AddMemoryEmbeddingGeneration1763000000000 implements MigrationInterface {
  name = 'AddMemoryEmbeddingGeneration1763000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "memories" ADD "embedding_generation" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "memories" ADD "embedding_scheduled_at" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`CREATE INDEX "IDX_memories_embedding_pending" ON "memories" ("updated_at") WHERE "embedding_status" = 'pending'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_memories_embedding_pending"`);
    await queryRunner.query(`ALTER TABLE "memories" DROP COLUMN "embedding_scheduled_at"`);
    await queryRunner.query(`ALTER TABLE "memories" DROP COLUMN "embedding_generation"`);
  }
}
