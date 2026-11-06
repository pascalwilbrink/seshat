import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor, encodeCursor, type FileCursor } from '../files/file-list-query.js';
import type { AccessKind, McpOutcome, UsageChannel, UsageResourceKind } from './usage.constants.js';

/**
 * Admin usage analytics: request validation and response shapes. Responses are minimal projections: ids, scope,
 * memory type, counts and times. They never carry names, titles, content, metadata, tags, queries or summaries.
 */
export const USAGE_WINDOW_DAYS = [7, 30, 90] as const;
export type UsageWindowDays = (typeof USAGE_WINDOW_DAYS)[number];
export const USAGE_DEFAULT_DAYS: UsageWindowDays = 30;
export const USAGE_TOP_DEFAULT_LIMIT = 10;
export const USAGE_TOP_MAX_LIMIT = 100;
export const USAGE_UNUSED_DEFAULT_LIMIT = 25;
export const USAGE_UNUSED_MAX_LIMIT = 100;

const invalidQuery = () => new BadRequestException('Invalid query');

const str = z.string().max(1024).optional().transform((v) => (v === undefined || v === '' ? undefined : v));

function parseDays(raw: string | undefined): UsageWindowDays {
  if (raw === undefined) return USAGE_DEFAULT_DAYS;
  const n = Number(raw);
  if (!/^\d{1,3}$/.test(raw) || !(USAGE_WINDOW_DAYS as readonly number[]).includes(n)) throw invalidQuery();
  return n as UsageWindowDays;
}

function parseLimit(raw: string | undefined, def: number, max: number): number {
  if (raw === undefined) return def;
  if (!/^\d{1,4}$/.test(raw)) throw invalidQuery();
  const n = Number(raw);
  if (n < 1 || n > max) throw invalidQuery();
  return n;
}

function parseResource(raw: string | undefined): UsageResourceKind {
  if (raw === 'file' || raw === 'memory') return raw;
  throw invalidQuery();
}

function safe<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw invalidQuery();
  return parsed.data;
}

/** `?days=` of the per-resource usage routes. Every failure is one generic 400 that echoes nothing. */
export function parseResourceUsageQuery(raw: unknown): { days: UsageWindowDays } {
  const q = safe(z.object({ days: str }).strict(), raw);
  return { days: parseDays(q.days) };
}

export function parseTopQuery(raw: unknown): { resource: UsageResourceKind; days: UsageWindowDays; limit: number } {
  const q = safe(z.object({ resource: str, days: str, limit: str }).strict(), raw);
  return { resource: parseResource(q.resource), days: parseDays(q.days), limit: parseLimit(q.limit, USAGE_TOP_DEFAULT_LIMIT, USAGE_TOP_MAX_LIMIT) };
}

export function parseUnusedQuery(raw: unknown): { resource: UsageResourceKind; days: UsageWindowDays; limit: number; cursor: FileCursor | null } {
  const q = safe(z.object({ resource: str, days: str, limit: str, cursor: str }).strict(), raw);
  return {
    resource: parseResource(q.resource),
    days: parseDays(q.days),
    limit: parseLimit(q.limit, USAGE_UNUSED_DEFAULT_LIMIT, USAGE_UNUSED_MAX_LIMIT),
    cursor: q.cursor ? decodeCursor(q.cursor) : null,
  };
}

/** `?days=` of the overview routes. Same generic 400 as the other usage routes. */
export function parseOverviewQuery(raw: unknown): { days: UsageWindowDays } {
  return parseResourceUsageQuery(raw);
}

export const USAGE_OVERVIEW_TOP_LIMIT = 10;

export { encodeCursor as encodeUsageCursor };

export interface UsageWindowDto {
  days: UsageWindowDays;
  /** First and last UTC day of the window, inclusive (the last one is today, UTC). */
  from: string;
  to: string;
}

export interface UsageDailyPointDto {
  day: string;
  total: number;
  byChannel: Record<UsageChannel, number>;
  byKind: Record<AccessKind, number>;
}

export interface ResourceUsageDto {
  resource: UsageResourceKind;
  id: string;
  scope: 'global' | 'workspace';
  workspaceId: string | null;
  window: UsageWindowDto;
  /** Lifetime numbers survive the pruning of daily rows. */
  lifetime: { total: number; byChannel: Record<UsageChannel, number>; byKind: Record<AccessKind, number> };
  lastAccessedAt: string | null;
  /** One point per UTC day of the window, zero-filled, oldest first. */
  daily: UsageDailyPointDto[];
}

export interface UsageTopItemDto {
  resource: UsageResourceKind;
  id: string;
  count: number;
  lastAccessedAt: string | null;
}

export interface UsageTopDto {
  resource: UsageResourceKind;
  scope: 'global' | 'workspace';
  workspaceId: string | null;
  window: UsageWindowDto;
  items: UsageTopItemDto[];
}

export interface UsageUnusedItemDto {
  resource: UsageResourceKind;
  id: string;
  /** Memory type; null for Files. */
  type: string | null;
  createdAt: string;
  /** Last access ever (lifetime), possibly before the window; null if never accessed. */
  lastAccessedAt: string | null;
}

export interface UsageUnusedDto {
  resource: UsageResourceKind;
  scope: 'global' | 'workspace';
  workspaceId: string | null;
  window: UsageWindowDto;
  items: UsageUnusedItemDto[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

/**
 * Dashboard aggregate of one scope for one window (`GET .../usage/overview`). Definitions:
 * - Window: the last `days` UTC days including today. `from`/`to` are the first and last UTC day (inclusive); MCP calls are
 *   counted when `occurred_at` is within [`from` 00:00:00Z, `to`+1 day 00:00:00Z). Every daily series has exactly `days` points.
 * - `files` / `memories` / `unused` / `accesses` / `top*` always describe the resources of this scope only: in Global that
 *   means Global resources, never the sum of Workspaces.
 * - `mcp` counts `tools/call` rows of this Workspace; in Global it aggregates all Workspaces (see `callsByWorkspace`).
 * - `mcp.errors` are calls whose outcome is not `ok`; `errorRate` = errors / calls, 0 when there are no calls.
 * - `unused.files` = Files without a daily counter in the window; `unused.memories` = active Memories without one.
 * Only ids, counts, tool names and Workspace identity are returned, never titles, names, content, arguments or queries.
 */
export interface UsageOverviewDto {
  scope: 'global' | 'workspace';
  workspaceId: string | null;
  window: UsageWindowDto;
  files: { total: number; indexed: number; failed: number };
  memories: { total: number; active: number; superseded: number };
  mcp: { calls: number; errors: number; errorRate: number };
  unused: { files: number; memories: number };
  /** File and Memory accesses per UTC day (zero-filled, oldest first). */
  accessesDaily: Array<{ day: string; total: number; byChannel: Record<UsageChannel, number> }>;
  /** MCP calls per UTC day (zero-filled, oldest first). */
  callsDaily: Array<{ day: string; total: number; byOutcome: Record<McpOutcome, number> }>;
  topTools: Array<{ tool: string; calls: number }>;
  topFiles: Array<{ id: string; count: number }>;
  topMemories: Array<{ id: string; count: number }>;
  /** Global only: calls per Workspace (calls > 0, most first); null in a Workspace. */
  callsByWorkspace: Array<{ workspaceId: string; slug: string; name: string; calls: number }> | null;
}
