import type { ScopeRef } from '../scopes/scope-ref.js';
import type { AccessKind, McpOutcome, McpTouchAction, UsageChannel, UsageResourceKind } from './usage.constants.js';

/**
 * Safe, content-free input of one persisted batch. Nothing here may hold queries, file or memory content, titles,
 * metadata or free-text tags; `argsSummary` is an already allowlisted summary (see UsagePersistenceService validation).
 */
export interface ResourceAccessIncrement {
  resourceKind: UsageResourceKind;
  resourceId: string;
  /** Actual scope of the resource (Global is `{ kind: 'global' }`, never a Workspace). */
  scope: ScopeRef;
  /** UTC day `YYYY-MM-DD` the access belongs to. */
  day: string;
  channel: UsageChannel;
  accessKind: AccessKind;
  /** Number of accesses (positive integer). */
  count: number;
  /** Latest access time of this increment; `last_accessed_at` only ever moves forward. */
  lastAccessedAt: Date;
}

export interface TouchedResource {
  resourceKind: UsageResourceKind;
  resourceId: string;
  scope: ScopeRef;
  action: McpTouchAction;
}

export interface McpCallRecord {
  /** Stable event id (UUID): replaying the same call never inserts a second row. */
  id: string;
  occurredAt: Date;
  workspaceId: string;
  keyId: string;
  /** Key name at authentication time (a snapshot; survives revoking or deleting the key). */
  keyName: string;
  clientName?: string | null;
  clientVersion?: string | null;
  tool: string;
  outcome: McpOutcome;
  durationMs: number;
  resultChars: number;
  truncated: boolean;
  /** Allowlisted per-tool summary: scalars and arrays of scalars only. */
  argsSummary: Record<string, unknown>;
  touched: TouchedResource[];
}

export interface ListCountIncrement {
  workspaceId: string;
  keyId: string;
  keyName: string;
  day: string;
  count: number;
}

export interface UsageBatchInput {
  /** Stable batch id (UUID). A retry after an uncertain commit must reuse it. */
  batchId: string;
  accesses?: ResourceAccessIncrement[];
  mcpCalls?: McpCallRecord[];
  listCounts?: ListCountIncrement[];
}

/** Counts only: what a batch did. `skipped*` are items whose resource or Workspace no longer exists. */
export interface UsageBatchResult {
  status: 'applied' | 'duplicate';
  accessRows: number;
  skippedAccessResources: number;
  mcpCalls: number;
  skippedMcpCalls: number;
  listRows: number;
  skippedListRows: number;
}
