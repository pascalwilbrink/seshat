# AGENTS.md

Guidance for AI coding agents working on **Seshat**.

Seshat is a remote knowledge and memory platform for AI agents. It
provides file storage, document ingestion, vector-based retrieval,
persistent memory, and MCP access.

This document describes the product concepts and engineering constraints
that agents should preserve when exploring, planning, or changing the
codebase.

## 1. Product purpose

Seshat provides persistent, reusable knowledge to AI agents and
applications.

Its core workflow is:

1.  Store files and knowledge.
2.  Extract and index content.
3.  Store persistent memories.
4.  Retrieve relevant information through search.
5.  Expose controlled access through APIs and MCP.

Seshat is more than a file manager or a thin vector-database wrapper.
Treat it as knowledge and memory infrastructure.

## 2. Core concepts

### Global

Global is a special scope for knowledge shared across the
account/workspace boundary. It is **not itself a Workspace**.

Global supports:

- Files
- Collections
- Memories
- Search
- Tags

Global resources must be explicitly made available to a Workspace
credential. They must never become accessible to a Workspace
automatically.

### Workspaces

A Workspace is the primary organizational, context, and security
boundary in Seshat.

Examples include `Graphnous`, `Gilde`, and `Aether`.

Each Workspace can contain:

- Files
- Collections
- Memories
- Tags
- API keys
- MCP configuration or server associations

Workspace data must be isolated from other Workspaces by default.

Use the term **Workspace** consistently in the UI, API, MCP interfaces,
database, and code. Do not introduce a separate `Project` abstraction
unless a future requirement explicitly calls for nested project
organization.

### Files

Files are original uploaded documents and other supported content.

Examples:

- PDF
- Markdown
- Plain text
- DOCX
- JSON
- CSV
- Source code

Files may belong to Global or one Workspace. A file may optionally
belong to a Collection.

Keep original file storage separate from extracted text, chunks,
embeddings, and metadata. A vector chunk must retain a reference to its
source file and, where available, its page, section, or other location
within the original.

### Collections

Collections organize files within a scope. They are optional: files can
exist directly in Global or a Workspace without belonging to a
Collection.

Collections are not security boundaries. Workspace isolation and
explicit permissions provide security.

Do not put Memories inside Collections by default. Memories have their
own types, tags, metadata, and retrieval lifecycle.

### Memories

Memories are persistent knowledge records, not uploaded documents.

Initial memory types:

- `fact` --- a known piece of information
- `decision` --- a decision or chosen direction
- `preference` --- a preference or instruction
- `experience` --- something that happened or was learned
- `procedure` --- instructions or knowledge about how to do something
- `context` --- general contextual information

Memories may belong to Global or one Workspace.

A memory should retain provenance where possible, including its source
or the agent/client that created it. Consider confidence, timestamps,
metadata, and relationships where supported by the implementation.

Do not assume every conversation should automatically be stored as
memory. Memory creation, updating, retrieval, and deletion need
deliberate lifecycle semantics.

### Tags

Tags are flat, reusable labels for classifying Files and Memories.

-   Tags are scoped to Global or a specific Workspace.
-   A resource can have multiple tags.
-   Tags can be reused across Files and Memories within the same scope.
-   Tags are not hierarchical.
-   Tags are useful for filtering and retrieval, but are not a
    substitute for authorization.

### API keys

API keys belong to a Workspace, not to individual files, Collections, or
Memories.

Keys should support explicit permissions, such as:

- Files: read, write, delete
- Memories: read, write, delete
- Collections: read, write
- Search: enabled or disabled
- Global knowledge: explicitly granted read access

A Workspace key must not access another Workspace. Global access must be
explicitly granted. Never expose a complete API key again after its
creation response; store only a secure representation appropriate to the
authentication design.

### MCP

MCP is an access interface for AI agents. It should expose useful Seshat
capabilities without making the UI a prerequisite.

File-related capabilities may include:

- `upload_file`
- `list_files`
- `get_file`
- `delete_file`
- `search_files`
- `get_file_chunks`
- `search_knowledge`
- `get_context`

Memory-related capabilities may include:

- `remember`
- `recall`
- `search_memories`
- `update_memory`
- `forget`
- `list_memories`
- `get_related_memories`

Treat this list as product direction, not a guarantee that every tool
already exists. Inspect the current implementation before changing or
documenting actual tool availability.

## 3. Scope and authorization rules

These rules are fundamental:

1.  Every resource belongs to an account/tenant scope and is either
    Global or belongs to exactly one Workspace.
2.  Workspace resources are isolated by default.
3.  A Workspace credential cannot access another Workspace.
4.  Global resources are not implicitly accessible to Workspace
    credentials.
5.  Global access must be explicitly granted and permission-checked.
6.  Collections and tags do not grant access.
7.  Apply authorization on the server for every operation. Hiding UI
    elements is not authorization.
