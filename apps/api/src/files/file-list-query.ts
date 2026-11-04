import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { isUuid } from '../scopes/scope-ref.js';
import { normalizeTagName, isValidTagName } from '../tags/tag-name.js';
import { INGESTION_STATUSES, type IngestionStatus } from './file.entity.js';

export const FILE_LIST_DEFAULT_LIMIT = 25;
export const FILE_LIST_MAX_LIMIT = 100;
export const FILE_NAME_FILTER_MAX_LENGTH = 255;
const CURSOR_MAX_LENGTH = 256;

const invalidCursor = () => new BadRequestException('Invalid cursor');
const invalidQuery = () => new BadRequestException('Invalid query');

/** A validated, normalized list request. Every field is optional; ids and names are only ever used as scoped filters. */
export interface FileListQuery {
  limit: number;
  cursor: FileCursor | null;
  collectionId: string | null;
  tag: string | null;
  status: IngestionStatus | null;
  name: string | null;
}

/** Position of the last returned row: `createdAt` is Postgres' microsecond timestamp text, `id` the tie-breaker. */
export interface FileCursor {
  createdAt: string;
  id: string;
}

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeCursor(cursor: FileCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), 'utf8').toString('base64url');
}

/** Opaque to clients; strictly validated here so it can only ever be bound as a typed timestamp and uuid. */
export function decodeCursor(raw: string): FileCursor {
  if (raw.length === 0 || raw.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw invalidCursor();
  const [createdAt, id] = parsed as unknown[];
  if (typeof createdAt !== 'string' || !TIMESTAMP_RE.test(createdAt) || Number.isNaN(Date.parse(createdAt))) throw invalidCursor();
  if (!isUuid(id)) throw invalidCursor();
  return { createdAt, id: id.toLowerCase() };
}

// Query values are strings (or arrays when repeated, which is rejected). Empty means "not filtered".
const optionalString = z
  .string()
  .max(1024)
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v));

const rawSchema = z
  .object({
    limit: optionalString,
    cursor: optionalString,
    collectionId: optionalString,
    tag: optionalString,
    status: optionalString,
    name: optionalString,
  })
  .strict();

/** Parses the query string; every failure is one generic 400 that echoes nothing the client sent. */
export function parseFileListQuery(raw: unknown): FileListQuery {
  const parsed = rawSchema.safeParse(raw ?? {});
  if (!parsed.success) throw invalidQuery();
  const q = parsed.data;

  let limit = FILE_LIST_DEFAULT_LIMIT;
  if (q.limit !== undefined) {
    if (!/^\d{1,4}$/.test(q.limit)) throw invalidQuery();
    limit = Number(q.limit);
    if (limit < 1 || limit > FILE_LIST_MAX_LIMIT) throw invalidQuery();
  }

  let collectionId: string | null = null;
  if (q.collectionId !== undefined) {
    if (!isUuid(q.collectionId)) throw invalidQuery();
    collectionId = q.collectionId.toLowerCase();
  }

  let tag: string | null = null;
  if (q.tag !== undefined) {
    tag = normalizeTagName(q.tag);
    if (!isValidTagName(tag)) throw invalidQuery();
  }

  let status: IngestionStatus | null = null;
  if (q.status !== undefined) {
    if (!(INGESTION_STATUSES as readonly string[]).includes(q.status)) throw invalidQuery();
    status = q.status as IngestionStatus;
  }

  let name: string | null = null;
  if (q.name !== undefined) {
    if (Array.from(q.name).length > FILE_NAME_FILTER_MAX_LENGTH) throw invalidQuery();
    name = q.name;
  }

  return { limit, cursor: q.cursor === undefined ? null : decodeCursor(q.cursor), collectionId, tag, status, name };
}

export interface FileListPage<T> {
  items: T[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}
