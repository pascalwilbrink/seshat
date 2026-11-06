import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Entities of the usage tables (migration `CreateUsage`). The service writes them with set-based SQL (see
 * usage-persistence.service.ts); the entities document the schema and keep TypeORM's metadata complete.
 * `scope_key` is database-generated; the composite FK to the parent resource and the Workspace cascade live in the migration.
 */
const bigintAsNumber = { to: (v: number) => v, from: (v: string | number) => Number(v) };
const scopeKey = {
  name: 'scope_key',
  type: 'text',
  generatedType: 'STORED',
  asExpression: `CASE WHEN "workspace_id" IS NULL THEN 'global' ELSE "workspace_id"::text END`,
  insert: false,
  update: false,
} as const;

abstract class UsageScopeColumns {
  @Column({ name: 'scope', type: 'varchar', length: 16 })
  scope!: 'global' | 'workspace';

  @Column({ name: 'workspace_id', type: 'uuid', nullable: true })
  workspaceId!: string | null;

  @Column(scopeKey)
  scopeKey!: string;
}

@Entity({ name: 'file_usage_daily' })
@Index('IDX_file_usage_daily_scope_day', ['scopeKey', 'day'])
@Index('IDX_file_usage_daily_day', ['day'])
export class FileUsageDaily extends UsageScopeColumns {
  @PrimaryColumn({ name: 'file_id', type: 'uuid' }) fileId!: string;
  @PrimaryColumn({ name: 'day', type: 'date' }) day!: string;
  @PrimaryColumn({ name: 'channel', type: 'varchar', length: 8 }) channel!: string;
  @PrimaryColumn({ name: 'access_kind', type: 'varchar', length: 16 }) accessKind!: string;
  @Column({ name: 'count', type: 'bigint', transformer: bigintAsNumber }) count!: number;
}

@Entity({ name: 'memory_usage_daily' })
@Index('IDX_memory_usage_daily_scope_day', ['scopeKey', 'day'])
@Index('IDX_memory_usage_daily_day', ['day'])
export class MemoryUsageDaily extends UsageScopeColumns {
  @PrimaryColumn({ name: 'memory_id', type: 'uuid' }) memoryId!: string;
  @PrimaryColumn({ name: 'day', type: 'date' }) day!: string;
  @PrimaryColumn({ name: 'channel', type: 'varchar', length: 8 }) channel!: string;
  @PrimaryColumn({ name: 'access_kind', type: 'varchar', length: 16 }) accessKind!: string;
  @Column({ name: 'count', type: 'bigint', transformer: bigintAsNumber }) count!: number;
}

abstract class UsageTotalsColumns extends UsageScopeColumns {
  @Column({ name: 'total_count', type: 'bigint', transformer: bigintAsNumber }) totalCount!: number;
  @Column({ name: 'read_count', type: 'bigint', transformer: bigintAsNumber }) readCount!: number;
  @Column({ name: 'retrieved_count', type: 'bigint', transformer: bigintAsNumber }) retrievedCount!: number;
  @Column({ name: 'ui_count', type: 'bigint', transformer: bigintAsNumber }) uiCount!: number;
  @Column({ name: 'api_count', type: 'bigint', transformer: bigintAsNumber }) apiCount!: number;
  @Column({ name: 'mcp_count', type: 'bigint', transformer: bigintAsNumber }) mcpCount!: number;
  @Column({ name: 'last_accessed_at', type: 'timestamp with time zone' }) lastAccessedAt!: Date;
}

@Entity({ name: 'file_usage_totals' })
@Index('IDX_file_usage_totals_scope_accessed', ['scopeKey', 'lastAccessedAt'])
export class FileUsageTotals extends UsageTotalsColumns {
  @PrimaryColumn({ name: 'file_id', type: 'uuid' }) fileId!: string;
}

