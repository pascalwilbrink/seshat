import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { Principal } from '../auth/principal.js';
import { type ScopeRef, isUuid, scopeColumns } from '../scopes/scope-ref.js';
import { scopeKeyOf } from '../tags/tags.service.js';
import { ACCESS_KINDS, MCP_OUTCOMES, USAGE_CHANNELS, type McpOutcome, type UsageResourceKind } from './usage.constants.js';
import {
  type ResourceUsageDto,
  type UsageDailyPointDto,
  type UsageTopDto,
  type UsageOverviewDto,
  type UsageUnusedDto,
  type UsageWindowDto,
  type UsageWindowDays,
  USAGE_OVERVIEW_TOP_LIMIT,
  encodeUsageCursor,
  parseOverviewQuery,
  parseResourceUsageQuery,
  parseTopQuery,
  parseUnusedQuery,
} from './usage.dto.js';
import { TABLES, utcDay, windowStart } from './usage-summaries.js';

const NOT_FOUND = 'Not Found';
const DAY_MS = 86_400_000;

/**
 * Admin-only usage analytics for one scope. Window: the last `days` UTC days including today. Lifetime numbers come
 * from the totals tables (never pruned); window numbers from the daily counters.
 */
@Injectable()
export class UsageService {
  constructor(
    @Inject(getDataSourceToken()) private readonly dataSource: DataSource,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  /** Test seam for deterministic UTC boundaries. */
  protected now(): Date {
    return new Date();
  }

  async resourceUsage(principal: Principal, scope: ScopeRef, kind: UsageResourceKind, id: string, rawQuery: unknown): Promise<ResourceUsageDto> {
    this.authorization.assertCan(principal, kind === 'file' ? 'usage.file' : 'usage.memory', scope);
    const { days } = parseResourceUsageQuery(rawQuery);
    await this.assertScopeExists(scope);
    if (!isUuid(id)) throw new NotFoundException(NOT_FOUND);
    const rid = id.toLowerCase();
    const scopeKey = scopeKeyOf(scope);
    const t = TABLES[kind];
    const exists = (await this.dataSource.query(`SELECT 1 FROM "${t.parent}" WHERE "id" = $1 AND "scope_key" = $2`, [rid, scopeKey])) as unknown[];
    if (exists.length === 0) throw new NotFoundException(NOT_FOUND);

    const now = this.now();
    const window = this.window(now, days);
    const [totals, daily] = await Promise.all([
      this.dataSource.query(
        `SELECT "total_count", "read_count", "retrieved_count", "ui_count", "api_count", "mcp_count", "last_accessed_at"
         FROM "${t.totals}" WHERE "${t.id}" = $1 AND "scope_key" = $2`,
        [rid, scopeKey],
      ) as Promise<Array<Record<string, string | number | Date>>>,
      this.dataSource.query(
        `SELECT to_char("day", 'YYYY-MM-DD') AS day, "channel", "access_kind", sum("count")::bigint AS n FROM "${t.daily}"
         WHERE "${t.id}" = $1 AND "scope_key" = $2 AND "day" >= $3::date AND "day" <= $4::date GROUP BY "day", "channel", "access_kind"`,
        [rid, scopeKey, window.from, window.to],
      ) as Promise<Array<{ day: string; channel: string; access_kind: string; n: string | number }>>,
    ]);
    const tot = totals[0];
    const num = (k: string) => (tot ? Number(tot[k]) : 0);
    const cols = scopeColumns(scope);
    return {
      resource: kind,
      id: rid,
      scope: cols.scope,
      workspaceId: cols.workspaceId,
      window,
      lifetime: {
        total: num('total_count'),
        byChannel: { ui: num('ui_count'), api: num('api_count'), mcp: num('mcp_count') },
        byKind: { read: num('read_count'), retrieved: num('retrieved_count') },
      },
      lastAccessedAt: tot ? new Date(tot.last_accessed_at as Date).toISOString() : null,
      daily: this.fillDaily(window, daily),
    };
  }

  async top(principal: Principal, scope: ScopeRef, rawQuery: unknown): Promise<UsageTopDto> {
    this.authorization.assertCan(principal, 'usage.top', scope);
    const q = parseTopQuery(rawQuery);
    await this.assertScopeExists(scope);
    const t = TABLES[q.resource];
    const window = this.window(this.now(), q.days);
    const rows = (await this.dataSource.query(
      `SELECT d."${t.id}" AS id, d.n, tt."last_accessed_at" AS at FROM (
         SELECT "${t.id}", sum("count")::bigint AS n FROM "${t.daily}"
         WHERE "scope_key" = $1 AND "day" >= $2::date AND "day" <= $3::date GROUP BY "${t.id}"
       ) d LEFT JOIN "${t.totals}" tt ON tt."${t.id}" = d."${t.id}"
       ORDER BY d.n DESC, d."${t.id}" ASC LIMIT $4`,
      [scopeKeyOf(scope), window.from, window.to, q.limit],
    )) as Array<{ id: string; n: string | number; at: Date | null }>;
    const cols = scopeColumns(scope);
    return {
      resource: q.resource,
      scope: cols.scope,
      workspaceId: cols.workspaceId,
      window,
      items: rows.map((r) => ({ resource: q.resource, id: r.id, count: Number(r.n), lastAccessedAt: r.at ? new Date(r.at).toISOString() : null })),
    };
  }

  /**
   * Resources of the scope without any access in the window, newest created first (cursor on created_at and id).
   * Files: every File. Memories: active Memories only (superseded ones are not expected to be read).
   */
  async unused(principal: Principal, scope: ScopeRef, rawQuery: unknown): Promise<UsageUnusedDto> {
    this.authorization.assertCan(principal, 'usage.unused', scope);
    const q = parseUnusedQuery(rawQuery);
    await this.assertScopeExists(scope);
    const t = TABLES[q.resource];
    const window = this.window(this.now(), q.days);
    const params: unknown[] = [scopeKeyOf(scope), window.from, window.to];
    const bind = (v: unknown) => `$${params.push(v)}`;
    const where = [
      `p."scope_key" = $1`,
      `NOT EXISTS (SELECT 1 FROM "${t.daily}" d WHERE d."${t.id}" = p."id" AND d."scope_key" = p."scope_key" AND d."day" >= $2::date AND d."day" <= $3::date)`,
    ];
    if (q.resource === 'memory') where.push(`p."status" = 'active'`);
    if (q.cursor) where.push(`(p."created_at", p."id") < (${bind(q.cursor.createdAt)}::timestamptz, ${bind(q.cursor.id)}::uuid)`);
    const typeCol = q.resource === 'memory' ? `p."type"` : `NULL::text`;
    const rows = (await this.dataSource.query(
      `SELECT p."id", ${typeCol} AS type, p."created_at", tt."last_accessed_at" AS at,
              to_char(p."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
       FROM "${t.parent}" p LEFT JOIN "${t.totals}" tt ON tt."${t.id}" = p."id"
       WHERE ${where.join(' AND ')} ORDER BY p."created_at" DESC, p."id" DESC LIMIT ${bind(q.limit + 1)}`,
      params,
    )) as Array<{ id: string; type: string | null; created_at: Date; at: Date | null; cursor_ts: string }>;
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    const cols = scopeColumns(scope);
    return {
      resource: q.resource,
      scope: cols.scope,
      workspaceId: cols.workspaceId,
      window,
      items: page.map((r) => ({
        resource: q.resource,
        id: r.id,
        type: r.type,
        createdAt: new Date(r.created_at).toISOString(),
        lastAccessedAt: r.at ? new Date(r.at).toISOString() : null,
      })),
      nextCursor: hasMore && last ? encodeUsageCursor({ createdAt: last.cursor_ts, id: last.id }) : null,
      hasMore,
      limit: q.limit,
    };
  }

  /** One-response dashboard aggregate; see {@link UsageOverviewDto} for the definitions. Bounded GROUP BY queries only. */
  async overview(principal: Principal, scope: ScopeRef, rawQuery: unknown): Promise<UsageOverviewDto> {
    this.authorization.assertCan(principal, 'usage.overview', scope);
    const { days } = parseOverviewQuery(rawQuery);
    await this.assertScopeExists(scope);
    const sk = scopeKeyOf(scope);
    const window = this.window(this.now(), days);
    const from = `${window.from}T00:00:00.000Z`;
    const until = new Date(Date.parse(`${window.to}T00:00:00Z`) + DAY_MS).toISOString();
    const q = <T>(sql: string, params: unknown[]) => this.dataSource.query(sql, params) as Promise<T[]>;
    const dailyBy = (t: (typeof TABLES)[UsageResourceKind]) =>
      q<{ day: string; channel: string; n: string | number }>(
        `SELECT to_char("day", 'YYYY-MM-DD') AS day, "channel", sum("count")::bigint AS n FROM "${t.daily}"
         WHERE "scope_key" = $1 AND "day" >= $2::date AND "day" <= $3::date GROUP BY "day", "channel"`,
        [sk, window.from, window.to],
      );
    const topOf = (t: (typeof TABLES)[UsageResourceKind]) =>
      q<{ id: string; n: string | number }>(
        `SELECT "${t.id}" AS id, sum("count")::bigint AS n FROM "${t.daily}"
         WHERE "scope_key" = $1 AND "day" >= $2::date AND "day" <= $3::date GROUP BY "${t.id}" ORDER BY n DESC, "${t.id}" ASC LIMIT $4`,
        [sk, window.from, window.to, USAGE_OVERVIEW_TOP_LIMIT],
      );
    const unusedOf = async (kind: UsageResourceKind) => {
      const t = TABLES[kind];
      const rows = await q<{ n: string | number }>(
        `SELECT count(*)::bigint AS n FROM "${t.parent}" p WHERE p."scope_key" = $1${kind === 'memory' ? ` AND p."status" = 'active'` : ''}
         AND NOT EXISTS (SELECT 1 FROM "${t.daily}" d WHERE d."${t.id}" = p."id" AND d."scope_key" = p."scope_key" AND d."day" >= $2::date AND d."day" <= $3::date)`,
        [sk, window.from, window.to],
      );
      return Number(rows[0]?.n ?? 0);
    };
    // MCP calls: a Workspace is filtered by id, Global aggregates every Workspace.
    const mcpWhere = scope.kind === 'global' ? '"occurred_at" >= $1::timestamptz AND "occurred_at" < $2::timestamptz' : '"workspace_id" = $3 AND "occurred_at" >= $1::timestamptz AND "occurred_at" < $2::timestamptz';
    const mcpParams = scope.kind === 'global' ? [from, until] : [from, until, scope.workspaceId];
    const [fileStatus, memStatus, fileDaily, memDaily, callRows, toolRows, topFiles, topMemories, unusedFiles, unusedMemories, perWorkspace] = await Promise.all([
      q<{ s: string; n: string | number }>(`SELECT "ingestion_status" AS s, count(*)::bigint AS n FROM "files" WHERE "scope_key" = $1 GROUP BY "ingestion_status"`, [sk]),
      q<{ s: string; n: string | number }>(`SELECT "status" AS s, count(*)::bigint AS n FROM "memories" WHERE "scope_key" = $1 GROUP BY "status"`, [sk]),
      dailyBy(TABLES.file),
      dailyBy(TABLES.memory),
      q<{ day: string; outcome: string; n: string | number }>(
        `SELECT to_char("occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, "outcome", count(*)::bigint AS n FROM "mcp_calls" WHERE ${mcpWhere} GROUP BY 1, 2`,
        mcpParams,
      ),
      q<{ tool: string; n: string | number }>(
        `SELECT "tool", count(*)::bigint AS n FROM "mcp_calls" WHERE ${mcpWhere} GROUP BY "tool" ORDER BY n DESC, "tool" ASC LIMIT ${USAGE_OVERVIEW_TOP_LIMIT}`,
        mcpParams,
      ),
      topOf(TABLES.file),
      topOf(TABLES.memory),
      unusedOf('file'),
      unusedOf('memory'),
      scope.kind === 'global'
        ? q<{ id: string; slug: string; name: string; n: string | number }>(
            `SELECT w."id", w."slug", w."name", c.n FROM (SELECT "workspace_id", count(*)::bigint AS n FROM "mcp_calls" WHERE ${mcpWhere} GROUP BY "workspace_id") c
             JOIN "workspaces" w ON w."id" = c."workspace_id" ORDER BY c.n DESC, w."id" ASC`,
            mcpParams,
          )
        : Promise.resolve(null),
    ]);

    const statusCount = (rows: Array<{ s: string; n: string | number }>, s: string) => Number(rows.find((r) => r.s === s)?.n ?? 0);
    const sumAll = (rows: Array<{ n: string | number }>) => rows.reduce((a, r) => a + Number(r.n), 0);

    const dayList = this.fillDaily(window, []).map((p) => p.day);
    const accesses = new Map(dayList.map((day) => [day, { day, total: 0, byChannel: { ui: 0, api: 0, mcp: 0 } as Record<(typeof USAGE_CHANNELS)[number], number> }]));
    for (const r of [...fileDaily, ...memDaily]) {
      const p = accesses.get(r.day);
      if (!p || !(USAGE_CHANNELS as readonly string[]).includes(r.channel)) continue;
      p.total += Number(r.n);
      p.byChannel[r.channel as (typeof USAGE_CHANNELS)[number]] += Number(r.n);
    }
    const zeroOutcomes = () => Object.fromEntries(MCP_OUTCOMES.map((o) => [o, 0])) as Record<McpOutcome, number>;
    const calls = new Map(dayList.map((day) => [day, { day, total: 0, byOutcome: zeroOutcomes() }]));
    let errors = 0;
    let total = 0;
    for (const r of callRows) {
      const p = calls.get(r.day);
      if (!p || !(MCP_OUTCOMES as readonly string[]).includes(r.outcome)) continue;
      const n = Number(r.n);
      p.total += n;
      p.byOutcome[r.outcome as McpOutcome] += n;
      total += n;
      if (r.outcome !== 'ok') errors += n;
    }
    const cols = scopeColumns(scope);
    return {
      scope: cols.scope,
      workspaceId: cols.workspaceId,
      window,
      files: { total: sumAll(fileStatus), indexed: statusCount(fileStatus, 'indexed'), failed: statusCount(fileStatus, 'failed') },
      memories: { total: sumAll(memStatus), active: statusCount(memStatus, 'active'), superseded: statusCount(memStatus, 'superseded') },
      mcp: { calls: total, errors, errorRate: total === 0 ? 0 : errors / total },
      unused: { files: unusedFiles, memories: unusedMemories },
      accessesDaily: [...accesses.values()],
      callsDaily: [...calls.values()],
      topTools: toolRows.map((r) => ({ tool: r.tool, calls: Number(r.n) })),
      topFiles: topFiles.map((r) => ({ id: r.id, count: Number(r.n) })),
      topMemories: topMemories.map((r) => ({ id: r.id, count: Number(r.n) })),
      callsByWorkspace: perWorkspace ? perWorkspace.map((r) => ({ workspaceId: r.id, slug: r.slug, name: r.name, calls: Number(r.n) })) : null,
    };
  }

  private window(now: Date, days: UsageWindowDays): UsageWindowDto {
    return { days, from: windowStart(now, days), to: utcDay(now) };
  }

  private fillDaily(window: UsageWindowDto, rows: Array<{ day: string; channel: string; access_kind: string; n: string | number }>): UsageDailyPointDto[] {
    const points = new Map<string, UsageDailyPointDto>();
    const start = Date.parse(`${window.from}T00:00:00Z`);
    for (let i = 0; i < window.days; i++) {
      const day = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
      points.set(day, { day, total: 0, byChannel: { ui: 0, api: 0, mcp: 0 }, byKind: { read: 0, retrieved: 0 } });
    }
    for (const r of rows) {
      const p = points.get(r.day);
      if (!p) continue;
      const n = Number(r.n);
      p.total += n;
      if ((USAGE_CHANNELS as readonly string[]).includes(r.channel)) p.byChannel[r.channel as keyof typeof p.byChannel] += n;
      if ((ACCESS_KINDS as readonly string[]).includes(r.access_kind)) p.byKind[r.access_kind as keyof typeof p.byKind] += n;
    }
    return [...points.values()];
  }

  private async assertScopeExists(scope: ScopeRef): Promise<void> {
    if (scope.kind === 'global') return;
    const rows = (await this.dataSource.query(`SELECT 1 FROM "workspaces" WHERE "id" = $1`, [scope.workspaceId])) as unknown[];
    if (rows.length === 0) throw new NotFoundException(NOT_FOUND);
  }
}