8.  Search and retrieval must enforce scope and permissions before
    returning results. Do not rely on filtering unauthorized results
    only in the UI.
9.  Do not leak unauthorized filenames, snippets, metadata, chunk
    identifiers, counts, or existence information through search
    responses or errors.

Prefer explicit scope parameters and validated identifiers over implicit
assumptions about the current Workspace.

## 4. Retrieval and indexing principles

Files and Memories are distinct domain concepts, but they can
participate in a shared retrieval experience.

-   Preserve the source and scope of every retrieved result.
-   Keep chunks linked to their source file.
-   Preserve useful location metadata, such as page number or section.
-   Apply scope, permission, and metadata filters as part of retrieval.
-   Support searching Files, Memories, or both where the API and
    permissions allow it.
-   Do not assume vector similarity alone is sufficient; structured
    metadata and filters are important.
-   Keep the embedding provider and model configurable rather than
    hard-coding one provider throughout the application.
-   Make ingestion and indexing states observable, including pending,
    processing, indexed, and failed states where applicable.
-   Handle deletion consistently: deleting a source must not leave
    retrievable orphaned chunks or embeddings.

Do not introduce a graph database solely for memory relationships
without a concrete requirement. Start with the existing persistence
approach and keep the model extensible.

## 5. UI and product design principles

The product is dark-mode-first and minimal.

Current design direction:

- Background: `#0B0B10`
- Primary accent: `#8B5CF6`
- Primary text: `#F4F4F5`
- Muted secondary text
- Subtle borders and separators
- Restrained corner radii and spacing
- Clear typography and information hierarchy

The UI guide [docs/ui.md](docs/ui.md) is **binding for all UI work**:
tokens, typography, navigation config, shared components, required page
states, copy style, accessibility rules and the page patterns for later
features. Read it before changing or adding any page, and update it in the
same change when the design system changes.

Use the design system and component conventions already present in the
repository. Do not introduce a second design system or duplicate
components unnecessarily.

Avoid:

- Excessive cards and nested panels
- Decorative gradients
- Excessive animation
- Cluttered navigation
- Unnecessary logo decoration
- Overly complex visualizations before the underlying capability exists

The main product areas are:

- Overview
- Files
- Collections
- Search
- Memories
- MCP Servers
- API Keys (within a Workspace)
- Settings

Global and Workspace contexts should be clearly distinguishable.
Switching Workspace must update the active data context and navigation.

## 6. Engineering guidelines

Before making changes:

1.  Inspect the repository structure, package scripts, dependencies, and
    existing architecture.
2.  Read relevant documentation and existing code before proposing a new
    abstraction.
3.  Identify the current source of truth for domain types, API schemas,
    and validation.
4.  Follow existing naming, formatting, testing, and error-handling
    conventions.
5.  Prefer small, coherent changes over broad rewrites.

When implementing:

-   Preserve existing behavior unless the task explicitly changes it.
-   Keep domain logic separate from UI concerns.
-   Reuse existing services, components, schemas, and utilities.
-   Validate external input at system boundaries.
-   Follow the HTTP API conventions: updates use `PUT` on the
    resource URL with full replacement of the editable fields (every
    editable field is required, nullable fields are cleared with an
    explicit `null`, a missing field is a 400 naming it). `PATCH` is
    never used. Non-CRUD state changes are `POST` sub-resources (for
    example `POST .../revoke`, `POST .../reindex`), creation is `POST`
    to the collection URL, and deletion is `DELETE`.
-   Treat file content, metadata, and retrieved documents as untrusted
    data.
-   Do not put secrets in source code, logs, fixtures, or client
    bundles.
-   Avoid logging file contents, memory contents, credentials, or
    sensitive retrieved context.
-   Make errors actionable without revealing protected information.
-   Add or update tests for meaningful behavior, especially
    authorization and scope isolation.
-   Update relevant documentation when behavior, API contracts, or MCP
    tools change.

Do not invent endpoints, database tables, environment variables,
scripts, or tool names. Verify them in the repository before using them.

## 7. Testing expectations

Prioritize tests for:

-   Global versus Workspace resource ownership
-   Workspace isolation
-   Explicit Global access grants
-   API key permission enforcement
-   File ingestion and indexing lifecycle
-   Chunk-to-source-file references
-   Memory create, read, update, and delete
-   Search filtering by scope, resource type, Collection, and tags
-   Deletion of source data and associated vectors
-   MCP tool authorization and input validation

Include negative tests proving that unauthorized access is rejected and
does not leak resource information.

Run the relevant tests, linting, type checks, and build commands
available in the repository. Report commands that could not be run and
why.

## 8. Working with product requirements

When a requirement is ambiguous:

-   Inspect existing behavior and documentation first.
-   Preserve the established Global/Workspace distinction.
-   Prefer the smallest design that satisfies the requirement.
-   Ask for clarification when a decision would materially change data
    ownership, authorization, or public API contracts.

Do not silently change:

