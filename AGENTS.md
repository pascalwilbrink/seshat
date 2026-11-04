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
- Workspaces (`src/workspaces/`): `GET/POST /api/global/workspaces`, `GET/PUT/DELETE /api/workspaces/:workspaceId`, plus `GET /api/global/overview` and `GET /api/workspaces/:workspaceId/overview`. Slugs are lowercase kebab-case, unique, fixed after creation; `global` is reserved. Delete needs `{ slug }` as confirmation (400 on mismatch) and emits `workspace.deleted` (`{ id }`) after commit; a Workspace that still has data cannot be deleted (409).
- Single admin (`src/auth/`): no user table. Env `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` (argon2id; generate with `pnpm --filter @seshat/api admin:hash-password`, which reads the password without echo and prints only the hash) and `SESSION_SECRET` (>= 32 characters); optional `TRUST_PROXY`. `POST /api/auth/login` sets the signed `seshat_session` cookie (HttpOnly, SameSite=Lax, path `/`, 7-day expiry, `Secure` whenever `NODE_ENV` is not `development`), `POST /api/auth/logout` clears it, `GET /api/auth/me`. Login is limited to 5 attempts per IP per minute and fails with one generic 401.
- Authorization: `SessionGuard` is global and default-deny; only `PUBLIC_ROUTES` (`GET /api/health`, `POST /api/auth/login`) skip it. All access decisions go through `AuthorizationService.assertCan(principal, action, scope)`; `Principal` is a discriminated union (`admin` and `apiKey`). It fails closed, and a missing and a denied Workspace give the same 404. New endpoints must call `assertCan` with an explicit `ScopeRef`, appear in `test/route-coverage.http.spec.ts`'s default-deny coverage, and leak no secrets (`test/sensitive-data.http.spec.ts`).
- `apps/web` (`@seshat/web`): Next.js App Router, port 3000. Browser traffic stays same-origin: `/api/*` is rewritten to the server-only `API_URL` (default `http://localhost:4200`). Every page except `/login` requires a session. Dark app shell with a scope switcher (Global first); routes `/global/{overview,settings}` and `/w/<slug>/{overview,settings}`; Workspace create, rename and slug-confirmed delete live in Settings.
- Database workflow: `apps/api/.env` (copy `apps/api/.env.example`) is loaded by the API and the migration scripts; shell variables win. `synchronize` is off and the app and CLI share one data source. Migrations run at startup only when `DB_MIGRATE_ON_START` is true (default in development, false otherwise). From the root: `pnpm --filter @seshat/api migration:run | migration:revert | migration:generate src/migrations/<Name> | migration:create src/migrations/<Name>`. The first migration needs a role that may `CREATE EXTENSION vector`. `GET /api/health` answers `200 {status:'ok',db:'ok'}` or `503 {status:'error',db:'unreachable'}` with no connection details. A reusable pgvector column helper (`src/database/vector-column.ts`) and a global `@nestjs/event-emitter` registration exist.
- Tests: plain `pnpm test` needs no database and visibly skips the integration suites. Set `TEST_DATABASE_URL` to a dedicated, disposable database (name contains `test`, not `DATABASE_URL`; the tests drop and recreate the `vector` extension) to run them; each test uses and drops its own schema. CI sets `REQUIRE_INTEGRATION_TESTS=true` and verifies the suites ran. Commands and examples are in the README ("Database and migrations", "Integration tests").
- `packages/domain` (`@seshat/domain`): browser-safe shared permission catalog (the ten permissions, display areas) and the action catalog (`ACTION_CATALOG`, explicit read/write/delete/admin/self classification, unknown actions fail closed). Imported by the API and web; no Nest/server dependencies. `Principal` also has `{ kind: 'apiKey', keyId, workspaceId, permissions }`; `AuthorizationService.assertCan` is the only policy point for it (own Workspace needs the mapped permission, other Workspace gives the generic 404, Global reads need the permission plus `global:read`, keys never write/manage Global or manage Workspaces/keys).
- Workspace API keys (`src/api-keys/`, web `/w/<slug>/api-keys`): env `API_KEY_PEPPER` (required, >= 32 characters, secret and stable; changing it invalidates all keys; never log it). Key format `sk_seshat_<prefix>_<secret>`; only the prefix and an HMAC-SHA-256 under the pepper are stored (migration `CreateApiKeys`), the full key appears only in the create response (`secret`) and is never logged or returned again. Admin-only routes under `/api/workspaces/:workspaceId/api-keys` (`GET`, `POST`, `PUT :keyId` for name and permissions, `POST :keyId/revoke`, immediate and irreversible); optional expiry; `last_used_at` written at most every 60 seconds; keys are deleted with their Workspace (cascade). Rotation is create plus revoke. `SessionGuard` accepts `Authorization: Bearer <key>` with a constant-time comparison; unknown, revoked and expired keys give one generic 401, and a bearer key together with the session cookie is a 400. `GET /api/auth/me` returns `{ kind: 'apiKey', workspace: { id, slug, name }, permissions }` for a key. The ten permissions and presets (`Agent: read`, `Agent: read and write`) are documented in the README. `global:read` is off by default and only lets a read into Global together with the matching read permission; keys never write or manage Global, never manage Workspaces or keys, and another Workspace gives the same 404 as a missing one. To add an operation, add it to `ACTION_CATALOG` in `packages/domain/src/actions.ts`, call `AuthorizationService.assertCan` (the only policy point), and extend `src/auth/authorization.matrix.spec.ts` plus the HTTP and integration security tests (404 responses compared byte for byte, 403 naming only the permission). Never put keys, digests or the pepper in logs, errors or responses; use placeholders in docs.
- `docker-compose.yml` with a `db` service (`pgvector/pgvector:pg17`) for development.
- `.gilde.json`, `CLAUDE.md` (`@AGENTS.md`) and the skills sync workflow `.github/workflows/sync-skills.yaml`.
- CI (`.github/workflows/ci.yml`): frozen install, build and tests on PRs and pushes to `main` with a pgvector service; `REQUIRE_INTEGRATION_TESTS=true` makes a missing `TEST_DATABASE_URL` fail instead of skip.

### Planned (not implemented)

- Files, Collections, Memories and Tags. No resource endpoint accepts an API key yet; keys currently only authenticate (`GET /api/auth/me`).
- Ingestion (`FileIngestor`, `FileIngestorProvider`, plain-text `txt`/`md` first), search and indexing.
- The MCP server (its tools will be gated by the calling key's permissions), a release/deploy pipeline, and a Dockerfile (target: one app container plus one database).

### Foundation decisions

Recorded in [docs/adr/0001-foundation-decisions.md](docs/adr/0001-foundation-decisions.md); these are decisions, not shipped code.

- Single tenant: one implicit account and one admin who logs in to the UI with credentials from the environment; no user management.
- MCP tools may write (upload, remember, update, forget, delete), always gated by the calling API key's permissions; the old read-only rule is dropped.
- Original files live on a local volume behind a `FileStorage` interface, so another backend can be added without touching callers.
- Embeddings go through the Vercel AI SDK (`ai`) with `@ai-sdk/openai`; model name and vector dimension come from configuration, not domain code.
- Durable background work (ingestion, re-indexing, cleanup after deletes) runs on pg-boss on the same Postgres.
- In-process domain events use `@nestjs/event-emitter`; listeners that do slow or retryable work enqueue a pg-boss job instead of working inline.
- Persistence is Postgres with pgvector through TypeORM.
