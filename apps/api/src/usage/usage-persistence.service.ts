import { Inject, Injectable } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { isUuid } from '../scopes/scope-ref.js';
import type { ScopeRef } from '../scopes/scope-ref.js';
import {
  ACCESS_KINDS,
  MCP_OUTCOMES,
  MCP_TOUCH_ACTIONS,
  USAGE_CHANNELS,
  USAGE_RESOURCE_KINDS,
  type UsageResourceKind,
} from './usage.constants.js';
import type {
  ListCountIncrement,
  McpCallRecord,
  ResourceAccessIncrement,
  UsageBatchInput,
  UsageBatchResult,
} from './usage-batch.js';

export const MAX_BATCH_ACCESSES = 5000;
export const MAX_BATCH_CALLS = 1000;
export const MAX_BATCH_TOUCHED = 20_000;
export const MAX_BATCH_LIST_COUNTS = 2000;
const MAX_ARGS_SUMMARY_BYTES = 4096;
const MAX_SUMMARY_STRING = 200;
const MAX_COUNT = 1_000_000_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Fixed, content-free failure: `code` is `invalid_batch` or a short SQLSTATE-like driver code; never a driver message. */
export class UsagePersistenceError extends Error {
  constructor(readonly code: string) {
    super(`Usage persistence failed (${code})`);
    this.name = 'UsagePersistenceError';
    this.stack = `${this.name}: ${code}`;
  }
}

const TABLES: Record<UsageResourceKind, { parent: string; idColumn: string; daily: string; totals: string }> = {
  file: { parent: 'files', idColumn: 'file_id', daily: 'file_usage_daily', totals: 'file_usage_totals' },
  memory: { parent: 'memories', idColumn: 'memory_id', daily: 'memory_usage_daily', totals: 'memory_usage_totals' },
};

/**
 * Atomic, idempotent persistence of usage batches (storage only; recording and instrumentation live elsewhere).
 *
 * - One transaction per batch. The first statement claims `batchId` in `usage_batches`; if it was applied before, the
 *   call is a no-op (`duplicate`), so retrying after an uncertain commit cannot double daily or lifetime increments.
 *   MCP call rows are additionally idempotent by their own event id.
 * - Daily rows are upserted per (resource, UTC day, channel, kind); lifetime totals (with channel and kind breakdowns)
 *   are incremented in the same transaction and `last_accessed_at` only moves forward (GREATEST).
 * - A delayed batch never resurrects anything: items are inserted only for resources / Workspaces that still exist, and
 *   the parent row is locked `FOR KEY SHARE` so a concurrent delete waits for this transaction. The composite foreign
 *   keys (and the Workspace cascade) delete the rows again with their resource or Workspace.
 * - Errors are reduced to a code; values and driver messages are never logged or thrown.
 */
@Injectable()
export class UsagePersistenceService {
  constructor(@Inject(getDataSourceToken()) private readonly dataSource: DataSource) {}

  async persistBatch(input: UsageBatchInput): Promise<UsageBatchResult> {
    const batch = validateBatch(input);
    try {
      return await this.dataSource.transaction((m) => this.apply(m, batch));
    } catch (err) {
      if (err instanceof UsagePersistenceError) throw err;
      const code = (err as { code?: unknown } | null)?.code;
      throw new UsagePersistenceError(typeof code === 'string' && /^[A-Za-z0-9_]{1,24}$/.test(code) ? code : 'persist_failed');
    }
  }

  private async apply(m: EntityManager, batch: ValidBatch): Promise<UsageBatchResult> {
    const claimed = await m.query(
      `INSERT INTO "usage_batches" ("batch_id") VALUES ($1) ON CONFLICT ("batch_id") DO NOTHING RETURNING "batch_id"`,
      [batch.batchId],
    );
    const result: UsageBatchResult = {
      status: 'applied', accessRows: 0, skippedAccessResources: 0, mcpCalls: 0, skippedMcpCalls: 0, listRows: 0, skippedListRows: 0,
    };
    if (claimed.length === 0) return { ...result, status: 'duplicate' };

    for (const kind of USAGE_RESOURCE_KINDS) {
      const items = batch.accesses.filter((a) => a.resourceKind === kind);
      if (items.length === 0) continue;
      const { rows, resources, applied } = await this.applyAccesses(m, kind, items);
      result.accessRows += rows;
      result.skippedAccessResources += resources - applied;
    }
    if (batch.mcpCalls.length > 0) {
      const { inserted, skipped } = await this.applyCalls(m, batch.mcpCalls);
      result.mcpCalls = inserted;
      result.skippedMcpCalls = skipped;
    }
    if (batch.listCounts.length > 0) {
      const listRows = await this.applyListCounts(m, batch.listCounts);
      result.listRows = listRows;
      result.skippedListRows = new Set(batch.listCounts.map((l) => `${l.keyId}|${l.day}`)).size - listRows;
    }
    return result;
  }

