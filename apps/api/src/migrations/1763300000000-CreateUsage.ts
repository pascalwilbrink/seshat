import type { MigrationInterface, QueryRunner } from 'typeorm';

const SCOPE_CHECK = `("scope" = 'global' AND "workspace_id" IS NULL) OR ("scope" = 'workspace' AND "workspace_id" IS NOT NULL)`;
const SCOPE_KEY = `"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'global' ELSE "workspace_id"::text END) STORED NOT NULL`;

/**
 * Usage insights storage: resource access counters and MCP call history.
 *
 * Resource counters exist once per resource kind (`file_*`, `memory_*`) so that ownership is a real foreign key:
 * `FK_*_resource_scope (<kind>_id, scope_key) -> <parent>(id, scope_key)` ON DELETE CASCADE removes the counters with the
 * File or Memory and makes a counter in the wrong scope impossible. Global rows have a null `workspace_id` (Global is a
 * scope, not a Workspace); Workspace rows also cascade from `workspaces`, so Workspace-owned history disappears with it.
 *
 * - `*_usage_daily`: one row per resource, UTC day, channel and access kind. Pruned by retention.
 * - `*_usage_totals`: lifetime total, per-channel and per-kind totals and `last_accessed_at`. Never pruned, so all-time
 *   numbers survive the pruning of daily rows.
 * - `mcp_calls` + `mcp_call_resources`: append-only call history. `key_id` and `key_name` are snapshots without a foreign
 *   key (they survive revoking or deleting the key); touched resource ids have no foreign key either, so a deleted
 *   resource stays an id (a deleted marker) without any name. Both cascade from the Workspace.
 * - `mcp_list_daily`: `tools/list` counted per key and UTC day.
 * - `usage_batches`: idempotency ledger of applied batches (ids and times only), pruned after a short fixed window.
 */
export class CreateUsage1763300000000 implements MigrationInterface {
  name = 'CreateUsage1763300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [kind, parent] of [['file', 'files'], ['memory', 'memories']] as const) {
      const id = `${kind}_id`;
      await queryRunner.query(`CREATE TABLE "${kind}_usage_daily" (
        "scope" character varying(16) NOT NULL,
        "workspace_id" uuid,
        ${SCOPE_KEY},
        "${id}" uuid NOT NULL,
        "day" date NOT NULL,
        "channel" character varying(8) NOT NULL,
        "access_kind" character varying(16) NOT NULL,
        "count" bigint NOT NULL,
        CONSTRAINT "PK_${kind}_usage_daily" PRIMARY KEY ("${id}", "day", "channel", "access_kind"),
        CONSTRAINT "CK_${kind}_usage_daily_scope" CHECK (${SCOPE_CHECK}),
        CONSTRAINT "CK_${kind}_usage_daily_channel" CHECK ("channel" IN ('ui', 'api', 'mcp')),
        CONSTRAINT "CK_${kind}_usage_daily_access_kind" CHECK ("access_kind" IN ('read', 'retrieved')),
        CONSTRAINT "CK_${kind}_usage_daily_count" CHECK ("count" > 0),
        CONSTRAINT "FK_${kind}_usage_daily_workspace" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
        CONSTRAINT "FK_${kind}_usage_daily_resource_scope" FOREIGN KEY ("${id}", "scope_key") REFERENCES "${parent}"("id", "scope_key") ON DELETE CASCADE ON UPDATE RESTRICT
      )`);
      await queryRunner.query(`CREATE INDEX "IDX_${kind}_usage_daily_scope_day" ON "${kind}_usage_daily" ("scope_key", "day")`);
      await queryRunner.query(`CREATE INDEX "IDX_${kind}_usage_daily_day" ON "${kind}_usage_daily" ("day")`);
      await queryRunner.query(`CREATE INDEX "IDX_${kind}_usage_daily_workspace_id" ON "${kind}_usage_daily" ("workspace_id")`);

