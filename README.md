# Seshat

Seshat is knowledge and memory infrastructure for AI agents and applications. It is meant to store files and
knowledge, extract and index their content, keep persistent memories, retrieve relevant information through
search, and expose controlled access through an API and MCP.

> **Status: early foundation.** Present: Postgres persistence, Workspace management, single-admin login and a
> login-protected web shell with scoped Overview and Settings pages. Files, Collections, Memories, Tags, API keys,
> ingestion, search and MCP are planned. See [Status](#status).

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
- Gilde wiring: `.gilde.json`, `CLAUDE.md` and the skills sync workflow.

Planned (does not exist yet): Files, Collections, Memories, Tags, API keys, ingestion, search, the MCP server, CI
beyond skills sync, and a Dockerfile. The target is one application container plus one Postgres database. There is
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
| `PATCH /api/workspaces/:workspaceId` | `{ name?, description? }` (at least one) | `200` Workspace; the slug is fixed and cannot change |
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

API keys, Files, Collections, Memories, Tags, search and MCP are future work and are not implemented.

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
