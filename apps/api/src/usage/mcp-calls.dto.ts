import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { decodeCursor, encodeCursor, type FileCursor } from '../files/file-list-query.js';
import { isUuid } from '../scopes/scope-ref.js';
import { MCP_OUTCOMES, type McpOutcome, type McpTouchAction, type UsageResourceKind } from './usage.constants.js';

/**
 * Admin MCP call history: request validation and response shapes. Rows are minimal projections of `mcp_calls`:
 * ids, key-name snapshot, client, tool, outcome, sizes and the allowlisted argument summary. Touched resources carry
 * id, kind and scope only (never a name or title), and a `deleted` marker once the resource is gone.
 */
export const MCP_CALLS_DEFAULT_LIMIT = 25;
export const MCP_CALLS_MAX_LIMIT = 100;
export const MCP_CALL_TOOL_MAX = 128;
export const MCP_CALL_CLIENT_MAX = 200;

const invalidQuery = () => new BadRequestException('Invalid query');
const str = z.string().max(1024).optional().transform((v) => (v === undefined || v === '' ? undefined : v));

export interface McpCallsQuery {
  limit: number;
  cursor: FileCursor | null;
  tool: string | null;
  keyId: string | null;
  outcome: McpOutcome | null;
  clientName: string | null;
  /** Inclusive lower bound (ISO instant). */
  from: string | null;
  /** Exclusive upper bound (ISO instant). */
  to: string | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/** `YYYY-MM-DD` is a UTC day (`to` includes that whole day); an ISO instant with offset is used as given (`to` inclusive of that millisecond). */
function parseBound(raw: string | undefined, end: boolean): string | null {
  if (raw === undefined) return null;
  if (DATE_ONLY.test(raw)) {
    const ms = Date.parse(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== raw) throw invalidQuery();
    return new Date(ms + (end ? 86_400_000 : 0)).toISOString();
  }
  if (!INSTANT.test(raw)) throw invalidQuery();
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw invalidQuery();
  return new Date(ms + (end ? 1 : 0)).toISOString();
}

/** Every failure is one generic 400 that echoes nothing. */
export function parseMcpCallsQuery(raw: unknown): McpCallsQuery {
  const parsed = z
    .object({ limit: str, cursor: str, tool: str, keyId: str, outcome: str, clientName: str, from: str, to: str })
    .strict()
    .safeParse(raw ?? {});
  if (!parsed.success) throw invalidQuery();
  const q = parsed.data;
  let limit = MCP_CALLS_DEFAULT_LIMIT;
  if (q.limit !== undefined) {
    if (!/^\d{1,4}$/.test(q.limit)) throw invalidQuery();
    limit = Number(q.limit);
    if (limit < 1 || limit > MCP_CALLS_MAX_LIMIT) throw invalidQuery();
  }
  if (q.tool !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(q.tool)) throw invalidQuery();
  if (q.keyId !== undefined && !isUuid(q.keyId)) throw invalidQuery();
  if (q.outcome !== undefined && !(MCP_OUTCOMES as readonly string[]).includes(q.outcome)) throw invalidQuery();
  if (q.clientName !== undefined && q.clientName.length > MCP_CALL_CLIENT_MAX) throw invalidQuery();
  const from = parseBound(q.from, false);
  const to = parseBound(q.to, true);
  if (from && to && Date.parse(from) >= Date.parse(to)) throw invalidQuery();
  return {
    limit,
    cursor: q.cursor ? decodeCursor(q.cursor) : null,
    tool: q.tool ?? null,
    keyId: q.keyId ? q.keyId.toLowerCase() : null,
    outcome: (q.outcome as McpOutcome | undefined) ?? null,
    clientName: q.clientName ?? null,
    from,
    to,
  };
}

export { encodeCursor as encodeMcpCallCursor };

export interface McpCallWorkspaceDto {
  id: string;
  slug: string;
  name: string;
}

export interface McpCallDto {
  id: string;
  occurredAt: string;
  /** Present on every row of the Global list; Workspace lists omit it. */
  workspace?: McpCallWorkspaceDto;
  keyId: string;
  /** Name of the key when the call was made; survives revocation and deletion of the key. */
  keyName: string;
  clientName: string | null;
  clientVersion: string | null;
  tool: string;
  outcome: McpOutcome;
  durationMs: number;
  resultChars: number;
  truncated: boolean;
}

export interface McpCallListDto {
  scope: 'global' | 'workspace';
  workspaceId: string | null;
  items: McpCallDto[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface McpCallResourceDto {
  kind: UsageResourceKind;
  id: string;
  action: McpTouchAction;
  scope: 'global' | 'workspace';
  workspaceId: string | null;
  /** The resource no longer exists: only its id is shown. */
  deleted: boolean;
}

export interface McpCallDetailDto extends Omit<McpCallDto, 'workspace'> {
  workspace: McpCallWorkspaceDto;
  /** Allowlisted per-tool summary; never queries or content. */
  argsSummary: Record<string, unknown>;
  resources: McpCallResourceDto[];
}
