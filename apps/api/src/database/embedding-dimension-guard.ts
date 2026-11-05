import type { DataSource } from 'typeorm';

/** Thrown when the physical `chunks.embedding` column cannot hold vectors of the configured dimension. */
export class EmbeddingDimensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingDimensionError';
  }
}

/**
 * Inspects the actual `chunks.embedding` column in the connected database (not entity metadata) and refuses a missing
 * table, a column that is not `vector(n)`, or `n` differing from `expected`. Messages contain only numbers and fixed
 * text: no connection details, no values. API-only: migration commands never call it.
 */
export async function assertEmbeddingDimension(ds: DataSource, expected: number): Promise<void> {
  const rows = (await ds.query(
    `SELECT t.typname AS type, a.atttypmod AS dimension
       FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = to_regclass('chunks') AND a.attname = 'embedding' AND NOT a.attisdropped`,
  )) as { type: string; dimension: number }[];
  const column = rows[0];
  if (!column) {
    throw new EmbeddingDimensionError(
      'The chunks.embedding column does not exist; run the database migrations (pnpm --filter @seshat/api migration:run) before starting the API',
    );
  }
  if (column.type !== 'vector' || column.dimension < 1) {
    throw new EmbeddingDimensionError(
      'The chunks.embedding column is not a vector(n) column; the database schema is incompatible with this version',
    );
  }
  if (column.dimension !== expected) {
    throw new EmbeddingDimensionError(
      `EMBEDDING_DIMENSION is ${expected} but the chunks.embedding column is vector(${column.dimension}); ` +
        'set EMBEDDING_DIMENSION to the column dimension, or change the column with a migration and re-index all files',
    );
  }
}