      await queryRunner.query(`CREATE TABLE "${kind}_usage_totals" (
        "scope" character varying(16) NOT NULL,
        "workspace_id" uuid,
        ${SCOPE_KEY},
        "${id}" uuid NOT NULL,
        "total_count" bigint NOT NULL,
        "read_count" bigint NOT NULL,
        "retrieved_count" bigint NOT NULL,
        "ui_count" bigint NOT NULL,
        "api_count" bigint NOT NULL,
        "mcp_count" bigint NOT NULL,
        "last_accessed_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_${kind}_usage_totals" PRIMARY KEY ("${id}"),
        CONSTRAINT "CK_${kind}_usage_totals_scope" CHECK (${SCOPE_CHECK}),
        CONSTRAINT "CK_${kind}_usage_totals_counts" CHECK (
          "read_count" >= 0 AND "retrieved_count" >= 0 AND "ui_count" >= 0 AND "api_count" >= 0 AND "mcp_count" >= 0
          AND "total_count" = "read_count" + "retrieved_count"
          AND "total_count" = "ui_count" + "api_count" + "mcp_count"
        ),
        CONSTRAINT "FK_${kind}_usage_totals_workspace" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
        CONSTRAINT "FK_${kind}_usage_totals_resource_scope" FOREIGN KEY ("${id}", "scope_key") REFERENCES "${parent}"("id", "scope_key") ON DELETE CASCADE ON UPDATE RESTRICT
      )`);
      await queryRunner.query(`CREATE INDEX "IDX_${kind}_usage_totals_scope_accessed" ON "${kind}_usage_totals" ("scope_key", "last_accessed_at" DESC)`);
      await queryRunner.query(`CREATE INDEX "IDX_${kind}_usage_totals_workspace_id" ON "${kind}_usage_totals" ("workspace_id")`);
    }

    await queryRunner.query(`CREATE TABLE "mcp_calls" (
      "id" uuid NOT NULL,
      "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL,
      "workspace_id" uuid NOT NULL,
      "key_id" uuid NOT NULL,
      "key_name" character varying(100) NOT NULL,
      "client_name" character varying(200),
      "client_version" character varying(100),
      "tool" character varying(128) NOT NULL,
      "outcome" character varying(20) NOT NULL,
      "duration_ms" integer NOT NULL,
      "result_chars" integer NOT NULL,
      "truncated" boolean NOT NULL,
      "args_summary" jsonb NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT "PK_mcp_calls" PRIMARY KEY ("id"),
      CONSTRAINT "FK_mcp_calls_workspace" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
      CONSTRAINT "CK_mcp_calls_key_name_length" CHECK (char_length("key_name") BETWEEN 1 AND 100),
      CONSTRAINT "CK_mcp_calls_client_name_length" CHECK ("client_name" IS NULL OR char_length("client_name") BETWEEN 1 AND 200),
      CONSTRAINT "CK_mcp_calls_client_version_length" CHECK ("client_version" IS NULL OR (char_length("client_version") BETWEEN 1 AND 100 AND "client_name" IS NOT NULL)),
      CONSTRAINT "CK_mcp_calls_tool_length" CHECK (char_length("tool") BETWEEN 1 AND 128),
      CONSTRAINT "CK_mcp_calls_outcome" CHECK ("outcome" IN ('ok', 'validation_error', 'forbidden', 'not_found', 'unknown_tool', 'internal_error')),
      CONSTRAINT "CK_mcp_calls_duration_ms" CHECK ("duration_ms" >= 0),
      CONSTRAINT "CK_mcp_calls_result_chars" CHECK ("result_chars" >= 0),
      CONSTRAINT "CK_mcp_calls_args_summary" CHECK (jsonb_typeof("args_summary") = 'object' AND octet_length("args_summary"::text) <= 4096)
    )`);
    await queryRunner.query(`CREATE INDEX "IDX_mcp_calls_workspace_time" ON "mcp_calls" ("workspace_id", "occurred_at" DESC, "id" DESC)`);
    await queryRunner.query(`CREATE INDEX "IDX_mcp_calls_time" ON "mcp_calls" ("occurred_at" DESC, "id" DESC)`);
    await queryRunner.query(`CREATE INDEX "IDX_mcp_calls_workspace_tool_time" ON "mcp_calls" ("workspace_id", "tool", "occurred_at" DESC, "id" DESC)`);
    await queryRunner.query(`CREATE INDEX "IDX_mcp_calls_workspace_key_time" ON "mcp_calls" ("workspace_id", "key_id", "occurred_at" DESC, "id" DESC)`);
    await queryRunner.query(`CREATE INDEX "IDX_mcp_calls_workspace_outcome_time" ON "mcp_calls" ("workspace_id", "outcome", "occurred_at" DESC, "id" DESC)`);
    await queryRunner.query(`CREATE INDEX "IDX_mcp_calls_workspace_client_time" ON "mcp_calls" ("workspace_id", "client_name", "occurred_at" DESC, "id" DESC) WHERE "client_name" IS NOT NULL`);

    await queryRunner.query(`CREATE TABLE "mcp_call_resources" (
      "call_id" uuid NOT NULL,
      "resource_kind" character varying(8) NOT NULL,
      "resource_id" uuid NOT NULL,
      "scope_key" text NOT NULL,
      "action" character varying(16) NOT NULL,
      CONSTRAINT "PK_mcp_call_resources" PRIMARY KEY ("call_id", "resource_kind", "resource_id", "action"),
      CONSTRAINT "FK_mcp_call_resources_call" FOREIGN KEY ("call_id") REFERENCES "mcp_calls"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
      CONSTRAINT "CK_mcp_call_resources_kind" CHECK ("resource_kind" IN ('file', 'memory')),
      CONSTRAINT "CK_mcp_call_resources_action" CHECK ("action" IN ('read', 'retrieved', 'created', 'updated', 'deleted')),
      CONSTRAINT "CK_mcp_call_resources_scope_key" CHECK ("scope_key" = 'global' OR "scope_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    )`);
    await queryRunner.query(`CREATE INDEX "IDX_mcp_call_resources_resource" ON "mcp_call_resources" ("resource_kind", "resource_id", "call_id")`);

    await queryRunner.query(`CREATE TABLE "mcp_list_daily" (
      "key_id" uuid NOT NULL,
      "day" date NOT NULL,
      "workspace_id" uuid NOT NULL,
      "key_name" character varying(100) NOT NULL,
      "count" bigint NOT NULL,
      CONSTRAINT "PK_mcp_list_daily" PRIMARY KEY ("key_id", "day"),
      CONSTRAINT "FK_mcp_list_daily_workspace" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
      CONSTRAINT "CK_mcp_list_daily_key_name_length" CHECK (char_length("key_name") BETWEEN 1 AND 100),
      CONSTRAINT "CK_mcp_list_daily_count" CHECK ("count" > 0)
    )`);
    await queryRunner.query(`CREATE INDEX "IDX_mcp_list_daily_workspace_day" ON "mcp_list_daily" ("workspace_id", "day")`);
    await queryRunner.query(`CREATE INDEX "IDX_mcp_list_daily_day" ON "mcp_list_daily" ("day")`);

    await queryRunner.query(`CREATE TABLE "usage_batches" (
      "batch_id" uuid NOT NULL,
      "applied_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_usage_batches" PRIMARY KEY ("batch_id")
    )`);
    await queryRunner.query(`CREATE INDEX "IDX_usage_batches_applied_at" ON "usage_batches" ("applied_at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'usage_batches', 'mcp_list_daily', 'mcp_call_resources', 'mcp_calls',
      'memory_usage_totals', 'memory_usage_daily', 'file_usage_totals', 'file_usage_daily',
    ]) {
      await queryRunner.query(`DROP TABLE "${table}"`);
    }
  }
}