  private async applyAccesses(m: EntityManager, kind: UsageResourceKind, items: ResourceAccessIncrement[]) {
    const t = TABLES[kind];
    const params = [
      items.map((i) => scopeKeyOf(i.scope)),
      items.map((i) => i.resourceId),
      items.map((i) => i.day),
      items.map((i) => i.channel),
      items.map((i) => i.accessKind),
      items.map((i) => i.count),
      items.map((i) => i.lastAccessedAt.toISOString()),
    ];
    // Aggregated per key so ON CONFLICT never sees the same row twice. `live` locks the parents that still exist.
    const prelude = `
      WITH raw AS (
        SELECT * FROM unnest($1::text[], $2::uuid[], $3::date[], $4::text[], $5::text[], $6::bigint[], $7::timestamptz[])
          AS r(scope_key, id, day, channel, access_kind, cnt, accessed_at)
      ), input AS (
        SELECT scope_key, id, day, channel, access_kind, sum(cnt)::bigint AS cnt, max(accessed_at) AS accessed_at
        FROM raw GROUP BY scope_key, id, day, channel, access_kind
      ), live AS (
        SELECT p.id, p.scope_key FROM "${t.parent}" p
        WHERE (p.id, p.scope_key) IN (SELECT id, scope_key FROM input) FOR KEY SHARE OF p
      )`;
    const scopeCols = `CASE WHEN i.scope_key = 'global' THEN 'global' ELSE 'workspace' END,
          CASE WHEN i.scope_key = 'global' THEN NULL ELSE i.scope_key::uuid END`;

    const daily = await m.query(
      `${prelude}
       INSERT INTO "${t.daily}" ("scope", "workspace_id", "${t.idColumn}", "day", "channel", "access_kind", "count")
       SELECT ${scopeCols}, i.id, i.day, i.channel, i.access_kind, i.cnt
       FROM input i JOIN live l ON l.id = i.id AND l.scope_key = i.scope_key
       ON CONFLICT ("${t.idColumn}", "day", "channel", "access_kind")
       DO UPDATE SET "count" = "${t.daily}"."count" + EXCLUDED."count"
       RETURNING 1`,
      params,
    );
    const totals = await m.query(
      `${prelude}, per_resource AS (
         SELECT i.scope_key, i.id,
                sum(i.cnt)::bigint AS total,
                coalesce(sum(i.cnt) FILTER (WHERE i.access_kind = 'read'), 0)::bigint AS reads,
                coalesce(sum(i.cnt) FILTER (WHERE i.access_kind = 'retrieved'), 0)::bigint AS retrieved,
                coalesce(sum(i.cnt) FILTER (WHERE i.channel = 'ui'), 0)::bigint AS ui,
                coalesce(sum(i.cnt) FILTER (WHERE i.channel = 'api'), 0)::bigint AS api,
                coalesce(sum(i.cnt) FILTER (WHERE i.channel = 'mcp'), 0)::bigint AS mcp,
                max(i.accessed_at) AS accessed_at
         FROM input i GROUP BY i.scope_key, i.id
       )
       INSERT INTO "${t.totals}" ("scope", "workspace_id", "${t.idColumn}", "total_count", "read_count", "retrieved_count",
                                  "ui_count", "api_count", "mcp_count", "last_accessed_at")
       SELECT ${scopeCols}, i.id, i.total, i.reads, i.retrieved, i.ui, i.api, i.mcp, i.accessed_at
       FROM per_resource i JOIN live l ON l.id = i.id AND l.scope_key = i.scope_key
       ON CONFLICT ("${t.idColumn}") DO UPDATE SET
         "total_count" = "${t.totals}"."total_count" + EXCLUDED."total_count",
         "read_count" = "${t.totals}"."read_count" + EXCLUDED."read_count",
         "retrieved_count" = "${t.totals}"."retrieved_count" + EXCLUDED."retrieved_count",
         "ui_count" = "${t.totals}"."ui_count" + EXCLUDED."ui_count",
         "api_count" = "${t.totals}"."api_count" + EXCLUDED."api_count",
         "mcp_count" = "${t.totals}"."mcp_count" + EXCLUDED."mcp_count",
         "last_accessed_at" = GREATEST("${t.totals}"."last_accessed_at", EXCLUDED."last_accessed_at")
       RETURNING 1`,
      params,
    );
    const resources = new Set(items.map((i) => `${scopeKeyOf(i.scope)}|${i.resourceId}`)).size;
    return { rows: daily.length as number, resources, applied: totals.length as number };
  }

