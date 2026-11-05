import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Keyword search vectors for hybrid retrieval.
 *
 * - `chunks.content_tsv` = to_tsvector('simple', content); `memories.search_tsv` = to_tsvector('simple', title + content)
 *   with a null title treated as empty. The `simple` configuration is spelled out so the result never depends on
 *   `default_text_search_config` and does no language-specific stemming (Dutch and English text, identifiers).
 * - Both are STORED generated columns: existing rows are indexed by the ALTER itself and every later content/title
 *   change recomputes them; the application can never write them.
 * - Each has a GIN index. Existing scope, vector (HNSW) and ownership constraints are untouched.
 */
export class AddKeywordSearchVectors1763100000000 implements MigrationInterface {
  name = 'AddKeywordSearchVectors1763100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chunks" ADD COLUMN "content_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, "content")) STORED`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_chunks_content_tsv_gin" ON "chunks" USING gin ("content_tsv")`);
    await queryRunner.query(
      `ALTER TABLE "memories" ADD COLUMN "search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("title", '') || ' ' || "content")) STORED`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_memories_search_tsv_gin" ON "memories" USING gin ("search_tsv")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_memories_search_tsv_gin"`);
    await queryRunner.query(`ALTER TABLE "memories" DROP COLUMN "search_tsv"`);
    await queryRunner.query(`DROP INDEX "IDX_chunks_content_tsv_gin"`);
    await queryRunner.query(`ALTER TABLE "chunks" DROP COLUMN "content_tsv"`);
  }
}
