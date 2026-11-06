import { Inject, Injectable, Logger } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { USAGE_BATCH_LEDGER_DAYS } from './usage.constants.js';

const DAY_MS = 86_400_000;

/** Counts only; what one pruning run deleted. */
export interface UsagePruneResult {
  /** `YYYY-MM-DD` (UTC): daily usage rows strictly before this day were deleted. */
  usageCutoffDay: string;
  /** `YYYY-MM-DD` (UTC): MCP calls and `tools/list` counters strictly before this day were deleted. */
  mcpCutoffDay: string;
  dailyRows: number;
  mcpCalls: number;
  listRows: number;
  batchRecords: number;
}

/** Start of the UTC day containing `now`, minus `days` whole days. */
export function utcCutoff(now: Date, days: number): Date {
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(startOfDay - days * DAY_MS);
}

/**
 * Retention. Everything is cut at UTC day boundaries: with N days, data of the N previous UTC days and of today is kept;
 * rows strictly before `startOfUtcDay(now) - N days` are deleted.
 *
 * - Daily resource counters (`*_usage_daily`): `USAGE_RETENTION_DAYS`. Lifetime totals (`*_usage_totals`, with their
 *   channel and kind breakdowns and `last_accessed_at`) are never touched, so all-time numbers stay correct.
 * - MCP calls (their touched-resource links cascade) and the auxiliary `tools/list` counters (`mcp_list_daily`):
 *   `MCP_CALL_RETENTION_DAYS`.
 * - The batch-id ledger (`usage_batches`) is kept `USAGE_BATCH_LEDGER_DAYS` (fixed): long enough for any retry of an
 *   uncertain commit, short enough to stay bounded. A batch retried later than that could be applied twice, which the
 *   best-effort recorder never does (it retries once, within seconds).
 * Failures surface as a code only.
 */
@Injectable()
export class UsageRetentionService {
  private readonly logger = new Logger('UsageRetention');

  constructor(
    @Inject(getDataSourceToken()) private readonly dataSource: DataSource,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'usageRetentionDays' | 'mcpCallRetentionDays'>,
  ) {}

  async prune(now: Date = new Date()): Promise<UsagePruneResult> {
    const usageCutoff = utcCutoff(now, this.config.usageRetentionDays);
    const mcpCutoff = utcCutoff(now, this.config.mcpCallRetentionDays);
    const ledgerCutoff = new Date(now.getTime() - USAGE_BATCH_LEDGER_DAYS * DAY_MS);
    const usageDay = usageCutoff.toISOString().slice(0, 10);
    const mcpDay = mcpCutoff.toISOString().slice(0, 10);
    try {
      // `WITH d AS (DELETE ... RETURNING 1) SELECT count(*)`: TypeORM's DELETE result shape differs from a SELECT's.
      const count = async (table: string, where: string, param: string): Promise<number> => {
        const rows: Array<{ n: number }> = await this.dataSource.query(
          `WITH d AS (DELETE FROM "${table}" WHERE ${where} RETURNING 1) SELECT count(*)::int AS n FROM d`,
          [param],
        );
        return rows[0]?.n ?? 0;
      };
      const dailyRows =
        (await count('file_usage_daily', '"day" < $1::date', usageDay)) +
        (await count('memory_usage_daily', '"day" < $1::date', usageDay));
      const mcpCalls = await count('mcp_calls', '"occurred_at" < $1::timestamptz', mcpCutoff.toISOString());
      const listRows = await count('mcp_list_daily', '"day" < $1::date', mcpDay);
      const batchRecords = await count('usage_batches', '"applied_at" < $1::timestamptz', ledgerCutoff.toISOString());
      const result = { usageCutoffDay: usageDay, mcpCutoffDay: mcpDay, dailyRows, mcpCalls, listRows, batchRecords };
      this.logger.log(`Usage pruned (daily ${dailyRows}, mcp calls ${mcpCalls}, list ${listRows}, batches ${batchRecords})`);
      return result;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      const safe = typeof code === 'string' && /^[A-Za-z0-9_]{1,24}$/.test(code) ? code : 'prune_failed';
      this.logger.error(`Usage pruning failed (${safe})`);
      throw Object.assign(new Error(`Usage pruning failed (${safe})`), { code: safe });
    }
  }
}