  private async applyCalls(m: EntityManager, calls: McpCallRecord[]) {
    const inserted: Array<{ id: string }> = await m.query(
      `WITH input AS (
         SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::text[], $8::text[],
                              $9::text[], $10::int[], $11::int[], $12::boolean[], $13::text[])
           AS c(id, occurred_at, workspace_id, key_id, key_name, client_name, client_version, tool, outcome, duration_ms, result_chars, truncated, args_summary)
       ), live AS (
         SELECT w.id FROM "workspaces" w WHERE w.id IN (SELECT workspace_id FROM input) FOR KEY SHARE OF w
       )
       INSERT INTO "mcp_calls" ("id", "occurred_at", "workspace_id", "key_id", "key_name", "client_name", "client_version", "tool",
                                "outcome", "duration_ms", "result_chars", "truncated", "args_summary")
       SELECT c.id, c.occurred_at, c.workspace_id, c.key_id, c.key_name, c.client_name, c.client_version, c.tool, c.outcome,
              c.duration_ms, c.result_chars, c.truncated, c.args_summary::jsonb
       FROM input c JOIN live l ON l.id = c.workspace_id
       ON CONFLICT ("id") DO NOTHING
       RETURNING "id"`,
      [
        calls.map((c) => c.id),
        calls.map((c) => c.occurredAt.toISOString()),
        calls.map((c) => c.workspaceId),
        calls.map((c) => c.keyId),
        calls.map((c) => c.keyName),
        calls.map((c) => c.clientName ?? null),
        calls.map((c) => c.clientVersion ?? null),
        calls.map((c) => c.tool),
        calls.map((c) => c.outcome),
        calls.map((c) => c.durationMs),
        calls.map((c) => c.resultChars),
        calls.map((c) => c.truncated),
        calls.map((c) => JSON.stringify(c.argsSummary)),
      ],
    );
    const insertedIds = new Set(inserted.map((r) => r.id));
    // Touched ids only for calls inserted by this batch: a replayed call never adds links twice.
    const touched = calls.filter((c) => insertedIds.has(c.id)).flatMap((c) => c.touched.map((t) => ({ callId: c.id, t })));
    if (touched.length > 0) {
      await m.query(
        `INSERT INTO "mcp_call_resources" ("call_id", "resource_kind", "resource_id", "scope_key", "action")
         SELECT * FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[], $5::text[])
         ON CONFLICT DO NOTHING`,
        [
          touched.map((x) => x.callId),
          touched.map((x) => x.t.resourceKind),
          touched.map((x) => x.t.resourceId),
          touched.map((x) => scopeKeyOf(x.t.scope)),
          touched.map((x) => x.t.action),
        ],
      );
    }
    return { inserted: inserted.length, skipped: calls.length - inserted.length };
  }

  private async applyListCounts(m: EntityManager, rows: ListCountIncrement[]): Promise<number> {
    const result: unknown[] = await m.query(
      `WITH raw AS (
         SELECT * FROM unnest($1::uuid[], $2::date[], $3::uuid[], $4::text[], $5::bigint[]) AS r(key_id, day, workspace_id, key_name, cnt)
       ), input AS (
         SELECT key_id, day, (array_agg(workspace_id))[1] AS workspace_id, (array_agg(key_name ORDER BY key_name))[1] AS key_name, sum(cnt)::bigint AS cnt
         FROM raw GROUP BY key_id, day
       ), live AS (
         SELECT w.id FROM "workspaces" w WHERE w.id IN (SELECT workspace_id FROM input) FOR KEY SHARE OF w
       )
       INSERT INTO "mcp_list_daily" ("key_id", "day", "workspace_id", "key_name", "count")
       SELECT i.key_id, i.day, i.workspace_id, i.key_name, i.cnt FROM input i JOIN live l ON l.id = i.workspace_id
       ON CONFLICT ("key_id", "day") DO UPDATE SET "count" = "mcp_list_daily"."count" + EXCLUDED."count", "key_name" = EXCLUDED."key_name"
       RETURNING 1`,
      [rows.map((r) => r.keyId), rows.map((r) => r.day), rows.map((r) => r.workspaceId), rows.map((r) => r.keyName), rows.map((r) => r.count)],
    );
    return result.length;
  }
}

function scopeKeyOf(scope: ScopeRef): string {
  return scope.kind === 'global' ? 'global' : scope.workspaceId.toLowerCase();
}

interface ValidBatch {
  batchId: string;
  accesses: ResourceAccessIncrement[];
  mcpCalls: McpCallRecord[];
  listCounts: ListCountIncrement[];
}

