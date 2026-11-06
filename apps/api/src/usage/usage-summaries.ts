import type { DataSource } from 'typeorm';
import type { UsageResourceKind } from './usage.constants.js';

export const TABLES: Record<UsageResourceKind, { daily: string; totals: string; id: string; parent: string }> = {
  file: { daily: 'file_usage_daily', totals: 'file_usage_totals', id: 'file_id', parent: 'files' },
  memory: { daily: 'memory_usage_daily', totals: 'memory_usage_totals', id: 'memory_id', parent: 'memories' },
};

const DAY_MS = 86_400_000;

/** First UTC day (inclusive) of a window of `days` days that ends today, as `YYYY-MM-DD`. */
export function windowStart(now: Date, days: number): string {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (days - 1) * DAY_MS).toISOString().slice(0, 10);
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface AccessSummary {
  accessCount30d: number;
  lastAccessedAt: string | null;
}

/**
 * Admin list projection: the 30-day access count and the last access of a page of resources, in two batched queries
 * (never per row). Resources without counters get 0 and null.
 */
export async function accessSummaries(
  ds: Pick<DataSource, 'query'>,
  kind: UsageResourceKind,
  scopeKey: string,
  ids: string[],
  now: Date = new Date(),
): Promise<Map<string, AccessSummary>> {
  const out = new Map<string, AccessSummary>(ids.map((id) => [id, { accessCount30d: 0, lastAccessedAt: null }]));
  if (ids.length === 0) return out;
  const t = TABLES[kind];
  const [counts, lasts] = (await Promise.all([
    ds.query(
      `SELECT "${t.id}" AS id, sum("count")::bigint AS n FROM "${t.daily}"
       WHERE "scope_key" = $1 AND "${t.id}" = ANY($2::uuid[]) AND "day" >= $3::date AND "day" <= $4::date GROUP BY "${t.id}"`,
      [scopeKey, ids, windowStart(now, 30), utcDay(now)],
    ),
    ds.query(
      `SELECT "${t.id}" AS id, "last_accessed_at" AS at FROM "${t.totals}" WHERE "scope_key" = $1 AND "${t.id}" = ANY($2::uuid[])`,
      [scopeKey, ids],
    ),
  ])) as [Array<{ id: string; n: string | number }>, Array<{ id: string; at: Date | string }>];
  for (const r of counts) out.get(r.id)!.accessCount30d = Number(r.n);
  for (const r of lasts) out.get(r.id)!.lastAccessedAt = new Date(r.at).toISOString();
  return out;
}
