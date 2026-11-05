import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

export const CHUNK_LIST_DEFAULT_LIMIT = 20;
export const CHUNK_LIST_MAX_LIMIT = 100;
/** Ordinals are a Postgres `integer`. */
const MAX_ORDINAL = 2_147_483_647;

/** A validated chunk page request: `afterOrdinal` is the last ordinal already seen (null for the first page). */
export interface ChunkListQuery {
  limit: number;
  afterOrdinal: number | null;
}

const optionalString = z
  .string()
  .max(32)
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v));

const rawSchema = z.object({ limit: optionalString, cursor: optionalString }).strict();

const invalid = () => new BadRequestException('Invalid query');

/** Every failure is one generic 400 that echoes nothing the client sent. */
export function parseChunkListQuery(raw: unknown): ChunkListQuery {
  const parsed = rawSchema.safeParse(raw ?? {});
  if (!parsed.success) throw invalid();
  const { limit: rawLimit, cursor } = parsed.data;

  let limit = CHUNK_LIST_DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    if (!/^\d{1,4}$/.test(rawLimit)) throw invalid();
    limit = Number(rawLimit);
    if (limit < 1 || limit > CHUNK_LIST_MAX_LIMIT) throw invalid();
  }

  let afterOrdinal: number | null = null;
  if (cursor !== undefined) {
    if (!/^\d{1,10}$/.test(cursor)) throw invalid();
    afterOrdinal = Number(cursor);
    if (afterOrdinal > MAX_ORDINAL) throw invalid();
  }
  return { limit, afterOrdinal };
}
