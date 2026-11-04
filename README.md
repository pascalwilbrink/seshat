# Seshat

Seshat is knowledge and memory infrastructure for AI agents and applications. It is meant to store files and
knowledge, extract and index their content, keep persistent memories, retrieve relevant information through
search, and expose controlled access through an API and MCP.

> **Status: early foundation.** Present: Postgres persistence, Workspace management, single-admin login and a
> login-protected web shell with scoped Overview, Settings and API Keys pages, and Workspace API keys with explicit
> permissions. Files, Collections, Memories, Tags, ingestion, search and MCP are planned. See [Status](#status).

## Core concepts
Global and Workspaces exist today; the other concepts below are planned.

- **Global** is a special scope for knowledge shared across the account. It is not a Workspace. Global
  resources are never available to a Workspace automatically: access must be granted explicitly.
- **Workspaces** (for example `Gilde`) are the organizational and security boundary. Their data is isolated
  from other Workspaces by default.
- **Files** are original uploaded documents. A file belongs to Global or one Workspace, optionally to a
  Collection. Originals are kept separate from extracted text, chunks and embeddings.
- **Collections** optionally organize files within a scope. They are not security boundaries.
- **Memories** are persistent knowledge records (`fact`, `decision`, `preference`, `experience`, `procedure`,
  `context`), not uploaded documents. They belong to Global or one Workspace.
- **Tags** are flat labels for Files and Memories, scoped to Global or one Workspace. They help filtering but
  do not grant access.
- **Workspace API keys** belong to a Workspace and carry explicit permissions (for example files, memories,
  collections, search, and read access to Global knowledge). A key cannot reach another Workspace, and Global
  access must be granted explicitly.
- **MCP** is the access interface for agents. Its tools are gated by the calling key's permissions, and they
  can both read and write.

The full guidance is in [`AGENTS.md`](AGENTS.md); foundation decisions are in
[`docs/adr/0001-foundation-decisions.md`](docs/adr/0001-foundation-decisions.md).

## Status
Present:
- A pnpm workspace with `apps/api` (NestJS, ESM, on `PORT` or 4200) and `apps/web` (Next.js App Router, port 3000).
- Postgres persistence through TypeORM with migrations (see [`apps/api/src/database/README.md`](apps/api/src/database/README.md))
  and `docker-compose.yml` with a development database (`pgvector/pgvector:pg17`).
- The Global/Workspace scope model: a reusable scoped-entity base, `ScopeRef`, explicit scope routes and Workspace
  management (list, create, get, rename, delete).
- A single admin with a signed session cookie, a default-deny global guard and a central authorization point.
- The web app: same-origin `/api` proxy, login, a dark app shell with a scope switcher, and Overview and Settings
  pages for Global and each Workspace.
- Workspace API keys: admin management (create, list, edit, revoke), bearer authentication and a shared permission
  and action catalog (see [Workspace API keys](#workspace-api-keys)).
- Gilde wiring: `.gilde.json`, `CLAUDE.md` and the skills sync workflow.

Also present: CI (build and tests with required integration tests, see [CI](#ci)).

Planned (does not exist yet): Files, Collections, Memories, Tags, ingestion, search, the MCP server, a
release/deploy pipeline, and a Dockerfile. The target is one application container plus one Postgres database. There is
no single Docker image today.

## Run and develop
Requires Node.js, pnpm (the repo pins `pnpm@10.28.0`) and Docker for the database.

```sh
pnpm install   # install dependencies
pnpm test      # unit tests (integration tests need TEST_DATABASE_URL, see the database README)
pnpm build     # build both apps
pnpm dev       # API on :4200 and web on :3000
```

### Local setup from scratch
1. Start the database: `docker compose up -d db`.
2. Create the API configuration and the web configuration:

   ```sh
   cp apps/api/.env.example apps/api/.env
   cp apps/web/.env.example apps/web/.env.local   # optional: API_URL already defaults to http://localhost:4200
   ```

   `apps/api/.env` is gitignored. The example values are placeholders: the API refuses to start until
   `ADMIN_PASSWORD_HASH` and `SESSION_SECRET` hold real values.
3. Generate the password hash. The script prompts for the password without echo (twice, 12-256 characters) and
   prints only the argon2id hash. The password is never accepted as an argument.

   ```sh
   pnpm --filter @seshat/api admin:hash-password
   ```

   Paste the printed hash into `ADMIN_PASSWORD_HASH`. Keep it exactly as printed (it contains `$`): the API reads
   `apps/api/.env` itself and does not expand variables.
4. Generate the session secret and put it in `SESSION_SECRET`: `openssl rand -base64 48`.
5. Run `pnpm dev` (migrations run at startup in development) and open <http://localhost:3000>. Log in with
   `ADMIN_USERNAME` and the password you chose.

### Configuration (`apps/api`)
| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | `postgres://` or `postgresql://` URL (pgvector enabled). |
| `ADMIN_USERNAME` | yes | The single admin's username (at most 128 characters). There is no user table. |
| `ADMIN_PASSWORD_HASH` | yes | argon2id hash from `admin:hash-password`. |
| `SESSION_SECRET` | yes | At least 32 characters; signs session cookies. Rotating it ends all sessions. |
| `TRUST_PROXY` | no | `false` (default) or the number of trusted reverse-proxy hops (1-99), used for the client IP. |
| `PORT` | no | 1-65535, default 4200. |
| `NODE_ENV` | no | `development` (default), `test` or `production`. |
| `DB_MIGRATE_ON_START` | no | `true`/`false`; default true in development, false otherwise. |
| `TEST_DATABASE_URL` | tests only | Disposable database whose name contains `test`. |

Invalid configuration stops startup with a message that names the variable but never prints its value.
`apps/web` reads one server-side variable, `API_URL` (default `http://localhost:4200`, never `NEXT_PUBLIC_`).

### Database and migrations
- `docker compose up -d db` starts the development database (`pgvector/pgvector:pg17`, local-only credentials
  `seshat`/`seshat`, database `seshat` on `localhost:5432`). It matches the `DATABASE_URL` in `apps/api/.env.example`.
- Env loading: the API and every migration script read `apps/api/.env` themselves (located relative to the code, so the
  working directory does not matter). Variables already set in the shell win over the file; empty values count as unset.
- `synchronize` is always off. The schema only changes through migrations in `apps/api/src/migrations/`, and the API and
  the TypeORM CLI share one data source (`apps/api/src/database/data-source.ts`).
- Migrations at startup: `DB_MIGRATE_ON_START` defaults to `true` in development (so `pnpm dev` migrates for you) and to
  `false` otherwise. Outside development, run migrations explicitly (below) before starting the API.
- The first migration runs `CREATE EXTENSION IF NOT EXISTS vector`, so the database role needs permission to create
  extensions (a superuser, or a trusted-extension grant). The dev compose user has it.
- Migration commands, run from the repo root (paths are relative to `apps/api`):

  ```sh
  pnpm --filter @seshat/api migration:run        # apply pending migrations; running it again is a no-op
  pnpm --filter @seshat/api migration:revert     # undo the most recent migration
  pnpm --filter @seshat/api migration:generate src/migrations/AddThing   # diff entities against the database
  pnpm --filter @seshat/api migration:create src/migrations/AddThing     # empty, timestamped migration
  ```

  Name migrations in PascalCase after what they do (`AddMemoryTable`); the timestamp prefix is added for you. Commit the
  generated file, and do not edit migrations that already landed.
- `GET /api/health` is public and returns `200 {"status":"ok","db":"ok"}`, or `503 {"status":"error","db":"unreachable"}`
  when the database cannot be reached. It never includes connection details.

### Integration tests
- `pnpm test` needs no database. Without `TEST_DATABASE_URL` the database suites are skipped and a visible warning
  (`[integration] ... SKIPPED`) is printed; suite names end in `[skipped: TEST_DATABASE_URL is not set]`.
- To run them, create a dedicated, disposable database and point `TEST_DATABASE_URL` at it:

  ```sh
  docker compose up -d db
  docker compose exec db createdb -U seshat seshat_test
  TEST_DATABASE_URL=postgres://seshat:seshat@localhost:5432/seshat_test pnpm test
  ```

  (Local-only example credentials.) The name must contain `test` and differ from `DATABASE_URL`, otherwise the suites
  refuse to run. This is required because the migration tests drop and recreate the database-scoped `vector` extension
  to prove rollback, so never use a database that holds real data. `DATABASE_URL` alone never enables them.
- Each test works in its own uniquely named schema, which is dropped (with its connections) in teardown, also after a
  failure. The suites run serially for the shared extension.
- CI always runs them: `REQUIRE_INTEGRATION_TESTS=true` turns a missing `TEST_DATABASE_URL` into a failure, and
  `apps/api/scripts/verify-integration-results.mjs` checks that the integration suites actually executed. Do not set
  `REQUIRE_INTEGRATION_TESTS` locally unless you want that failure.

### Sessions and the proxy
- The browser only talks to the web origin. Next rewrites `/api/*` to `API_URL`, so the browser never calls the API
  directly, there is no CORS setup, and the session cookie belongs to the web origin.
- `POST /api/auth/login` sets the `seshat_session` cookie: signed, `HttpOnly`, `SameSite=Lax`, path `/`, valid for
  seven days. It is `Secure` whenever `NODE_ENV` is not `development`, so outside development it only works over
  HTTPS (terminate TLS in front of the web app) and plain-HTTP logins will not keep a session. In development it is
  not `Secure`, so `http://localhost` works. The token is never in a response body.
- `POST /api/auth/logout` clears the cookie; `GET /api/auth/me` returns the current session.
- Login is limited to 5 attempts per client IP per minute (`429` with `Retry-After`); every failure returns the same
  `401 Invalid credentials`. Behind a reverse proxy set `TRUST_PROXY` so the real client IP is used; leave it
  unset otherwise, because trusting `X-Forwarded-For` lets clients dodge the limit.
- Passwords, hashes, secrets and cookies never appear in logs, errors or responses.

## Scopes, routes and authorization
- **Global is a scope, not a Workspace.** Every scoped resource is Global or in exactly one Workspace.
- API routes carry the scope explicitly: `/api/global/...` and `/api/workspaces/:workspaceId/...` (a UUID). There is
  no implicit "current Workspace". The web app mirrors this: `/global/overview`, `/global/settings`,
  `/w/<slug>/overview` and `/w/<slug>/settings`; the URL is the source of truth for the active scope.
- `ScopeRef` (`apps/api/src/scopes/scope-ref.ts`) is `{ kind: 'global' } | { kind: 'workspace', workspaceId }`. Path
  parameters are parsed into it (`WorkspaceScopePipe`; a non-UUID is a 400) and services receive it as an argument.
- Reusable scope storage: an entity extends `ScopedEntity` (`apps/api/src/scopes/scoped.entity.ts`) and gets `scope`
  and `workspace_id` columns, the check constraint `CK_scope_workspace_consistency` (`workspace_id` is null exactly
  for Global), a restricting foreign key to `workspaces`, and a `(scope, workspace_id)` index. Its migration must
  create these; integration tests reject invalid combinations.
- Authorization: every access decision goes through `AuthorizationService.assertCan(principal, action, scope)`
  (`apps/api/src/auth/authorization.service.ts`). `Principal` is a discriminated union (`principal.ts`, only
  `{ kind: 'admin' }` today). It is the single policy extension point: new principal kinds and new actions are added
  there and fail closed. A denied or missing Workspace both answer the identical `404`; a denied Global action is `403`.
- A global `SessionGuard` is default-deny: only `GET /api/health` and `POST /api/auth/login` are public (`PUBLIC_ROUTES`).

### Management endpoints
All require the admin session (`401` otherwise). Requests are strict JSON objects; unknown fields are rejected.

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /api/global/workspaces` | | `200` list ordered by name |
| `POST /api/global/workspaces` | `{ name, slug?, description? }` | `201` Workspace; slug derived from the name when omitted |
| `GET /api/workspaces/:workspaceId` | | `200` Workspace, `404` if missing or not allowed |
| `PUT /api/workspaces/:workspaceId` | `{ name, description }` (both required; `description: null` clears it) | `200` Workspace; the slug is fixed and cannot be sent; a missing field is a `400` naming it |
| `DELETE /api/workspaces/:workspaceId` | `{ slug }` | `204`; `400` unless `slug` equals the Workspace's slug exactly |
| `GET /api/global/overview`, `GET /api/workspaces/:workspaceId/overview` | | `200` scope summary |

Slugs are lowercase kebab-case (`a-z`, `0-9`, single hyphens, at most 100 characters), unique (`409` on a duplicate)
and fixed after creation. `global` is reserved and refused. Names are 1-100 characters. Deleting a Workspace that
still has data is a `409` (restricting foreign key). A successful delete emits the in-process event
`workspace.deleted` (`{ id }`) after the transaction commits, for cleanup listeners.

### Tests a new endpoint must satisfy
- It is covered by the route-enumeration test (`apps/api/test/route-coverage.http.spec.ts`): unauthenticated requests
  get `401`, and it is not added to `PUBLIC_ROUTES` unless it authenticates another way.
- It calls `assertCan` with an explicit `ScopeRef` before touching data, with tests for allowed, denied and
  missing-Workspace (identical `404`) cases.
- It validates input with strict schemas and leaks no secrets, hashes, cookies or protected existence information
  (`apps/api/test/sensitive-data.http.spec.ts`).

Files, Collections, Memories, Tags, search and MCP are future work and are not implemented. No endpoint yet accepts
an API key for resource access; keys can authenticate and call `GET /api/auth/me` only (see below).

### CI
`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`: a frozen `pnpm install`,
`pnpm build` and `pnpm test`, with a `pgvector/pgvector:pg17` service and a dedicated `seshat_test` database.
Integration tests are required in CI: it sets `REQUIRE_INTEGRATION_TESTS=true`, so a missing `TEST_DATABASE_URL`
fails the run instead of skipping the suites. Locally, plain `pnpm test` needs no database and skips them visibly.
To reproduce CI locally:

```sh
docker compose up -d db
docker compose exec db createdb -U seshat seshat_test
TEST_DATABASE_URL=postgres://seshat:seshat@localhost:5432/seshat_test REQUIRE_INTEGRATION_TESTS=true pnpm test
```

## Workspace API keys
A Workspace API key is a credential owned by exactly one Workspace, for agents and applications. It is managed by the
admin and carries an explicit list of permissions. **Only key management, authentication and the authorization policy
exist today.** The resource endpoints that will use keys (Files, Collections, Memories, Search) and the MCP server are
not implemented, so a key can currently do nothing except identify itself with `GET /api/auth/me`.

### Setup
1. Generate a pepper and set it in `apps/api/.env` as `API_KEY_PEPPER` (required, at least 32 characters; the API
   refuses to start without it, and the error never echoes the value):
   ```sh
   openssl rand -base64 48
   ```
   Keep it secret, out of Git and logs, and stable. It is the secret key of the HMAC-SHA-256 under which keys are stored.
2. Apply the persistence migration that creates the `api_keys` table (`1762500000000-CreateApiKeys`). It runs at
   startup when `DB_MIGRATE_ON_START` is true (default in development), otherwise run
   `pnpm --filter @seshat/api migration:run`.
3. Log in to the web app, open a Workspace and choose **API Keys** (`/w/<slug>/api-keys`). There is no Global key page.

### Storage and ownership
- A key looks like `sk_seshat_<8-character prefix>_<43-character secret>` (base62, from a CSPRNG).
- The database stores only the prefix (for lookup and display) and the HMAC-SHA-256 of the full key under
  `API_KEY_PEPPER`. The full key is never stored.
- **Rotating the pepper invalidates every existing key** (their stored HMACs no longer match). Plan it as a deliberate
  action and create new keys afterwards.
- A key belongs to one Workspace and is deleted with it (`ON DELETE CASCADE`). Global has no keys.

### Create, list, edit, revoke
All routes need the admin session, are never cacheable (`Cache-Control: no-store`) and answer a missing, foreign or
denied Workspace with the same `404`. A key can never call them.

| Method and path | Purpose |
| --- | --- |
| `POST /api/workspaces/:workspaceId/api-keys` | Create. Body `{ name, permissions, expiresAt? }` (`expiresAt` optional, ISO 8601 in the future). Returns `{ apiKey, secret }`. |
| `GET /api/workspaces/:workspaceId/api-keys` | List metadata: `id`, `name`, `prefix`, `permissions`, `createdAt`, `lastUsedAt`, `expiresAt`, `revokedAt`, `status`. |
| `PUT /api/workspaces/:workspaceId/api-keys/:keyId` | Replace `name` and `permissions` (both required). Expiry cannot be changed; a revoked key is a `409`. |
| `POST /api/workspaces/:workspaceId/api-keys/:keyId/revoke` | Revoke. Immediate and irreversible; repeating it keeps the original time. |

- **The full key is returned once**, in the `secret` field of the create response. It cannot be retrieved later; if it
  is lost, create a new key. The web page shows it once with a warning ("This is the only time the full key is
  shown...") and a **Copy key** button.
- Handle it as a password: store it in a secret manager or the agent's secret configuration, never in Git, chat,
  tickets, screenshots or logs. Seshat never logs keys, HMACs or the pepper, and list, error and `auth/me` responses
  never contain a secret or digest. Do not add such logging yourself.
- **Rotation is create plus revoke**: create a replacement key, switch the client over, then revoke the old one. There
  is no rotate endpoint.
- Edits and revocation take effect on the next request. `lastUsedAt` is written at most once per 60 seconds per key,
  and a failed write never fails the request.
- Keys may have an optional expiry; an expired key stops authenticating and is shown as `expired`.

### Bearer authentication
Send `Authorization: Bearer <key>` over HTTPS (the scheme is case-insensitive, one space or tab, no other format; keys
in query strings or bodies are not accepted). Unknown, malformed, wrong, revoked and expired keys all give the same
generic `401 Unauthorized`; the digest comparison is constant-time. A request that carries **both** a bearer key and
the admin session cookie is rejected with `400 Ambiguous credentials`, so use one credential per request.

`GET /api/auth/me` returns, for a key, `{ "kind": "apiKey", "workspace": { "id", "slug", "name" }, "permissions": [...] }`
and, for the admin, `{ "kind": "admin", "username" }`. It never returns the key id, prefix or digest.

Example with throwaway placeholders (never put a real key in a document, shell history or script):
```sh
export SESHAT_KEY='<paste the key shown once at creation>'
curl -sS -H "Authorization: Bearer $SESHAT_KEY" http://localhost:4200/api/auth/me
```

### Permissions
There are exactly ten permissions, defined once in `packages/domain` (`src/permissions.ts`) and shared by the API and web:

| Area | Permissions |
| --- | --- |
| Files | `files:read`, `files:write`, `files:delete` |
| Collections | `collections:read`, `collections:write` |
| Memories | `memories:read`, `memories:write`, `memories:delete` |
| Search | `search` |
| Global knowledge | `global:read` |

Presets in the web form (they never include `global:read` or any delete permission):
- **Agent: read** = `files:read`, `collections:read`, `memories:read`, `search`.
- **Agent: read and write** = the read set plus `files:write`, `collections:write`, `memories:write`.

Rules enforced by `AuthorizationService.assertCan`:
- In its own Workspace a key needs the permission mapped to the action. A missing one is a `403` that names only the
  permission (`Missing permission: files:read`), with no resource details.
- Another Workspace gives exactly the same `404` as a Workspace that does not exist.
- **Global is a dual grant, off by default.** A key can read Global only with `global:read` **and** the matching read
  permission for the operation (for example `files:read`). `global:read` alone authorizes nothing. In the web form this
  is the separate toggle "Allow reading Global `global:read`".
- A key can never write, delete or manage anything in Global, never manage Workspaces, and never manage keys.

### Extending the policy (for the future Files, Memories, Search and MCP work)
- Add each new operation to `ACTION_CATALOG` in `packages/domain/src/actions.ts` with an explicit classification
  (`read`, `write`, `delete`, `admin` or `self`) and, for the first three, its permission. There is no wildcard: an action
  not in the catalog is denied. Entries marked "future" there have no endpoint yet.
- Call `AuthorizationService.assertCan(principal, action, scope)` with an explicit `ScopeRef` before touching data. It
  is the only policy point; `Principal` (`admin` or `apiKey`) is what the guard produces. Do not check permissions
  anywhere else.
- Extend the table-driven matrix in `apps/api/src/auth/authorization.matrix.spec.ts` and the HTTP and integration tests
  in `apps/api/test/` (`api-key-auth`, `api-keys`, `route-coverage`, `sensitive-data`, `security`). Every new endpoint
  needs: default-deny coverage, an own-Workspace allow and missing-permission `403`, a foreign-vs-missing Workspace test
  that compares the two `404` responses byte for byte, Global tests for the dual grant, and revoked and expired keys.

## How Gilde uses Seshat *(planned)*
Gilde attaches Seshat as a project MCP server using a Workspace API key. What an agent can read or write
through it depends on that key's permissions, and on any Global knowledge explicitly granted to the key.
There is no Seshat MCP endpoint today.

## Ingestion extension point *(planned)*
- `FileIngestor` is an interface with `forFileExtensions(): string[]` and a method that ingests a file and
  returns `Document[]`.
- `Document` has `content` (string) and `metadata` (a record with at least source file name, extension and
  position/chunk info).
- `FileIngestorProvider` gets all `FileIngestor` implementations injected through a Nest multi-provider token,
  picks the one whose `forFileExtensions()` contains the uploaded file's extension (case-insensitive) and lets it
  ingest. An unsupported extension is a clear error.
- The first implementation is a plain-text ingestor for `txt` and `md`.

To add a format: implement `FileIngestor` (return your extensions in `forFileExtensions()`, produce `Document[]`
with the metadata above), register it under the `FileIngestor` injection token, and add tests. The provider
needs no change.

## Contributing
Coding agents: read `AGENTS.md`. The Gilde manifest is `.gilde.json`; skills are synced into `.claude/skills/`
by `.github/workflows/sync-skills.yaml`. Operator action: that workflow needs Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" enabled.
