import type { ValueTransformer } from 'typeorm';

/** Column options accepted by TypeORM's `@Column()` for a pgvector column (`vector(n)`). */
export interface VectorColumnOptions {
  type: 'vector';
  length: number;
  transformer: ValueTransformer;
}

/** pgvector supports at most 16000 dimensions for the `vector` type. */
export const MAX_VECTOR_DIMENSION = 16000;

export function assertVectorDimension(dimension: number): void {
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > MAX_VECTOR_DIMENSION) {
    throw new RangeError(`Vector dimension must be an integer between 1 and ${MAX_VECTOR_DIMENSION}`);
  }
}

/**
 * Validates a vector before it is written. `null`/`undefined` pass through (use a nullable column);
 * anything that is not an array of exactly `dimension` finite numbers throws. The message never
 * contains the vector values.
 */
export function assertVector(value: unknown, dimension: number): asserts value is number[] {
  if (!Array.isArray(value)) throw new TypeError('Vector must be an array of numbers');
  if (value.length !== dimension) {
    throw new RangeError(`Vector must have ${dimension} dimensions, got ${value.length}`);
  }
  for (const v of value) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new TypeError('Vector values must be finite numbers');
    }
  }
}

/**
 * Transformer for a `vector(dimension)` column. TypeORM already serializes `number[]` to pgvector's text
 * form and parses it back, so this only validates on write and normalizes on read (`null` stays `null`).
 */
export function vectorTransformer(dimension: number): ValueTransformer {
  assertVectorDimension(dimension);
  return {
    to(value: number[] | null | undefined) {
      if (value === null || value === undefined) return value;
      assertVector(value, dimension);
      return value;
    },
    from(value: number[] | string | null | undefined): number[] | null {
      if (value === null || value === undefined) return null;
      if (Array.isArray(value)) return value;
      // Defensive: pgvector text form "[1,2,3]" if the driver did not parse it.
      return value === '[]' ? [] : value.slice(1, -1).split(',').map(Number);
    },
  };
}

/**
 * Options for `@Column({ ...vectorColumn(dimension) })`. Always spell the property type out; Vitest emits no
 * decorator metadata. The dimension comes from the caller (e.g. typed config), never from a global default.
 * Add `name` and `nullable` on the column as needed.
 */
export function vectorColumn(dimension: number): VectorColumnOptions {
  assertVectorDimension(dimension);
  return { type: 'vector', length: dimension, transformer: vectorTransformer(dimension) };
}
