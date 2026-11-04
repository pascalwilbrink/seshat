import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Enables pgvector. Needs a role allowed to CREATE EXTENSION (superuser, or a trusted-extension grant). */
export class EnableVectorExtension1762300000000 implements MigrationInterface {
  name = 'EnableVectorExtension1762300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS vector');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No CASCADE: refuses to drop while any column still uses the vector type.
    await queryRunner.query('DROP EXTENSION IF EXISTS vector');
  }
}
