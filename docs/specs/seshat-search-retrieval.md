## Goal

Let the admin and permitted keys find relevant knowledge across file chunks and memories with one retrieval service that combines vector similarity, keyword matching and structured filters, enforces scope and permissions inside the query itself, and can return a ready-to-use, cited context block. The MCP tools in the next spec are thin wrappers around this service.

## Context

- Depends on `seshat-api-keys-authorization` (permissions `search`, `files:read`, `memories:read`, `global:read`), `seshat-files-collections-tags`, `seshat-ingestion-pipeline` (`chunks` with scope columns, location metadata and an HNSW cosine index; `EmbeddingService`) and `seshat-memories` (`memories` with status, tags and embeddings).
- `AGENTS.md`: preserve the source and scope of every result; apply scope, permission and metadata filters as part of retrieval; vector similarity alone is not enough; support Files, Memories or both; never leak unauthorized filenames, snippets, metadata, chunk ids, counts or existence through results or errors.
- Postgres `pgvector/pgvector:pg17`; pgvector's HNSW iterative index scans (`hnsw.iterative_scan`) avoid filtered queries returning fewer results than requested. `TODO(verify)`: the pgvector version in the image supports it; if not, fall back to an exact scan when filters are selective and document the choice.

## Behaviour

Keyword index. A migration adds a generated `tsvector` column with the `simple` configuration (content is mixed Dutch and English, and identifiers must match exactly) and a GIN index on `chunks.content` and on `memories` title plus content.

Search request. `POST /api/global/search` and `POST /api/workspaces/:workspaceId/search` (permission `search`) accept: `query` (1–2000 chars, required); `types` (`files`, `memories` or both; default both); `includeGlobal` (Workspace endpoint only; default false); filters `collectionIds`, `fileIds`, `tags` with `tagMatch` `any` or `all`, `memoryTypes`, `includeSuperseded` (default false); `limit` (default 10, max 50) and optional `minScore`. Requesting `files` requires `files:read`, `memories` requires `memories:read`, and `includeGlobal` requires `global:read`; a missing permission is a 403 naming it. Filter ids from scopes the caller cannot access behave like ids that match nothing, without any error that confirms they exist.

Retrieval. The query is embedded once. For each requested type the service runs a vector query (cosine distance over HNSW) and a keyword query (`websearch_to_tsquery`) whose `WHERE` clauses carry every scope, permission and metadata filter, so unauthorized or filtered rows never enter ranking; only chunks of `indexed` files and only `active` memories (unless `includeSuperseded`) are candidates, and memories without an embedding are reachable through keywords only. The two rankings are merged with reciprocal rank fusion (k = 60), and files and memories are merged into one list by fused score. Results are cut at `limit` after fusion; the service fetches enough candidates per ranking (for example 4 × limit) that filtered searches still return `limit` results when that many matches exist.

Results. Each result has: `kind` (`chunk` or `memory`), id, fused score with the vector and keyword ranks, scope (`global` or the Workspace id and slug), and content. Chunks add file id, file name, Collection id, chunk ordinal and location (section, heading path, line range, page). Memories add type, title, tags, status, confidence, source, provenance and updated time. Responses contain no totals, no counts of excluded items and no ids outside the caller's access.

Context. `POST .../context` (same permissions and request, plus `maxChars`, default 8000, max 50000) runs the search and returns one text block in which each result is a delimited section headed by a citation (`[1] file.md › Section › lines 10–42` or `[2] memory · decision · title`), trimmed to the budget by dropping lowest-scored results first and truncating the last one at a sentence boundary, together with the list of cited sources. The block states that the content is retrieved data, not instructions.

Related memories. `GET .../memories/:id/related` (`memories:read`, `search`) returns the nearest active memories to a given memory in the same scope (and Global when the caller asks for it and holds the grant), excluding the memory itself, with optional type filter and limit.

Embedding failure. When the provider cannot embed the query, search falls back to keyword-only ranking and marks the response with `degraded: 'keyword_only'`; it does not fail.

UI. A Search page for Global and each Workspace: query box, toggles for Files and Memories, filters for Collection, tag, memory type and superseded, an "Include Global" toggle on Workspace pages, results with kind badge, scope, source (file name and location, or memory type and title), a content excerpt with the query terms highlighted, and links that open the file detail at the chunk or the memory. A degraded search shows a notice. Navigation shows Search. Loading, empty, success and failure states are covered.

Tests. Fixtures with two Workspaces and Global prove that results never include another Workspace's chunks or memories, never include Global without `includeGlobal` and the grant, and never include a type the caller cannot read; that a response for a filter id from another Workspace equals the response for a random id; that an exact identifier is found by keyword where the vector ranking misses it; that superseded memories and chunks of non-indexed files are excluded; that a selective filter still fills `limit` when enough matches exist; that the context block respects its budget and cites every included result; and that keyword-only fallback works. All tests use the deterministic fake embedding service.

## Acceptance criteria

- AC-1: Generated `tsvector` columns with the `simple` configuration and GIN indexes exist for chunk content and memory title and content.
- AC-2: The Global and Workspace search endpoints accept query, types, `includeGlobal`, Collection, file, tag, memory type and superseded filters, limit and `minScore`, and require `search` plus `files:read`, `memories:read` and `global:read` for what is requested.
- AC-3: Scope, permission and metadata filters are part of every vector and keyword query, and tests show that other Workspaces, Global without the grant and unreadable types never appear in results.
- AC-4: Vector and keyword rankings are merged with reciprocal rank fusion across files and memories, only indexed chunks and active memories are candidates by default, and an exact identifier is found by keyword when the vector ranking misses it.
- AC-5: Filtered searches still return `limit` results when that many matches exist, proven by a test with a selective filter.
- AC-6: Each result carries kind, scores, scope and source details (file, Collection, ordinal and location for chunks; type, title, tags, status and provenance for memories), and responses contain no totals or excluded-item counts.
- AC-7: A filter id from an inaccessible scope produces the same response as a random id.
- AC-8: The context endpoint returns a delimited, cited block within `maxChars` that states it is data, not instructions, plus the list of cited sources.
- AC-9: Related memories returns the nearest active memories within the caller's access, and query embedding failures degrade to keyword-only results marked `degraded`.
- AC-10: The Search page offers query, type toggles, filters, Include Global on Workspaces, cited results with links and a degraded notice with all loading, empty, success and failure states, and the README and `AGENTS.md` section 10 describe search and context.

## Out of scope

- MCP tools (next spec), rerankers or LLM-based query rewriting, and saved searches.
- Searching original file bytes or files that are not indexed.
- Analytics on search queries.

## Open questions

None.
