import { afterAll, beforeAll, expect, it } from 'vitest';
import { Column, Entity, PrimaryColumn, type DataSource } from 'typeorm';
import { vectorColumn } from '../src/database/vector-column.js';
import {
  TEST_DATABASE_URL,
  assertDisposableDatabase,
  createIsolatedSchema,
  describeIntegration,
  type IsolatedSchema,
} from './helpers/integration.js';

/** Test-only entities (not under src/, so the app never discovers them). */
@Entity({ name: 'vector_test_small' })
class VectorSmall {
  @PrimaryColumn({ name: 'id', type: 'int' })
  id!: number;

  @Column({ name: 'embedding', ...vectorColumn(3) })
  embedding!: number[];

  @Column({ name: 'optional', nullable: true, ...vectorColumn(3) })
  optional!: number[] | null;
}

@Entity({ name: 'vector_test_large' })
class VectorLarge {
  @PrimaryColumn({ name: 'id', type: 'int' })
  id!: number;

  @Column({ name: 'embedding', ...vectorColumn(8) })
  embedding!: number[];
}

describeIntegration('vectorColumn (real PostgreSQL)', () => {
  let iso: IsolatedSchema | undefined;
  let ds: DataSource;

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    ds = iso.createDataSource([VectorSmall, VectorLarge]);
    await ds.initialize();
    // Explicit test-only DDL; the application never synchronizes. The extension is put in the isolated schema.
    await ds.query('CREATE EXTENSION IF NOT EXISTS vector');
    await ds.query('CREATE TABLE vector_test_small (id int PRIMARY KEY, embedding vector(3) NOT NULL, optional vector(3))');
    await ds.query('CREATE TABLE vector_test_large (id int PRIMARY KEY, embedding vector(8) NOT NULL)');
  });

  afterAll(async () => {
    await iso?.dispose();
  });

  it('creates columns with the declared dimensions', async () => {
    const rows = (await iso!.query(
      `SELECT c.relname AS t, a.attname AS c, a.atttypmod AS dim FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = '${iso!.schema}' AND c.relname LIKE 'vector_test_%' AND a.attname IN ('embedding','optional')`,
    )) as { t: string; c: string; dim: number }[];
    const dim = (t: string, c: string) => rows.find((r) => r.t === t && r.c === c)?.dim;
    expect(dim('vector_test_small', 'embedding')).toBe(3);
    expect(dim('vector_test_small', 'optional')).toBe(3);
    expect(dim('vector_test_large', 'embedding')).toBe(8);
  });

  it('round-trips number[] at several dimensions, including null', async () => {
    const small = ds.getRepository(VectorSmall);
    await small.save({ id: 1, embedding: [0.5, -1, 2.25], optional: null });
    await small.save({ id: 2, embedding: [1, 2, 3], optional: [4, 5, 6] });
    const a = await small.findOneByOrFail({ id: 1 });
    expect(a.embedding).toEqual([0.5, -1, 2.25]);
    expect(a.optional).toBeNull();
    expect((await small.findOneByOrFail({ id: 2 })).optional).toEqual([4, 5, 6]);

    const large = ds.getRepository(VectorLarge);
    const v = [0.125, -0.25, 3, 4, 5, 6, 7, -8];
    await large.save({ id: 1, embedding: v });
    const got = (await large.findOneByOrFail({ id: 1 })).embedding;
    expect(Array.isArray(got)).toBe(true);
    expect(got).toEqual(v);
  });

  it('rejects mismatched lengths and non-finite values before and at the database', async () => {
    await expect(ds.getRepository(VectorSmall).save({ id: 9, embedding: [1, 2], optional: null })).rejects.toThrow(/3 dimensions/);
    await expect(ds.getRepository(VectorLarge).save({ id: 9, embedding: [1, 2, 3] })).rejects.toThrow(/8 dimensions/);
    await expect(ds.getRepository(VectorSmall).save({ id: 9, embedding: [1, NaN, 3], optional: null })).rejects.toThrow(/finite/);
    // The column itself also enforces its dimension, bypassing the transformer.
    await expect(ds.query(`INSERT INTO vector_test_small (id, embedding) VALUES (10, '[1,2]')`)).rejects.toThrow(/expected 3 dimensions/);
    expect(await ds.query('SELECT 1 FROM vector_test_small WHERE id IN (9, 10)')).toHaveLength(0);
  });
});
