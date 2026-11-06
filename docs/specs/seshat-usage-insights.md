## Goal

Show the admin how Seshat's knowledge is actually used: how often each File and Memory is read or retrieved, by which channel, which MCP tools agents call with which keys and with what outcome, and a dashboard with charts of that activity per scope. This tells the admin which knowledge earns its place, which is never used, and whether agents (for example Gilde's) work as intended.

## Context

- Reads of Files and Memories happen through REST (`FilesService`, `MemoriesService`), retrieval (`SearchService.search` and `context`, `RelatedMemoriesService`) and MCP (`apps/api/src/mcp/`, 15 tools, every call goes through the registry and `AuthorizationService`). Nothing records usage today.
- The Overview pages (`/global/overview`, `/w/<slug>/overview`) show only a Workspace count `StatCard`. There is no chart library; `docs/ui.md` is binding for UI work and must be extended in the same change.
- `AGENTS.md`: never log or store file contents, memory contents, queries, credentials or retrieved context; Workspace isolation and Global grants are unchanged by this feature; scoped data is deleted with its Workspace.
- Single admin. Keys authenticate agents; there are no end users to attribute reads to beyond the admin and API keys.

## Behaviour

### What counts as an access

An access is recorded per resource, at most once per request, with a channel (`ui` = admin session, `api` = API key over REST, `mcp` = API key over MCP) and a kind:
- `read`: a File's metadata, download or chunk listing was requested by id (`GET` file, `GET` download, `GET` chunks, MCP `get_file`, `get_file_chunks`), or a Memory was requested by id (`GET` memory, the related-memories seed).
- `retrieved`: a File (through one or more of its chunks) or a Memory appeared in a search, context, recall or related-memories result that was returned to the caller. Only results actually returned count, not candidates.

List endpoints (`GET` files, `GET` memories and the MCP list tools), writes, deletes and failed or denied requests do not count. Several chunks of one File in one result count once for that File. Reads made by the system itself (ingestion, embedding, cleanup) never count.

### Recording

Accesses are aggregated into daily counters per resource (scope, resource kind `file`/`memory`, resource id, UTC day, channel, access kind, count) plus `last_accessed_at` per resource. Recording must never slow down or fail a request: an in-process buffer collects increments and flushes them in batches (for example every 5 seconds and on graceful shutdown) with idempotent upserts; a failed flush is logged by count only and retried once, after which those increments may be dropped (usage data is best effort, documented as such). Counter rows are deleted with their File or Memory and with their Workspace. Retention: daily rows older than `USAGE_RETENTION_DAYS` (default 365) are pruned by a daily pg-boss job; totals for older periods are kept in a per-resource lifetime total so "all time" stays correct after pruning.

### MCP call history

Every `tools/call` that reaches the MCP server with a valid key is recorded in an append-only `mcp_calls` table: id, timestamp, Workspace id, key id and the key's name at that time (kept when the key is later revoked or deleted), MCP client name and version when known, tool name, outcome (`ok`, `validation_error`, `forbidden`, `not_found`, `unknown_tool`, `internal_error`), duration in milliseconds, result size in characters and whether it was truncated, and the ids of Files and Memories the call touched (read, retrieved, created, updated or deleted). Arguments are stored only as an allowlisted, per-tool summary of non-content fields (for example `limit`, `scope`, `includeGlobal`, `types`, memory `type`, ids, file name and size for uploads); query text, file or memory content, titles, metadata, tags' free text and result content are never stored. Unauthenticated requests (401) are not recorded. `tools/list` calls are counted per day per key (no per-call rows). Retention: `MCP_CALL_RETENTION_DAYS` (default 90), pruned by the same daily job. Recording happens after the response is produced and never changes the tool's result or error.

### API

All routes are admin only (new admin actions in `ACTION_CATALOG`, checked with `AuthorizationService.assertCan`; API keys get 403), scoped like the rest of the API, and give the usual identical 404 for foreign or unknown ids:
- `GET .../files/:fileId/usage` and `GET .../memories/:memoryId/usage`: lifetime total, last accessed, totals per channel and kind, and a daily series for `days` (7, 30 or 90; default 30).
- `GET .../usage/top?resource=file|memory&days=&limit=`: most accessed resources in the scope with their counts, and `GET .../usage/unused?resource=&days=`: resources with no access in that window (cursor paginated).
- `GET /api/workspaces/:workspaceId/mcp-calls`: newest first, cursor pagination, filters tool, key id, outcome, client name and date range; `GET .../mcp-calls/:callId` for one call with its argument summary and touched resources (resources that no longer exist are shown as deleted, without names). `GET /api/global/mcp-calls` lists calls across all Workspaces with the Workspace on each row.
- `GET /api/global/usage/overview` and `GET /api/workspaces/:workspaceId/usage/overview?days=`: the dashboard aggregates below in one response.
Files and Memories list responses gain `accessCount30d` and `lastAccessedAt` for the admin (not for keys).

