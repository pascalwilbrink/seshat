import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Provenance of uploaded Files: who created the file (admin or an API key, with the key's id and name at that time)
 * and, for MCP uploads, the client name and version. A server-written snapshot like the Memory provenance:
 *
 * - all columns are nullable, so files that existed before this migration simply have no provenance;
 * - a CHECK keeps the combination consistent (admin has no key, an API key has id and name, no kind means no key);
 * - `created_by_key_id` has no FK on purpose (the snapshot must survive key deletion);
 * - a trigger rejects any UPDATE that changes a provenance column, so it is immutable in the database too.
 */
export class AddFileProvenance1763200000000 implements MigrationInterface {
  name = 'AddFileProvenance1763200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "files"
      ADD COLUMN "created_by_kind" character varying(16),
      ADD COLUMN "created_by_key_id" uuid,
      ADD COLUMN "created_by_key_name" character varying(100),
      ADD COLUMN "client_name" character varying(200),
      ADD COLUMN "client_version" character varying(100)`);
    await queryRunner.query(`ALTER TABLE "files" ADD CONSTRAINT "CK_files_created_by_kind"
      CHECK ("created_by_kind" IS NULL OR "created_by_kind" IN ('admin', 'api_key'))`);
    await queryRunner.query(`ALTER TABLE "files" ADD CONSTRAINT "CK_files_created_by_consistency" CHECK (
      ("created_by_kind" IS NULL AND "created_by_key_id" IS NULL AND "created_by_key_name" IS NULL AND "client_name" IS NULL AND "client_version" IS NULL)
      OR ("created_by_kind" = 'admin' AND "created_by_key_id" IS NULL AND "created_by_key_name" IS NULL)
      OR ("created_by_kind" = 'api_key' AND "created_by_key_id" IS NOT NULL AND "created_by_key_name" IS NOT NULL))`);
    await queryRunner.query(`CREATE FUNCTION "fn_files_provenance_immutable"() RETURNS trigger AS $$
      BEGIN
        IF NEW."created_by_kind" IS DISTINCT FROM OLD."created_by_kind"
          OR NEW."created_by_key_id" IS DISTINCT FROM OLD."created_by_key_id"
          OR NEW."created_by_key_name" IS DISTINCT FROM OLD."created_by_key_name"
          OR NEW."client_name" IS DISTINCT FROM OLD."client_name"
          OR NEW."client_version" IS DISTINCT FROM OLD."client_version" THEN
          RAISE EXCEPTION 'file provenance is immutable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(
      `CREATE TRIGGER "TR_files_provenance_immutable" BEFORE UPDATE ON "files" FOR EACH ROW EXECUTE FUNCTION "fn_files_provenance_immutable"()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER "TR_files_provenance_immutable" ON "files"`);
    await queryRunner.query(`DROP FUNCTION "fn_files_provenance_immutable"()`);
    await queryRunner.query(`ALTER TABLE "files" DROP CONSTRAINT "CK_files_created_by_consistency"`);
    await queryRunner.query(`ALTER TABLE "files" DROP CONSTRAINT "CK_files_created_by_kind"`);
    await queryRunner.query(`ALTER TABLE "files"
      DROP COLUMN "client_version", DROP COLUMN "client_name", DROP COLUMN "created_by_key_name",
      DROP COLUMN "created_by_key_id", DROP COLUMN "created_by_kind"`);
  }
}