- Workspace isolation
- API key ownership
- Global access semantics
- The distinction between Files and Memories
- The optional nature of Collections
- The flat, scope-specific tag model

## 9. Definition of done

A change is not complete merely because the UI looks correct.

For a meaningful feature, verify as applicable:

- The data model represents the intended ownership and scope.
- Server-side authorization is enforced.
- API and MCP contracts are validated.
- UI states cover loading, empty, success, and failure.
- Tests cover normal and unauthorized paths.
- Existing behavior remains intact.
- Documentation reflects the actual implementation.

When reporting completion, summarize what changed, important design
decisions, tests run, and any known limitations.

## 10. Current status and decisions

Agents update this section when something lands. Everything under "Planned" is not implemented yet; verify in the repository before relying on it.

### Present in the repository

- pnpm workspace (`pnpm@10.28.0`, `apps/*`, `packages/*`) with recursive `pnpm build`, `pnpm test` and a parallel `pnpm dev`.
- `apps/api` (`@seshat/api`): NestJS, ESM, `/api` prefix, `PORT` or 4200. Postgres + TypeORM with migrations in `src/migrations/` (see `apps/api/src/database/README.md`); configuration is validated in `src/config/` and read only through `getAppConfig()`.
- Scopes (`src/scopes/`): `ScopeRef` (`{ kind: 'global' } | { kind: 'workspace', workspaceId }`) parsed from explicit routes `/api/global/...` and `/api/workspaces/:workspaceId/...`; services receive it as an argument. Global is a scope, never a Workspace row. Scoped entities extend `ScopedEntity` (`scope`, `workspace_id`, check `CK_scope_workspace_consistency` = `workspace_id` null exactly for Global, restricting FK to `workspaces`, `(scope, workspace_id)` index); their migration must create all of it.
- Workspaces (`src/workspaces/`): `GET/POST /api/global/workspaces`, `GET/PUT/DELETE /api/workspaces/:workspaceId`, plus `GET /api/global/overview` and `GET /api/workspaces/:workspaceId/overview`. Slugs are lowercase kebab-case, unique, fixed after creation; `global` is reserved. Delete needs `{ slug }` as confirmation (400 on mismatch) and emits `workspace.deleted` (`{ id }`) after commit; deleting a Workspace also removes its Files, Collections, Tags and stored originals (see Files below); other data that references it still makes the delete a 409 (restricting FK).
- Single admin (`src/auth/`): no user table. Env `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` (argon2id; generate with `pnpm --filter @seshat/api admin:hash-password`, which reads the password without echo and prints only the hash) and `SESSION_SECRET` (>= 32 characters); optional `TRUST_PROXY`. `POST /api/auth/login` sets the signed `seshat_session` cookie (HttpOnly, SameSite=Lax, path `/`, 7-day expiry, `Secure` whenever `NODE_ENV` is not `development`), `POST /api/auth/logout` clears it, `GET /api/auth/me`. Login is limited to 5 attempts per IP per minute and fails with one generic 401.
- Authorization: `SessionGuard` is global and default-deny; only `PUBLIC_ROUTES` (`GET /api/health`, `POST /api/auth/login`) skip it. All access decisions go through `AuthorizationService.assertCan(principal, action, scope)`; `Principal` is a discriminated union (`admin` and `apiKey`). It fails closed, and a missing and a denied Workspace give the same 404. New endpoints must call `assertCan` with an explicit `ScopeRef`, appear in `test/route-coverage.http.spec.ts`'s default-deny coverage, and leak no secrets (`test/sensitive-data.http.spec.ts`).
- `apps/web` (`@seshat/web`): Next.js App Router, port 3000. Browser traffic stays same-origin: `/api/*` is rewritten to the server-only `API_URL` (default `http://localhost:4200`). Every page except `/login` requires a session. Dark app shell with a scope switcher (Global first); routes `/global/{overview,settings,files,collections}` and `/w/<slug>/{overview,settings,files,collections,api-keys}`; Workspace create, rename and slug-confirmed delete live in Settings.
- Database workflow: `apps/api/.env` (copy `apps/api/.env.example`) is loaded by the API and the migration scripts; shell variables win. `synchronize` is off and the app and CLI share one data source. Migrations run at startup only when `DB_MIGRATE_ON_START` is true (default in development, false otherwise). From the root: `pnpm --filter @seshat/api migration:run | migration:revert | migration:generate src/migrations/<Name> | migration:create src/migrations/<Name>`. The first migration needs a role that may `CREATE EXTENSION vector`. `GET /api/health` answers `200 {status:'ok',db:'ok'}` or `503 {status:'error',db:'unreachable'}` with no connection details. A reusable pgvector column helper (`src/database/vector-column.ts`) and a global `@nestjs/event-emitter` registration exist.
- Tests: plain `pnpm test` needs no database and visibly skips the integration suites. Set `TEST_DATABASE_URL` to a dedicated, disposable database (name contains `test`, not `DATABASE_URL`; the tests drop and recreate the `vector` extension) to run them; each test uses and drops its own schema. CI sets `REQUIRE_INTEGRATION_TESTS=true` and verifies the suites ran. Commands and examples are in the README ("Database and migrations", "Integration tests").
- `packages/domain` (`@seshat/domain`): browser-safe shared permission catalog (the ten permissions, display areas) and the action catalog (`ACTION_CATALOG`, explicit read/write/delete/admin/self classification, unknown actions fail closed). Imported by the API and web; no Nest/server dependencies. `Principal` also has `{ kind: 'apiKey', keyId, workspaceId, permissions }`; `AuthorizationService.assertCan` is the only policy point for it (own Workspace needs the mapped permission, other Workspace gives the generic 404, Global reads need the permission plus `global:read`, keys never write/manage Global or manage Workspaces/keys).
- Workspace API keys (`src/api-keys/`, web `/w/<slug>/api-keys`): env `API_KEY_PEPPER` (required, >= 32 characters, secret and stable; changing it invalidates all keys; never log it). Key format `sk_seshat_<prefix>_<secret>`; only the prefix and an HMAC-SHA-256 under the pepper are stored (migration `CreateApiKeys`), the full key appears only in the create response (`secret`) and is never logged or returned again. Admin-only routes under `/api/workspaces/:workspaceId/api-keys` (`GET`, `POST`, `PUT :keyId` for name and permissions, `POST :keyId/revoke`, immediate and irreversible); optional expiry; `last_used_at` written at most every 60 seconds; keys are deleted with their Workspace (cascade). Rotation is create plus revoke. `SessionGuard` accepts `Authorization: Bearer <key>` with a constant-time comparison; unknown, revoked and expired keys give one generic 401, and a bearer key together with the session cookie is a 400. `GET /api/auth/me` returns `{ kind: 'apiKey', workspace: { id, slug, name }, permissions }` for a key. The ten permissions and presets (`Agent: read`, `Agent: read and write`) are documented in the README. `global:read` is off by default and only lets a read into Global together with the matching read permission; keys never write or manage Global, never manage Workspaces or keys, and another Workspace gives the same 404 as a missing one. To add an operation, add it to `ACTION_CATALOG` in `packages/domain/src/actions.ts`, call `AuthorizationService.assertCan` (the only policy point), and extend `src/auth/authorization.matrix.spec.ts` plus the HTTP and integration security tests (404 responses compared byte for byte, 403 naming only the permission). Never put keys, digests or the pepper in logs, errors or responses; use placeholders in docs.
- Files, Collections and Tags (`src/files/`, `src/collections/`, `src/tags/`, `src/storage/`; web `/global/{files,collections}` and `/w/<slug>/{files,collections}`; migrations `CreateFilesCollectionsTags`, `CreateStorageCleanupIntents`; README section "Files, Collections and Tags" has routes, curl example and operations). Env: `FILE_STORAGE_DIR` (required by the API; an existing writable directory, validated at startup with a message that never prints the path) and `MAX_UPLOAD_BYTES` (default 52428800); both in `apps/api/.env.example`, the only API env file. `FileStorage` (`put`/`get`/`delete`) has one implementation, `LocalVolumeFileStorage`: generated keys `originals/global/<fileId>` and `originals/workspaces/<workspaceId>/<fileId>`, temp file in `.tmp/` plus rename, key validation and symlink-escape rejection; client file names never reach a path. Routes under `/api/global/...` and `/api/workspaces/:workspaceId/...`: files (`POST` multipart with one `file` part, optional `collectionId`, repeated `tags`; `GET` list with `limit`/`cursor`/`collectionId`/`tag`/`status`/`name` returning `{ items, nextCursor, hasMore }`; `GET`, `PUT { name, collectionId, tags }`, `DELETE`, `GET .../download`), Collections (CRUD, unique name per scope, optional, never grant access, deleting keeps files) and Tags (`GET`, `PUT { name }`, `DELETE`; no create route, created by assigning names to a file; flat, normalized, unique per scope, `tags` independent of files so Memories can share them through their own join). Permissions: file read `files:read`, upload/edit `files:write`, delete `files:delete`, Collections `collections:read`/`collections:write`, Tags `files:read` OR `memories:read` to list and `files:write` OR `memories:write` to rename/delete; Global needs `global:read` plus the read permission and is never writable by keys. Foreign, ungranted and unknown resources give the identical 404. Uploads are streamed and size-checked on received bytes (413 leaves no row and no object); downloads are attachments with `nosniff`, a restrictive CSP and `no-store`. `file.uploaded` and `file.deleted` are emitted after commit. Deletion records a persisted cleanup intent (`storage_cleanup_intents`) in the deleting transaction (also for Workspace deletion); `StorageCleanupService` removes the object after commit, tolerates a missing object, and retries failures with exponential backoff (5 s up to 1 h, in-process timer, recovery of all pending intents at startup, leased with `SKIP LOCKED`), logging only ids and error class.
- Ingestion pipeline (`src/ingestion/`, `src/queue/`, `src/config/`; migration `CreateChunks`; web Files page; README section "Ingestion" has routes, operations and the ingestor example). pg-boss runs on `DATABASE_URL` in its own schema `pgboss` (`QueueService`: starts in `onApplicationBootstrap`, workers registered in `onModuleInit`, graceful stop in `beforeApplicationShutdown`); `file.uploaded` enqueues one `ingest-file` job per file (`singletonKey = fileId`, `exclusive` policy), 3 attempts in total, exponential backoff from 10 s, concurrency `INGESTION_CONCURRENCY`. The storage cleanup ledger (`storage_cleanup_intents`) is unchanged and not moved to pg-boss. Status `pending -> processing -> indexed | failed`; unsupported type, invalid UTF-8 and missing original fail without retry, transient errors retry and the final failure stores an allowlisted `ingestionError`; a deleted file ends the job quietly; re-runs yield identical chunk ids. Never log or store file content, chunk text, vectors, keys or raw provider/driver messages. Config (validated in `src/config/app-config.ts`, all in `apps/api/.env.example`): `OPENAI_API_KEY` (required by the API), `EMBEDDING_MODEL` (default `text-embedding-3-small`), `EMBEDDING_DIMENSION` (default 1536), `INGESTION_CONCURRENCY` (2), `CHUNK_SIZE_CHARS` (2000), `CHUNK_OVERLAP_CHARS` (200, smaller than the size). `chunks.embedding` is physically `vector(1536)`: the API checks the real column at startup and refuses to start on a mismatch; another dimension needs a new migration plus an explicit re-index, and changing only the model never re-indexes automatically. `chunks` has a cascading composite FK to `files`, scope columns, a JSON location (offsets, lines, `headingPath`, `section`) and an HNSW cosine index, so deleting a file or Workspace removes chunks and vectors. Ingestors: `FileIngestor` (`extensions`, `ingest(input): Promise<Document[]>`), `Document` (`content`, `source`, `startOffset`, `startLine`, optional `page`/`label`), `FileIngestorProvider` (case-insensitive lookup in the injected `FILE_INGESTORS` list); add a class to `provideFileIngestors(...)` in `ingestion.module.ts`, no provider change. `PlainTextIngestor` handles `txt` and `md` with strict UTF-8. Embeddings: `EmbeddingService` over the AI SDK `embedMany` with `@ai-sdk/openai`; tests use `FakeEmbeddingService`. Routes after the scope prefix: `POST /files/:fileId/reindex` (`file.reindex`, `files:write`, 202), `POST /files/reindex` (`fileIndex:reindexScope`, admin only, 202 with counts), `GET /files/:fileId/chunks?limit&cursor` (`file.chunks`, `files:read`, no embeddings); Global needs `global:read` for keys and never writes for them. The Files UI polls every 3 s while files are pending or processing, shows errors with Re-index and previews chunks. Real queue/vector/deletion suites run only with a disposable `TEST_DATABASE_URL` (CI sets `REQUIRE_INTEGRATION_TESTS=true`).
- Memories (`src/memories/`, web `/global/memories` and `/w/<slug>/memories`; migrations `CreateMemories`, `AddMemoryEmbeddingGeneration`; README section "Memories" has routes, rules and testing). Six types (`fact`, `decision`, `preference`, `experience`, `procedure`, `context`); `content` 1-10000 characters, `title` <= 200, `source` <= 500, `metadata` JSON object <= 8 KB, `confidence` 0-1, <= 100 tags. Global or exactly one Workspace, never in Collections; tags use the shared scoped `tags` table through `memory_tags`; created explicitly only (no automatic extraction). Routes under `/api/global/memories` and `/api/workspaces/:workspaceId/memories`: `GET` list (filters `type`, `tag`, `status` active|superseded|all with `active` default, `createdFrom/To`, `updatedFrom/To`, `text`; `limit` 25 default and 100 max, `cursor`, newest first, `{ items, nextCursor, hasMore, limit }`), `GET :id`, `POST` (201, or 200 `deduplicated: true`), `PUT :id` (full replacement, every field required, `null` clears optional ones, `[]` clears tags), `POST :id/supersede { successorId }`, `POST :id/retry-embedding` (admin only, 202) and `DELETE :id` (hard forget). Actions: `memory.list|get` need `memories:read`, `memory.remember|update|supersede` `memories:write`, `memory.forget` `memories:delete`, `memory.retryEmbedding` is admin; Global reads need `global:read` plus the read permission and keys never write Global; foreign, ungranted and unknown ids give the identical 404. Duplicates: SHA-256 of the NFC-normalized, whitespace-collapsed, trimmed content (case kept); an active Memory with the same scope, type and hash is returned with `deduplicated: true` and the requested tags are unioned (partial unique index, so concurrency-safe). Supersession is deliberate and transactional (`supersedes` at create, or the supersede endpoint after create; the UI's Supersede calls it and Keep both makes no request); superseded Memories are hidden from default lists and `PUT` on one is a 409 with `supersededBy`; forget deletes the row and tag links and clears `supersededBy` on Memories that pointed at it. Provenance is server-owned (`admin`, or API key id and the key's name at that time) and written once; the REST schemas are strict and reject client-supplied provenance with 400. The optional MCP client name and version can only come from a trusted adapter in code (`buildMemoryProvenance`); the MCP tools wrap these services. Embeddings reuse `EmbeddingService`, the pg-boss lifecycle and the dimension guard (`memories.embedding` is `vector(1536)`, checked at startup): after the lifecycle commit, embed inline (2.5 s timeout), otherwise `pending` plus an `embed-memory` job (3 attempts, exponential backoff, generation guard against stale writes, a 30 s reconciler for lost jobs), final failure is `failed` (admin retry). `MEMORY_SIMILARITY_HINT` (default 0.9, 0-1, validated in `src/config/app-config.ts`, documented in `apps/api/.env.example`) sets the threshold for up to three same-scope active `ready` hints (id, type, 120-character preview, withheld without `memories:read`) in the create response; nothing merges automatically. Memory content, titles, metadata and vectors are untrusted, never logged and never in job payloads. Tests: unit/HTTP with `FakeEmbeddingService`; the `test/memories-*.integration.spec.ts` suites need a disposable `TEST_DATABASE_URL`. Out of scope and not implemented: relationships beyond supersession, expiry, automatic extraction (recall and the other Memory tools are MCP tools, see the MCP bullet).
- Search and context (`src/search/`, web `/global/search` and `/w/<slug>/search`; migration `AddKeywordSearchVectors`; README section "Search and context" has examples and operations). Routes: `POST /api/global/search|context`, `POST /api/workspaces/:workspaceId/search|context` (200, `Cache-Control: no-store`, strict bodies) and `GET .../memories/:memoryId/related` (query `limit` 1-50 default 10, `type`, Workspace-only `includeGlobal`). Body: `query` (trimmed, 1-2000), `types` (default `files`+`memories`), Workspace-only `includeGlobal` (default false), `collectionIds`/`fileIds` (UUID lists, chunks only), `tags` + `tagMatch` (`any` default | `all`, both kinds), `memoryTypes` and `includeSuperseded` (Memories only, superseded hidden by default), `limit` (1-50, default 10), `minScore` (on the fused RRF score, not cosine), context-only `maxChars` (default 8000, max 50000, minimum = warning and delimiters, 400 below). A filter never narrows a kind it does not apply to. Candidates: chunks of `indexed` files and active Memories; Memory embeddings may be null (keyword only). Authorization is `AuthorizationService.authorizeSearch` before any embedding: a key needs `search` AND `files:read` for `files` AND `memories:read` for `memories` AND `global:read` for Global (Global routes or `includeGlobal: true`; never implicit), 403 `Missing permission: ...`; scope, types and filters are SQL predicates in every branch; filter ids are never looked up, so foreign, ungranted and random ids give identical responses; the related seed is looked up in the route scope only (404 otherwise). Keyword: stored generated `tsvector` columns (`chunks.content_tsv`, `memories.search_tsv`, `simple` configuration, GIN) queried with `websearch_to_tsquery('simple', ...)`. Vector: cosine; query embedded once. Fusion: RRF k=60 (`1/(60+rank)`), deterministic order, candidates `min(200, limit*4)` per ranking. Results carry kind, `score`, `vectorRank`, `keywordRank`, scope and source details (chunk: file, Collection id, ordinal, location; Memory: type, title, tags, status, confidence, source, provenance); no totals, candidate or excluded counts, vectors or storage keys. A failing query embedding degrades to keyword-only with `degraded: 'keyword_only'` (never masks database or authorization errors; the Search page shows a notice). Context: one `context` string with a data-not-instructions warning, `BEGIN/END [n]` sections of `> `-prefixed, escaped text, and `sources` for exactly the included sections; `maxChars` bounds the whole string including overhead, the first non-fitting section is truncated and the rest dropped. Related: nearest active Memories by cosine `distance`, empty for a seed without an embedding, no provider call; the web UI does not use it yet. pgvector: the strategy is chosen at run time from `pg_extension` (>= 0.8.0: `hnsw.iterative_scan = strict_order`, `hnsw.max_scan_tuples`, `hnsw.ef_search`; older: `ef_search = 1000`), an underfilled vector branch is re-run as a scoped exact scan, settings are transaction-local; the exact version behind the floating `pgvector/pgvector:pg17` tag is not recorded in the repo (`test/retrieval.integration.spec.ts` reads and asserts it against a real database). Queries, content, vectors and provider errors are never logged. Web result links are Global-aware (`/global/...` for Global results). Tests: unit/HTTP with `FakeEmbeddingService`; `retrieval`, `retrieval-http`, `related` and `keyword-vectors` integration specs need a disposable `TEST_DATABASE_URL`. The retrieval services are reusable and back the MCP search tools; **no saved searches, rerankers or original-byte search exist**.
- MCP server (`apps/api/src/mcp/`, `packages/domain/src/mcp-tools.ts`; spec `docs/specs/seshat-mcp-server.md`; README section "Connect an agent over MCP"; web page `/w/<slug>/mcp`). `/mcp` is served outside the `/api` prefix (excluded in `configureApp`) with `@modelcontextprotocol/sdk`: stateless Streamable HTTP, a fresh `Server` + transport per request, no session ids (`POST` serves; `GET`/`DELETE` answer 405), server name `seshat`, version of `apps/api/package.json`. `SessionGuard` accepts only `Authorization: Bearer <key>` on `/mcp` (same key verification as the REST routes): missing, unknown, revoked, expired keys and any session cookie (with or without a key) give 401 with `WWW-Authenticate: Bearer` and the generic body; `/mcp` is in `test/route-coverage.http.spec.ts` and never in `PUBLIC_ROUTES`. Body limit: 16 KB everywhere, except `/mcp` with a Bearer credential, whose limit derives from `MCP_MAX_UPLOAD_BYTES` (base64 plus 64 KB envelope). Env `MCP_MAX_UPLOAD_BYTES` (default 10485760) and `MCP_MAX_RESULT_CHARS` (default 20000), validated in `src/config/`, documented in `apps/api/.env.example`. A tool (`McpToolDefinition` in `mcp-registry.ts`) declares name, agent-facing description, zod object schema, `kind` (`read` | `write` | `destructive`), `requires` (`allOf` / `anyOf` permissions, the browser-safe `McpToolRequirement` from `@seshat/domain`), the `actions` re-checked through `AuthorizationService.assertCan` on every call, and a handler receiving `{ principal, scope, client }`. `tools/list` shows a tool only when the key's permissions satisfy `requires`; an unlisted tool fails exactly like an unknown one (protocol error `Unknown tool.`). Annotations come from the kind (`mcpAnnotationsFor`): read `readOnlyHint: true`; destructive `destructiveHint: true` and `readOnlyHint: false`; other writes `readOnlyHint: false`. Tools act in the key's Workspace (`workspaceScopeOf`); read tools reuse `readScopeFields` (`scope?: 'workspace' | 'global'`, resolved with `resolveReadScope`) and search tools `searchScopeFields` (`includeGlobal`); writing tools never accept either, and Global reads are decided by the existing policy. Errors are `isError: true` results with fixed messages (`mcp-errors.ts`: zod names the field, forbidden names only permissions, not found / foreign / malformed ids (`mcpIdSchema`, `McpNotFoundError`) are one identical message, anything else is `Internal error.`). Results go through `toolResult` (structured plus text, capped at `MCP_MAX_RESULT_CHARS` with a truncation note; oversized structured content becomes `{ truncated: true }`) and retrieved content through `wrapRetrieved` (delimited block marked as data, markers neutralized). Client name and version (`McpClientContext`, validated with the provenance limits) come only from the body of the call (`params.clientInfo` or `params._meta.clientInfo`), otherwise `null`: a stateless transport does not see `initialize` on later calls and standard clients send no other source. **Tools (15, all registered in the running application)**, with permissions from `MCP_TOOL_CATALOG`: read-only (`readOnlyHint: true`) `list_files`, `get_file`, `get_file_chunks` (`files:read`), `list_collections` (`collections:read`), `list_tags` (`files:read` or `memories:read`), `search_knowledge` and `get_context` (`search` plus `files:read` or `memories:read`, per requested type), `recall` and `get_related_memories` (`search` plus `memories:read`), `list_memories` (`memories:read`); writing (`readOnlyHint: false`) `upload_file` (`files:write`), `remember` and `update_memory` (`memories:write`); destructive (`destructiveHint: true`) `delete_file` (`files:delete`) and `forget` (`memories:delete`). Read tools live in `read-tools.ts` and writing tools in `mcp-write-tools.ts` (modules `mcp-tools.module.ts`, `mcp-write-tools.module.ts`). Read tools take `scope: 'global'` and search tools `includeGlobal` (both need `global:read`; ungranted Global reads give `Not found.`, `includeGlobal` searches name `global:read`); writing tools reject both and never write to Global. Foreign, ungranted, malformed and random ids all give `Not found.`; the Workspace MCP page and README table are derived from the same catalog. `upload_file` and `remember` record the key and, from `_meta.clientInfo`, the client name and version. Tests: `test/mcp.http.spec.ts`, `mcp-read-tools.http.spec.ts` and `mcp-write-tools.http.spec.ts` (fakes, no database) and `test/mcp-e2e.integration.spec.ts`, which boots the real `AppModule` against a database of its own (needs a disposable `TEST_DATABASE_URL`; the fake embedding replaces `AiSdkEmbeddingService` through `vi.mock`, and the entity classes are passed to the data source explicitly because TypeORM's native glob import cannot load TypeScript under Vitest) and drives it with the SDK client; its name is in `REQUIRED` of `apps/api/scripts/verify-integration-results.mjs`, so CI fails if it is skipped.

  **To add a tool:** (1) add its entry (`kind`, `requires`) to `MCP_TOOL_CATALOG` in `packages/domain/src/mcp-tools.ts`; (2) define it in a tool class (`read-tools.ts` or `mcp-write-tools.ts`, or a new `@Injectable` registered in a module) with a closed zod schema (`z.strictObject`, ids with `mcpIdSchema`), `kind` and `requires` taken from the catalog entry, the `actions` it needs (each must exist in `ACTION_CATALOG`), and a handler that only calls an existing service with `ctx.principal` and `ctx.scope`; register it through `MCP_TOOL_REGISTRY`; wrap retrieved text with `wrapRetrieved`; (3) never read the scope from input for a writing tool; (4) add the tool to `test/mcp-e2e.integration.spec.ts` (tool name sets and annotations, happy path, missing permission, foreign vs random id, validation, caps) and to the HTTP spec, update the README tool table and this list.
- `docker-compose.yml` with a `db` service (`pgvector/pgvector:pg17`) for development.
- Docker packaging: a multi-stage `Dockerfile` builds one image (non-root `node` user, `tini`, `docker/entrypoint.mjs` + `docker/supervisor.mjs` run the API on 4200 and the Next standalone server on 3000, forward `SIGTERM` and exit non-zero when either stops; `VOLUME /data/files`, health check on `/api/health`; defaults `NODE_ENV=production`, `DB_MIGRATE_ON_START=true`, `FILE_STORAGE_DIR=/data/files`, `API_URL=http://127.0.0.1:4200` fixed at build time; the MCP address on the Workspace MCP page is the runtime setting `SESHAT_MCP_URL`, validated http(s) ending in `/mcp`, read server-side by the page; the web proxy body limit follows `MAX_UPLOAD_BYTES` at build time). `.dockerignore` keeps env files, `.git` and build output out of the context. `docker-compose.yml` has the opt-in `app` profile (root `.env` from `.env.example`, `DATABASE_URL` forced to the `db` service, named `pgdata` and `files` volumes). `docker-compose.yml` accepts `SESHAT_IMAGE` to run a published image. The README section "Run with Docker" documents configuration, upgrades, backups and the `/mcp` reverse-proxy route (directly to 4200). CI publishes the image to GHCR as `ghcr.io/pascalwilbrink/seshat` (linux/amd64 and arm64, SBOM, provenance and attestation) from the `publish-image` job, which needs `build-and-test` and `image-smoke` and runs only on pushes to `main` (tags `main`, `sha-<short>`) and `vX.Y.Z` tags (`X.Y.Z`, `X.Y`, `X`, `latest`); release by pushing a `vX.Y.Z` tag. Only that job has `packages: write`; third-party actions are pinned to commit SHAs. The package is private until the owner changes its visibility once in GHCR. CI job `image-smoke` builds the image and runs `docker/verify-image.mjs` and `docker/smoke.mjs` (healthy DB check, login page, same-origin API proxy, `/mcp` 401 without a key); it does not exercise MCP tools or ingestion.
- `.gilde.json`, `CLAUDE.md` (`@AGENTS.md`) and the skills sync workflow `.github/workflows/sync-skills.yaml`.
- CI (`.github/workflows/ci.yml`): frozen install, build and tests on PRs and pushes to `main` with a pgvector service; `REQUIRE_INTEGRATION_TESTS=true` makes a missing `TEST_DATABASE_URL` fail instead of skip.

### Planned (not implemented)

- Ingestors beyond `txt`/`md` (PDF, DOCX, JSON, CSV, code), additional storage backends (only the local volume exists).
- Further MCP tools (for example collection or tag management), a release/deploy pipeline (including publishing the image to a registry).

### Foundation decisions

Recorded in [docs/adr/0001-foundation-decisions.md](docs/adr/0001-foundation-decisions.md); these are decisions, not shipped code.

- Single tenant: one implicit account and one admin who logs in to the UI with credentials from the environment; no user management.
- MCP tools may write (upload, remember, update, forget, delete), always gated by the calling API key's permissions; the old read-only rule is dropped.
- Original files live on a local volume behind a `FileStorage` interface, so another backend can be added without touching callers.
- Embeddings go through the Vercel AI SDK (`ai`) with `@ai-sdk/openai`; model name and vector dimension come from configuration, not domain code.
- Durable background work (ingestion, re-indexing, cleanup after deletes) runs on pg-boss on the same Postgres.
- In-process domain events use `@nestjs/event-emitter`; listeners that do slow or retryable work enqueue a pg-boss job instead of working inline.
- Persistence is Postgres with pgvector through TypeORM.
