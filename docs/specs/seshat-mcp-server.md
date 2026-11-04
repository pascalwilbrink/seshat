## Goal

Give AI agents, starting with Gilde's, direct access to Seshat through MCP: an agent connects with a Workspace API key and gets exactly the file, memory and search tools that key's permissions allow, including writes, without needing the UI. Every tool is a thin layer over the existing services, so authorization, isolation and validation behave exactly as in the REST API.

## Context

- Depends on `seshat-api-keys-authorization` (keys, permission catalog, `AuthorizationService`), `seshat-files-collections-tags`, `seshat-ingestion-pipeline`, `seshat-memories` and `seshat-search-retrieval` (search, context and related-memories services).
- Decision: MCP tools may write, always gated by the calling key's permissions.
- Gilde attaches MCP servers per project over Streamable HTTP with a bearer token, lists tools without calling them, keeps an allowlist, and treats tools that are not annotated as read-only as writing. Unattended Gilde agents get only read-only tools.
- `AGENTS.md` lists file tools (`upload_file`, `list_files`, `get_file`, `delete_file`, `search_files`, `get_file_chunks`, `search_knowledge`, `get_context`) and memory tools (`remember`, `recall`, `search_memories`, `update_memory`, `forget`, `list_memories`, `get_related_memories`) as product direction. `search_files` and `search_memories` would duplicate `search_knowledge` and `recall` with a type filter, so they are left out; `list_collections` and `list_tags` are added so agents can discover filter values.

## Behaviour

Transport and auth. The API serves MCP at `/mcp` with the official TypeScript SDK (`@modelcontextprotocol/sdk`) and the Streamable HTTP transport in stateless mode: every request authenticates on its own. Only API keys are accepted (`Authorization: Bearer <key>`); missing, unknown, revoked or expired keys get 401 with a `WWW-Authenticate: Bearer` header and no further detail; admin session cookies are not accepted on `/mcp`. The server reports name `seshat` and its version. The client's name and version from the initialize request are passed to services as provenance.

Tool set per key. `tools/list` returns only the tools whose permissions the key holds; every call is still checked through `AuthorizationService`, so calling an unlisted tool fails the same way. Every tool has a zod input schema, a description written for agents (what it does, which scope, which permission), and annotations: read tools `readOnlyHint: true`; `delete_file` and `forget` `destructiveHint: true`; other writing tools `readOnlyHint: false`.

Scope. Tools act in the key's Workspace by default. Read tools accept `scope: 'global'` (requires the Global grant and the matching read permission); search tools accept `includeGlobal: true`. Writing tools never accept Global.

Tools:
- `list_files` (`files:read`): filters by Collection, tag, ingestion status and name; cursor pagination.
- `get_file` (`files:read`): metadata including ingestion status, error, chunk count and tags; never the original bytes.
- `get_file_chunks` (`files:read`): ordered chunks with location; pagination.
- `upload_file` (`files:write`): file name plus either UTF-8 `text` or `base64` content, optional Collection id and tags; size capped by `MCP_MAX_UPLOAD_BYTES` (default 10 MB); goes through the same upload service, so ingestion starts the same way; returns the file with status `pending`.
- `delete_file` (`files:delete`).
- `list_collections` (`collections:read`) and `list_tags` (`files:read` or `memories:read`).
- `search_knowledge` (`search` plus the read permissions for the requested types): the Search request shape; returns results with sources.
- `get_context` (same permissions): the context block with citations and the source list.
- `remember` (`memories:write`): type, content and optional title, tags, confidence, source, metadata and `supersedes`; returns the memory with `deduplicated` and the similar-memories hint.
- `recall` (`search` plus `memories:read`): search restricted to memories, with memory type, tag and superseded filters.
- `list_memories` (`memories:read`): the list filters and pagination.
- `update_memory` (`memories:write`) and `forget` (`memories:delete`).
- `get_related_memories` (`search` plus `memories:read`).

Results. Each tool returns structured content plus a text rendering. Retrieved content (chunks, memories, context) is wrapped in clearly delimited blocks marked as retrieved data, never instructions, and each result is capped by `MCP_MAX_RESULT_CHARS` (default 20000) with a truncation note. Errors are MCP tool errors (`isError: true`) with short safe messages: validation problems name the field; a missing permission names the permission; anything outside the key's access is reported as not found, identical to an id that does not exist; internal errors never expose stack traces, SQL, paths or secrets.

UI. A Workspace "MCP" page shows the endpoint URL, a copyable configuration example for Gilde and for a Claude Code `.mcp.json` with a placeholder instead of a real key, and, for a selected key of the Workspace, the exact tools that key would get with their read-only or writing marking. Navigation shows MCP on Workspace pages.

Tests. An end-to-end suite runs the SDK client against the server over HTTP and covers: initialize and tool listing per permission set (read-only key, read-write key, key with Global grant); every tool's happy path; calls without the permission rejected even when the tool is called directly; ids from another Workspace answered as not found, identical to random ids; writes to Global refused; upload size cap; input validation errors; result size caps; 401 for missing, revoked and expired keys and for a session cookie; and annotations matching the read-only and destructive rules.

## Acceptance criteria

- AC-1: `/mcp` serves MCP over Streamable HTTP in stateless mode with the official TypeScript SDK and accepts only valid API keys; other requests get 401 with `WWW-Authenticate: Bearer`.
- AC-2: `tools/list` returns exactly the tools the key's permissions allow, and every call is authorized again through `AuthorizationService`.
- AC-3: The file tools (`list_files`, `get_file`, `get_file_chunks`, `upload_file`, `delete_file`), discovery tools (`list_collections`, `list_tags`), search tools (`search_knowledge`, `get_context`) and memory tools (`remember`, `recall`, `list_memories`, `update_memory`, `forget`, `get_related_memories`) work through the existing services with zod-validated input.
- AC-4: Read tools are annotated `readOnlyHint: true`, `delete_file` and `forget` `destructiveHint: true`, and all other writing tools `readOnlyHint: false`.
- AC-5: Tools act in the key's Workspace; read and search tools reach Global only with the Global grant, and writing tools never accept Global.
- AC-6: Ids outside the key's access produce the same not-found tool error as random ids, and errors never contain stack traces, SQL, paths or secrets.
- AC-7: Retrieved content is returned in delimited blocks marked as data with per-result size caps, and uploads are capped by `MCP_MAX_UPLOAD_BYTES`.
- AC-8: `remember` and `upload_file` record the key and the MCP client name and version as provenance.
- AC-9: The Workspace MCP page shows the endpoint, copyable Gilde and Claude Code configuration with a placeholder key, and the tools a selected key would get.
- AC-10: An end-to-end SDK client suite covers listing per permission set, every tool, permission and isolation failures, Global write refusal, caps and authentication, and the README and `AGENTS.md` section 10 document connecting Gilde to Seshat and the actual tool list.

## Out of scope

- OAuth for MCP clients, stdio transport and stateful sessions.
- MCP resources and prompts; only tools.
- `search_files` and `search_memories` as separate tools.

## Open questions

None.
