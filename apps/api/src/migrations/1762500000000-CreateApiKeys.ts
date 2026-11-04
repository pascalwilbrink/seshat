import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Creates `api_keys`: prefix + HMAC only, owned by one Workspace and deleted with it (ON DELETE CASCADE). */
export class CreateApiKeys1762500000000 implements MigrationInterface {
  name = 'CreateApiKeys1762500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "api_keys" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "workspace_id" uuid NOT NULL,
      "name" character varying(100) NOT NULL,
      "prefix" character varying(8) NOT NULL,
      "key_hmac" bytea NOT NULL,
      "permissions" text array NOT NULL,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "expires_at" TIMESTAMP WITH TIME ZONE,
      "last_used_at" TIMESTAMP WITH TIME ZONE,
      "revoked_at" TIMESTAMP WITH TIME ZONE,
      CONSTRAINT "PK_api_keys_id" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_api_keys_prefix" UNIQUE ("prefix"),
      CONSTRAINT "CK_api_keys_name_length" CHECK (char_length("name") BETWEEN 1 AND 100),
      CONSTRAINT "CK_api_keys_permissions_not_empty" CHECK (cardinality("permissions") >= 1),
      CONSTRAINT "CK_api_keys_prefix_format" CHECK ("prefix" ~ '^[0-9A-Za-z]{8}$'),
      CONSTRAINT "CK_api_keys_key_hmac_length" CHECK (octet_length("key_hmac") = 32),
      CONSTRAINT "FK_api_keys_workspace_id" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE RESTRICT
    )`);
    await queryRunner.query('CREATE INDEX "IDX_api_keys_workspace_id" ON "api_keys" ("workspace_id")');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "api_keys"');
  }
}
