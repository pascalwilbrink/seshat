import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Creates `workspaces`. Global is a scope, never a row: the slug `global` is refused by a check. */
export class CreateWorkspaces1762400000000 implements MigrationInterface {
  name = 'CreateWorkspaces1762400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "workspaces" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "name" character varying(100) NOT NULL,
      "slug" character varying(100) NOT NULL,
      "description" text,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_workspaces_id" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_workspaces_slug" UNIQUE ("slug"),
      CONSTRAINT "CK_workspaces_name_length" CHECK (char_length("name") BETWEEN 1 AND 100),
      CONSTRAINT "CK_workspaces_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND "slug" <> 'global')
    )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Refuses (FK) while scoped tables still reference workspaces.
    await queryRunner.query('DROP TABLE "workspaces"');
  }
}