const bad = (): never => {
  throw new UsagePersistenceError('invalid_batch');
};

function validDay(day: unknown): string {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return bad();
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return bad();
  return day;
}

function validCount(n: unknown): number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= MAX_COUNT ? n : bad();
}

function validNonNegativeInt(n: unknown): number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 2_147_483_647 ? n : bad();
}

function validDate(d: unknown): Date {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : bad();
}

function validUuid(v: unknown): string {
  return isUuid(v) ? v.toLowerCase() : bad();
}

function validScope(scope: unknown): ScopeRef {
  const s = scope as { kind?: unknown; workspaceId?: unknown } | null;
  if (s?.kind === 'global' && s.workspaceId === undefined) return { kind: 'global' };
  if (s?.kind === 'workspace') return { kind: 'workspace', workspaceId: validUuid(s.workspaceId) };
  return bad();
}

function validName(v: unknown, max: number): string {
  return typeof v === 'string' && v.length >= 1 && v.length <= max && !v.includes('\0') ? v : bad();
}

function validOptionalName(v: unknown, max: number): string | null {
  return v === undefined || v === null ? null : validName(v, max);
}

/** Summary values: scalars or arrays of scalars with short strings; anything nested or large is rejected. */
function validSummary(summary: unknown): Record<string, unknown> {
  if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) return bad();
  const scalar = (v: unknown): boolean =>
    v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ||
    (typeof v === 'string' && v.length <= MAX_SUMMARY_STRING && !v.includes('\0'));
  for (const [key, value] of Object.entries(summary)) {
    if (key.length > 64) bad();
    if (Array.isArray(value) ? value.length > 50 || !value.every(scalar) : !scalar(value)) bad();
  }
  if (Buffer.byteLength(JSON.stringify(summary), 'utf8') > MAX_ARGS_SUMMARY_BYTES) bad();
  return summary as Record<string, unknown>;
}

function validateBatch(input: UsageBatchInput): ValidBatch {
  const accesses = input.accesses ?? [];
  const mcpCalls = input.mcpCalls ?? [];
  const listCounts = input.listCounts ?? [];
  if (accesses.length > MAX_BATCH_ACCESSES || mcpCalls.length > MAX_BATCH_CALLS || listCounts.length > MAX_BATCH_LIST_COUNTS) bad();
  if (mcpCalls.reduce((n, c) => n + (c.touched?.length ?? 0), 0) > MAX_BATCH_TOUCHED) bad();
  const batchId = validUuid(input.batchId);
  return {
    batchId,
    accesses: accesses.map((a) => ({
      resourceKind: (USAGE_RESOURCE_KINDS as readonly string[]).includes(a.resourceKind) ? a.resourceKind : bad(),
      resourceId: validUuid(a.resourceId),
      scope: validScope(a.scope),
      day: validDay(a.day),
      channel: (USAGE_CHANNELS as readonly string[]).includes(a.channel) ? a.channel : bad(),
      accessKind: (ACCESS_KINDS as readonly string[]).includes(a.accessKind) ? a.accessKind : bad(),
      count: validCount(a.count),
      lastAccessedAt: validDate(a.lastAccessedAt),
    })),
    mcpCalls: mcpCalls.map((c) => ({
      id: validUuid(c.id),
      occurredAt: validDate(c.occurredAt),
      workspaceId: validUuid(c.workspaceId),
      keyId: validUuid(c.keyId),
      keyName: validName(c.keyName, 100),
      clientName: validOptionalName(c.clientName, 200),
      clientVersion: c.clientVersion == null ? null : c.clientName == null ? bad() : validName(c.clientVersion, 100),
      tool: validName(c.tool, 128),
      outcome: (MCP_OUTCOMES as readonly string[]).includes(c.outcome) ? c.outcome : bad(),
      durationMs: validNonNegativeInt(c.durationMs),
      resultChars: validNonNegativeInt(c.resultChars),
      truncated: typeof c.truncated === 'boolean' ? c.truncated : bad(),
      argsSummary: validSummary(c.argsSummary),
      touched: (c.touched ?? []).map((t) => ({
        resourceKind: (USAGE_RESOURCE_KINDS as readonly string[]).includes(t.resourceKind) ? t.resourceKind : bad(),
        resourceId: validUuid(t.resourceId),
        scope: validScope(t.scope),
        action: (MCP_TOUCH_ACTIONS as readonly string[]).includes(t.action) ? t.action : bad(),
      })),
    })),
    listCounts: listCounts.map((l) => ({
      workspaceId: validUuid(l.workspaceId),
      keyId: validUuid(l.keyId),
      keyName: validName(l.keyName, 100),
      day: validDay(l.day),
      count: validCount(l.count),
    })),
  };
}