### Dashboard

Overview pages get a stat row and charts for the selected window (7, 30 or 90 days, default 30):
- Stat cards: Files (with indexed and failed counts), Memories (active and superseded), MCP calls in the window, error rate, Files and Memories never accessed in the window.
- Charts: accesses per day split by channel; MCP calls per day split by outcome; top 10 tools by calls; top 10 most accessed Files and Memories (each linking to its detail); in Global additionally MCP calls per Workspace.
Every chart has a title, an accessible text summary and a data table alternative, uses the design tokens (no new colours outside the guide), and shows empty and loading states. Charts are built with one chart library compatible with the existing Tailwind/shadcn stack (shadcn charts on Recharts is the expected choice); `docs/ui.md` gains a Charts section (when to use which chart, colours per series, accessibility rules) and the library is the only chart dependency.

### Detail views

- File detail panel and Memory detail: lifetime accesses, last accessed, a small 30-day sparkline, and counts per channel and kind.
- Files and Memories tables: an "Accesses (30 d)" column and "Last accessed".
- Workspace MCP page: a "Call history" section (or `/w/<slug>/mcp/history`) with a `DataTable` of time, tool, key, client, outcome badge, duration and result size; filters; a detail sheet with the argument summary and links to touched Files and Memories. Global gets the cross-Workspace history under Settings or a Global MCP activity page (MCP is Workspace-only in navigation today; the spec leaves the exact placement to the guide but it must be reachable from Global Overview).

## Acceptance criteria

- AC-1: File and Memory accesses are recorded per request as `read` or `retrieved` with channel `ui`, `api` or `mcp`, exactly per the counting rules; lists, writes, failed or denied requests and system reads never count, and a File counts once per request however many of its chunks are returned.
- AC-2: Recording is buffered and batched, never adds a database write to the request path, never fails or changes a request, flushes on graceful shutdown, and is documented as best effort.
- AC-3: Daily counters, lifetime totals and `last_accessed_at` are stored per resource, deleted with the resource and its Workspace, and daily rows older than `USAGE_RETENTION_DAYS` are pruned by a daily pg-boss job without changing lifetime totals.
- AC-4: Every authenticated MCP `tools/call` is recorded with time, Workspace, key id and key-name snapshot, client, tool, outcome, duration, result size, truncation and touched resource ids; `tools/list` is counted per key per day; 401s are not recorded; recording never alters the tool result.
- AC-5: MCP call rows store only an allowlisted per-tool argument summary; tests plant sentinels in queries, file content, memory content, titles and metadata and prove none appear in `mcp_calls`, usage tables, logs or usage API responses.
- AC-6: MCP call rows are pruned after `MCP_CALL_RETENTION_DAYS`, deleted with their Workspace, and keep the key-name snapshot after the key is revoked or deleted.
- AC-7: The usage, top, unused, MCP call list and detail, and overview routes exist for Global and Workspaces as specified, are admin only through `ACTION_CATALOG` and `AuthorizationService` (keys get 403), give identical 404s for foreign and unknown ids, and appear in route-coverage and sensitive-data tests.
- AC-8: Files and Memories list responses include `accessCount30d` and `lastAccessedAt` for the admin only.
- AC-9: Global and Workspace Overview show the stat cards and the charts for 7, 30 or 90 days, with titles, text summaries, table alternatives, design tokens, and empty, loading and error states; Global adds MCP calls per Workspace.
- AC-10: File and Memory details show lifetime accesses, last accessed, a 30-day sparkline and per-channel and per-kind counts; their tables show "Accesses (30 d)" and "Last accessed".
- AC-11: The Workspace MCP page shows a filterable, paginated call history with a detail sheet linking touched resources (deleted ones shown as deleted), and a cross-Workspace history is reachable from the Global Overview.
- AC-12: One chart library is added, `docs/ui.md` gains a Charts section, and the README, `apps/api/.env.example` (`USAGE_RETENTION_DAYS`, `MCP_CALL_RETENTION_DAYS`) and `AGENTS.md` section 10 document usage recording, its privacy rules and retention.

## Out of scope

- Per-user analytics (there is one admin), exporting usage data, alerts and real-time streaming.
- Recording argument content, queries or results of MCP calls, or REST request logging beyond the access counters.
- Usage-based ranking in search or automatic cleanup of unused knowledge.

## Open questions

None.
