import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { Principal } from '../auth/principal.js';
import { type ScopeRef, isUuid, scopeColumns } from '../scopes/scope-ref.js';
import { scopeKeyOf } from '../tags/tags.service.js';
import {
  type McpCallDetailDto,
  type McpCallDto,
  type McpCallListDto,
  type McpCallResourceDto,
  encodeMcpCallCursor,
  parseMcpCallsQuery,
} from './mcp-calls.dto.js';
import type { McpOutcome, McpTouchAction, UsageResourceKind } from './usage.constants.js';

const NOT_FOUND = 'Not Found';
const TS_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

interface CallRow {
  id: string;
  ts: string;
  cursor_ts: string;
  workspace_id: string;
  ws_slug: string;
  ws_name: string;
  key_id: string;
  key_name: string;
  client_name: string | null;
  client_version: string | null;
  tool: string;
  outcome: string;
  duration_ms: number;
  result_chars: number;
  truncated: boolean;
  args_summary?: Record<string, unknown>;
}

const SELECT = `SELECT c."id", c."workspace_id", w."slug" AS ws_slug, w."name" AS ws_name, c."key_id", c."key_name", c."client_name", c."client_version",
  c."tool", c."outcome", c."duration_ms", c."result_chars", c."truncated",
  to_char(c."occurred_at" AT TIME ZONE 'UTC', ${TS_FORMAT}) AS cursor_ts`;

/**
 * Admin-only MCP call history. Workspace routes only ever see that Workspace's rows (a foreign and an unknown call id
 * are the same 404); Global routes see all Workspaces and add the Workspace identity. Nothing here reads file or memory
 * content, titles or metadata.
 */
@Injectable()
export class McpCallsService {
  constructor(
    @Inject(getDataSourceToken()) private readonly dataSource: DataSource,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  async list(principal: Principal, scope: ScopeRef, rawQuery: unknown): Promise<McpCallListDto> {
    this.authorization.assertCan(principal, 'usage.mcpCalls', scope);
    const q = parseMcpCallsQuery(rawQuery);
    await this.assertScopeExists(scope);
    const params: unknown[] = [];
    const bind = (v: unknown) => `$${params.push(v)}`;
    const where: string[] = [];
    if (scope.kind === 'workspace') where.push(`c."workspace_id" = ${bind(scope.workspaceId)}::uuid`);
    if (q.tool) where.push(`c."tool" = ${bind(q.tool)}`);
    if (q.keyId) where.push(`c."key_id" = ${bind(q.keyId)}::uuid`);
    if (q.outcome) where.push(`c."outcome" = ${bind(q.outcome)}`);
    if (q.clientName) where.push(`c."client_name" = ${bind(q.clientName)}`);
    if (q.from) where.push(`c."occurred_at" >= ${bind(q.from)}::timestamptz`);
    if (q.to) where.push(`c."occurred_at" < ${bind(q.to)}::timestamptz`);
    if (q.cursor) where.push(`(c."occurred_at", c."id") < (${bind(q.cursor.createdAt)}::timestamptz, ${bind(q.cursor.id)}::uuid)`);
    const rows = (await this.dataSource.query(
      `${SELECT} FROM "mcp_calls" c JOIN "workspaces" w ON w."id" = c."workspace_id"
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY c."occurred_at" DESC, c."id" DESC LIMIT ${bind(q.limit + 1)}`,
      params,
    )) as CallRow[];
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    const cols = scopeColumns(scope);
    return {
      scope: cols.scope,
      workspaceId: cols.workspaceId,
      items: page.map((r) => this.toDto(r, scope.kind === 'global')),
      nextCursor: hasMore && last ? encodeMcpCallCursor({ createdAt: last.cursor_ts, id: last.id }) : null,
      hasMore,
      limit: q.limit,
    };
  }

  async get(principal: Principal, scope: ScopeRef, callId: string): Promise<McpCallDetailDto> {
    this.authorization.assertCan(principal, 'usage.mcpCall', scope);
    await this.assertScopeExists(scope);
    if (!isUuid(callId)) throw new NotFoundException(NOT_FOUND);
    const id = callId.toLowerCase();
    const params: unknown[] = [id];
    const scopeFilter = scope.kind === 'workspace' ? (params.push(scope.workspaceId), ` AND c."workspace_id" = $2::uuid`) : '';
    const rows = (await this.dataSource.query(
      `${SELECT}, c."args_summary" FROM "mcp_calls" c JOIN "workspaces" w ON w."id" = c."workspace_id" WHERE c."id" = $1${scopeFilter}`,
      params,
    )) as CallRow[];
    const row = rows[0];
    if (!row) throw new NotFoundException(NOT_FOUND);
    const touched = (await this.dataSource.query(
      `SELECT r."resource_kind", r."resource_id", r."action", r."scope_key",
              (CASE r."resource_kind" WHEN 'file' THEN EXISTS (SELECT 1 FROM "files" f WHERE f."id" = r."resource_id" AND f."scope_key" = r."scope_key")
                                      ELSE EXISTS (SELECT 1 FROM "memories" m WHERE m."id" = r."resource_id" AND m."scope_key" = r."scope_key") END) AS present
       FROM "mcp_call_resources" r WHERE r."call_id" = $1 ORDER BY r."resource_kind", r."resource_id", r."action"`,
      [id],
    )) as Array<{ resource_kind: string; resource_id: string; action: string; scope_key: string; present: boolean }>;
    const resources: McpCallResourceDto[] = touched.map((t) => ({
      kind: t.resource_kind as UsageResourceKind,
      id: t.resource_id,
      action: t.action as McpTouchAction,
      scope: t.scope_key === 'global' ? 'global' : 'workspace',
      workspaceId: t.scope_key === 'global' ? null : t.scope_key,
      deleted: !t.present,
    }));
    const base = this.toDto(row, true);
    return { ...base, workspace: base.workspace!, argsSummary: row.args_summary ?? {}, resources };
  }

  private toDto(r: CallRow, withWorkspace: boolean): McpCallDto {
    const dto: McpCallDto = {
      id: r.id,
      occurredAt: r.cursor_ts.slice(0, 23) + 'Z',
      keyId: r.key_id,
      keyName: r.key_name,
      clientName: r.client_name,
      clientVersion: r.client_version,
      tool: r.tool,
      outcome: r.outcome as McpOutcome,
      durationMs: Number(r.duration_ms),
      resultChars: Number(r.result_chars),
      truncated: r.truncated,
    };
    if (withWorkspace) dto.workspace = { id: r.workspace_id, slug: r.ws_slug, name: r.ws_name };
    return dto;
  }

  private async assertScopeExists(scope: ScopeRef): Promise<void> {
    if (scope.kind === 'global') return;
    const rows = (await this.dataSource.query(`SELECT 1 FROM "workspaces" WHERE "id" = $1`, [scope.workspaceId])) as unknown[];
    if (rows.length === 0) throw new NotFoundException(NOT_FOUND);
  }
}
