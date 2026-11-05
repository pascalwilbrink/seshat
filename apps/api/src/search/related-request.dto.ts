import { z } from 'zod';
import { MEMORY_TYPES } from '../memories/memory.entity.js';
import { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX } from './search-request.dto.js';

export const RELATED_LIMIT_DEFAULT = SEARCH_LIMIT_DEFAULT;
export const RELATED_LIMIT_MAX = SEARCH_LIMIT_MAX;

const limit = z
  .string({ error: 'Limit must be a number' })
  .regex(/^\d{1,3}$/, 'Limit must be an integer')
  .transform(Number)
  .refine((n) => n >= 1, 'Limit must be at least 1')
  .refine((n) => n <= RELATED_LIMIT_MAX, `Limit must be at most ${RELATED_LIMIT_MAX}`);

const memoryType = z.enum(MEMORY_TYPES, { error: 'Type must be fact, decision, preference, experience, procedure or context' });
const type = z
  .union([memoryType, z.array(memoryType).min(1, 'Type must not be empty').max(MEMORY_TYPES.length, 'Too many types')])
  .transform((v) => [...new Set(Array.isArray(v) ? v : [v])]);

const shape = { limit: limit.optional(), type: type.optional() };

/** Query string of `GET /api/global/memories/:id/related`. Strict: `includeGlobal` and anything unknown is a 400. */
export const globalRelatedQuerySchema = z.strictObject(shape);

/** Query string of the Workspace route; `includeGlobal` (`true`|`false`) is off by default. */
export const workspaceRelatedQuerySchema = z.strictObject({
  ...shape,
  includeGlobal: z.enum(['true', 'false'], { error: 'Include Global must be true or false' }).transform((v) => v === 'true').optional(),
});

export type GlobalRelatedQuery = z.infer<typeof globalRelatedQuerySchema>;
export type WorkspaceRelatedQuery = z.infer<typeof workspaceRelatedQuerySchema>;

/** The validated request with defaults applied. */
export interface RelatedRequest {
  limit: number;
  types: readonly (typeof MEMORY_TYPES)[number][] | null;
  includeGlobal: boolean;
}

export function toRelatedRequest(q: GlobalRelatedQuery | WorkspaceRelatedQuery): RelatedRequest {
  return {
    limit: q.limit ?? RELATED_LIMIT_DEFAULT,
    types: q.type ?? null,
    includeGlobal: 'includeGlobal' in q ? (q.includeGlobal ?? false) : false,
  };
}