@Entity({ name: 'memory_usage_totals' })
@Index('IDX_memory_usage_totals_scope_accessed', ['scopeKey', 'lastAccessedAt'])
export class MemoryUsageTotals extends UsageTotalsColumns {
  @PrimaryColumn({ name: 'memory_id', type: 'uuid' }) memoryId!: string;
}

/** Append-only MCP call history. `keyId` / `keyName` are snapshots (no FK); never holds queries, content or results. */
@Entity({ name: 'mcp_calls' })
@Check('CK_mcp_calls_outcome', `"outcome" IN ('ok', 'validation_error', 'forbidden', 'not_found', 'unknown_tool', 'internal_error')`)
@Index('IDX_mcp_calls_workspace_time', ['workspaceId', 'occurredAt', 'id'])
export class McpCall {
  @PrimaryColumn({ name: 'id', type: 'uuid' }) id!: string;
  @Column({ name: 'occurred_at', type: 'timestamp with time zone' }) occurredAt!: Date;
  @Column({ name: 'workspace_id', type: 'uuid' }) workspaceId!: string;
  @Column({ name: 'key_id', type: 'uuid' }) keyId!: string;
  @Column({ name: 'key_name', type: 'varchar', length: 100 }) keyName!: string;
  @Column({ name: 'client_name', type: 'varchar', length: 200, nullable: true }) clientName!: string | null;
  @Column({ name: 'client_version', type: 'varchar', length: 100, nullable: true }) clientVersion!: string | null;
  @Column({ name: 'tool', type: 'varchar', length: 128 }) tool!: string;
  @Column({ name: 'outcome', type: 'varchar', length: 20 }) outcome!: string;
  @Column({ name: 'duration_ms', type: 'integer' }) durationMs!: number;
  @Column({ name: 'result_chars', type: 'integer' }) resultChars!: number;
  @Column({ name: 'truncated', type: 'boolean' }) truncated!: boolean;
  @Column({ name: 'args_summary', type: 'jsonb', default: () => `'{}'::jsonb` }) argsSummary!: Record<string, unknown>;
}

/** Resource a call touched. No FK to files/memories: the id outlives the resource (shown as deleted, never with a name). */
@Entity({ name: 'mcp_call_resources' })
@Index('IDX_mcp_call_resources_resource', ['resourceKind', 'resourceId', 'callId'])
export class McpCallResource {
  @PrimaryColumn({ name: 'call_id', type: 'uuid' }) callId!: string;
  @PrimaryColumn({ name: 'resource_kind', type: 'varchar', length: 8 }) resourceKind!: string;
  @PrimaryColumn({ name: 'resource_id', type: 'uuid' }) resourceId!: string;
  @PrimaryColumn({ name: 'action', type: 'varchar', length: 16 }) action!: string;
  @Column({ name: 'scope_key', type: 'text' }) scopeKey!: string;
}

/** `tools/list` calls per key and UTC day. */
@Entity({ name: 'mcp_list_daily' })
@Index('IDX_mcp_list_daily_workspace_day', ['workspaceId', 'day'])
export class McpListDaily {
  @PrimaryColumn({ name: 'key_id', type: 'uuid' }) keyId!: string;
  @PrimaryColumn({ name: 'day', type: 'date' }) day!: string;
  @Column({ name: 'workspace_id', type: 'uuid' }) workspaceId!: string;
  @Column({ name: 'key_name', type: 'varchar', length: 100 }) keyName!: string;
  @Column({ name: 'count', type: 'bigint', transformer: bigintAsNumber }) count!: number;
}

/** Ledger of applied batches (id and time only): makes a replayed batch a no-op. */
@Entity({ name: 'usage_batches' })
export class UsageBatchRecord {
  @PrimaryColumn({ name: 'batch_id', type: 'uuid' }) batchId!: string;
  @Column({ name: 'applied_at', type: 'timestamp with time zone', default: () => 'now()' }) appliedAt!: Date;
}
