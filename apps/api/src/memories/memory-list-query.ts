import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor, type FileCursor } from '../files/file-list-query.js';
import { isValidTagName, normalizeTagName } from '../tags/tag-name.js';
import { MEMORY_TYPES, type MemoryType } from './memory.entity.js';

export const MEMORY_LIST_DEFAULT_LIMIT = 25;
export const MEMORY_LIST_MAX_LIMIT = 100;
export const MEMORY_TEXT_FILTER_MAX_LENGTH = 200;

export const MEMORY_LIST_STATUSES = ['active', 'superseded', 'all'] as const;
export type MemoryListStatus = (typeof MEMORY_LIST_STATUSES)[number];

const invalidQuery = () => new BadRequestException('Invalid query');

/** A validated list request. Timestamps are normalized to ISO text and only ever bound as `timestamptz` parameters. */
export interface MemoryListQuery {
  limit: number;
  cursor: FileCursor | null;
  type: MemoryType | null;
  tag: string | null;
  status: MemoryListStatus;
  createdFrom: string | null;
  createdTo: string | null;
  updatedFrom: string | null;
  updatedTo: string | null;
  text: string | null;
}

const optionalString = z
  .string()
  .max(1024)
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v));

// Unknown fields are rejected; a repeated field arrives as an array and fails the string check.
const rawSchema = z
  .object({
    limit: optionalString,
    cursor: optionalString,
    type: optionalString,
    tag: optionalString,
    status: optionalString,
    createdFrom: optionalString,
    createdTo: optionalString,
    updatedFrom: optionalString,
    updatedTo: optionalString,
    text: optionalString,
  })
  .strict();

const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/;

function parseInstant(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!ISO_RE.test(value)) throw invalidQuery();
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(ms)) throw invalidQuery();
  const year = new Date(ms).getUTCFullYear();
  if (year < 1970 || year > 9999) throw invalidQuery();
  return new Date(ms).toISOString();
}

/** Parses the query string; every failure is one generic 400 that echoes nothing the client sent. */
export function parseMemoryListQuery(raw: unknown): MemoryListQuery {
  const parsed = rawSchema.safeParse(raw ?? {});
  if (!parsed.success) throw invalidQuery();
  const q = parsed.data;

  let limit = MEMORY_LIST_DEFAULT_LIMIT;
  if (q.limit !== undefined) {
    if (!/^\d{1,4}$/.test(q.limit)) throw invalidQuery();
    limit = Number(q.limit);
    if (limit < 1 || limit > MEMORY_LIST_MAX_LIMIT) throw invalidQuery();
  }

  let type: MemoryType | null = null;
  if (q.type !== undefined) {
    if (!(MEMORY_TYPES as readonly string[]).includes(q.type)) throw invalidQuery();
    type = q.type as MemoryType;
  }

  let tag: string | null = null;
  if (q.tag !== undefined) {
    tag = normalizeTagName(q.tag);
    if (!isValidTagName(tag)) throw invalidQuery();
  }

  let status: MemoryListStatus = 'active';
  if (q.status !== undefined) {
    if (!(MEMORY_LIST_STATUSES as readonly string[]).includes(q.status)) throw invalidQuery();
    status = q.status as MemoryListStatus;
  }

  const createdFrom = parseInstant(q.createdFrom);
  const createdTo = parseInstant(q.createdTo);
  const updatedFrom = parseInstant(q.updatedFrom);
  const updatedTo = parseInstant(q.updatedTo);
  if (createdFrom && createdTo && createdFrom > createdTo) throw invalidQuery();
  if (updatedFrom && updatedTo && updatedFrom > updatedTo) throw invalidQuery();

  let text: string | null = null;
  if (q.text !== undefined) {
    if (Array.from(q.text).length > MEMORY_TEXT_FILTER_MAX_LENGTH) throw invalidQuery();
    text = q.text;
  }

  return {
    limit,
    cursor: q.cursor === undefined ? null : decodeCursor(q.cursor),
    type,
    tag,
    status,
    createdFrom,
    createdTo,
    updatedFrom,
    updatedTo,
    text,
  };
}

export interface MemoryListPage<T> {
  items: T[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}
