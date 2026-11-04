## Goal

Give agents and the admin a place for persistent knowledge records that are not documents: facts, decisions, preferences, experiences, procedures and context, each with provenance, tags and an embedding, and with deliberate lifecycle rules for creating, updating, superseding and forgetting, so memory stays trustworthy instead of piling up duplicates.

## Context

- Depends on `seshat-scopes-workspaces-admin`, `seshat-api-keys-authorization` (permissions `memories:read`, `memories:write`, `memories:delete`, `global:read`; action catalog), `seshat-files-collections-tags` (scoped `tags` table shared by Files and Memories) and `seshat-ingestion-pipeline` (`EmbeddingService`, pg-boss, vector column conventions, dimension check).
- `AGENTS.md`: memory types `fact`, `decision`, `preference`, `experience`, `procedure`, `context`; Memories belong to Global or one Workspace; keep provenance (source, creating agent or client), consider confidence, timestamps and metadata; never store conversations automatically; Memories are not in Collections; no graph database for relationships without a concrete requirement; memory content is untrusted and never logged.

## Behaviour

Model. A scoped `memories` table: id, type (one of the six), content (1–10000 chars), optional title (up to 200 chars), optional metadata (JSON object up to 8 KB), optional confidence (0 to 1), optional source (free text up to 500 chars, for example a URL or "conversation"), status (`active` or `superseded`), optional `superseded_by` id, provenance set by the server from the principal and never by the client (`created_by_kind` admin or API key, key id and key name at the time, MCP client name and version when the MCP layer passes them), normalized content hash, embedding (`vector(1536)`, nullable), embedding model, `embedding_status` (`pending`, `ready`, `failed`), created and updated timestamps. A `memory_tags` join uses the shared scoped `tags` table; tags must be in the memory's scope.

Create (`memories:write`). Validates input, then:
- Exact duplicate: when an active memory in the same scope with the same type and the same normalized content hash exists, nothing is created and the existing memory is returned with `deduplicated: true` (tags from the request are added to it).
- Supersede: an optional `supersedes` id (same scope, active) marks that memory `superseded` with `superseded_by` set to the new one, in the same transaction.
- Embedding: the content (with title, when present) is embedded inline with a short timeout. When the provider fails, the memory is still saved with `embedding_status: pending` and a pg-boss job embeds it later with retries; after the last failure the status is `failed` and the admin can retry.
- Similar memories: the response includes up to three active memories in the same scope with cosine similarity of at least `MEMORY_SIMILARITY_HINT` (default 0.9), with id, type and a short preview, so a caller can decide to supersede or update. Nothing is merged automatically.

Read (`memories:read`). Get one memory; list with cursor pagination and filters by type, tag, status (default `active`), created or updated range and text substring, newest first. Superseded memories link to their successor.

Update (`memories:write`). Title, content, type, metadata, confidence, source and tags can change in place; a content or title change re-embeds the memory (same failure handling as create). Updating a superseded memory is refused with 409, pointing at its successor.

Forget (`memories:delete`). Hard delete. A memory that superseded another stays independent; memories that pointed at the deleted one through `superseded_by` keep their status and lose the link.

Isolation and Global. Every operation is constrained by the resolved `ScopeRef`; ids from another scope behave like missing ids (404); Global memories are readable by keys only with the Global grant and never writable by keys. New actions are added to the action catalog. Workspace deletion removes the Workspace's memories and their tag links.

UI. A Memories page for Global and each Workspace: a list with type badge, title or content preview, tags, status, provenance (who created it and from which client) and updated time; filters by type, tag, status and text; a create and edit form with type, title, content, tags, confidence and source; the similar-memories hint after create with actions "Supersede" and "Keep both"; a superseded memory shows a link to its successor; forget asks for confirmation; embedding status is visible with retry for failed ones. Navigation shows Memories. Loading, empty, success and failure states are covered.

Logging. Memory content, titles, metadata and embeddings are never logged; logs use ids, types and statuses.

## Acceptance criteria

- AC-1: A scoped `memories` table holds the six types with content, optional title, metadata, confidence and source, status and supersession link, server-set provenance, content hash, embedding with model and status, and timestamps; tags come from the shared scoped `tags` table.
- AC-2: Creating a memory with the same type and normalized content as an active memory in the same scope returns the existing memory with `deduplicated: true` instead of creating another.
- AC-3: Creating with `supersedes` marks the old memory superseded with a link to the new one in the same transaction, and superseded memories are excluded from lists by default and cannot be updated (409).
- AC-4: Create and content updates embed through `EmbeddingService`; on provider failure the memory is saved with `embedding_status: pending` and embedded later by a retried pg-boss job, ending in `ready` or `failed`.
- AC-5: The create response lists up to three similar active memories in the same scope above the configured similarity, and nothing is merged automatically.
- AC-6: Provenance (admin or key id and name, MCP client name and version when given) is set by the server and cannot be set or changed by the client.
- AC-7: Get, list with filters and cursor pagination, update and forget work in Global and Workspaces, each gated by its permission through `AuthorizationService`, with other-scope ids behaving like missing ids and keys never writing Global.
- AC-8: Deleting a Workspace removes its memories and tag links, and forgetting a memory leaves no dangling supersession links.
- AC-9: The Memories page supports listing, filters, create, edit, the similar-memories hint with Supersede and Keep both, successor links, embedding status with retry and confirmed forget, with all loading, empty, success and failure states.
- AC-10: Memory contents and embeddings never appear in logs, and the README, `.env.example` and `AGENTS.md` section 10 document memory types, the duplicate and supersede rules and provenance.

## Out of scope

- Search across Files and Memories, recall and related memories (Search spec) and MCP tools (MCP spec).
- Explicit relationship types between memories beyond supersession, expiry or decay of memories, and automatic extraction of memories from conversations.
- Memories inside Collections.

## Open questions

None.
