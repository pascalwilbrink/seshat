## Goal

Introduce the ownership model at the heart of Seshat: every resource is either Global or belongs to exactly one Workspace. Let the single admin log in, manage Workspaces, and switch between Global and Workspaces in the UI, with one server-side authorization point that later specs (API keys, Files, Memories, Search, MCP) extend instead of reinventing.

## Context

- Depends on the persistence foundation (TypeORM, migrations, validated config, `@nestjs/event-emitter`) and on the updated `AGENTS.md`.
- `AGENTS.md`: Global is not a Workspace; Workspaces are isolated by default; Global access for Workspace credentials must be explicit; authorization happens on the server for every operation; errors and responses must not leak existence of resources a caller cannot access; use the term Workspace everywhere, no `Project` abstraction.
- Decision: single tenant, one implicit account, one admin whose credentials come from the environment. No user table.
- `apps/web` is Next.js App Router with no styling yet; the API listens on 4200 and the web app on 3000. Later both run in one container.
- Design direction from `AGENTS.md`: dark-mode first, background `#0B0B10`, accent `#8B5CF6`, primary text `#F4F4F5`, muted secondary text, subtle borders, restrained radii, no decorative gradients or heavy animation.

## Behaviour

Scope model. A shared domain type `ScopeRef` is either `{ kind: 'global' }` or `{ kind: 'workspace', workspaceId }`. Scoped entities carry the same two columns through a reusable embeddable or base class: `scope` (`global` or `workspace`) and `workspace_id`, with a database check constraint that `workspace_id` is null exactly when `scope` is `global`, a foreign key to `workspaces`, and an index on (`scope`, `workspace_id`). API routes make scope explicit in the path: `/api/global/...` and `/api/workspaces/:workspaceId/...`; a validated parser turns them into a `ScopeRef`, and services take a `ScopeRef` argument instead of reading an implicit "current workspace". No scoped resource entities are added yet beyond what tests need.

Workspaces. A `workspaces` table with id (uuid), name (1–100 chars), slug (lowercase kebab-case, unique, derived from the name unless given), optional description, created and updated timestamps. The admin can list, create, get, rename (name, description; slug is fixed after creation) and delete Workspaces. Delete requires the request to repeat the slug as confirmation, emits a `workspace.deleted` domain event with the id so later modules can clean up their data, and is a hard delete. "global" is a reserved slug and cannot be used. Inputs are validated at the boundary with clear 400 errors.

Admin authentication. Credentials come from `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` (an argon2id hash; a documented package script produces one), plus `SESSION_SECRET` (at least 32 characters), all validated by the config schema. `POST /api/auth/login` compares in constant time and on success sets a signed, `HttpOnly`, `SameSite=Lax` session cookie (`Secure` outside development) that expires after 7 days; `POST /api/auth/logout` clears it; `GET /api/auth/me` returns the principal. Failed logins return one generic error and are rate limited per IP (for example 5 per minute). Passwords, hashes, secrets and cookies never appear in logs or responses.

Authorization point. Every request resolves a `Principal`. For now the only kind is `{ kind: 'admin' }`; the type is a discriminated union so the API key spec can add `{ kind: 'apiKey', workspaceId, permissions }`. A global guard rejects unauthenticated requests to every route except an explicit public allowlist (`GET /api/health`, `POST /api/auth/login`). An `AuthorizationService.assertCan(principal, action, scope)` is the single place that decides access; the admin may do everything, and the service is written and tested so that adding a Workspace-bound principal later only adds rules. A request for a Workspace that does not exist and one the principal may not see return the same 404 response.

Web UI. The browser talks only to the web origin: Next.js proxies `/api/*` to the API (target from `API_URL`, default `http://localhost:4200`), so the session cookie is first-party. A login page; all other pages require a session and redirect to login otherwise. An app shell with the design tokens as CSS variables (dark first), a scope switcher listing Global first, visually distinct, then the Workspaces, and navigation showing only areas that exist after this spec: Overview (scope name, and for a Workspace its description and created date) and Settings (create, rename and delete Workspaces, with the slug confirmation for delete). The active scope is in the URL (`/global/...`, `/w/<slug>/...`) so switching updates data and navigation and survives reload. Loading, empty, success and failure states are covered, including an empty state with "Create your first Workspace".

Tests. Unit and integration tests cover the scope constraint, slug rules and the reserved slug, Workspace CRUD and the delete event, login success, failure and rate limit, session expiry, and a test that enumerates all registered API routes and asserts every route outside the public allowlist returns 401 without a session. Web component tests cover the scope switcher and the login redirect.

## Acceptance criteria

- AC-1: Scoped entities can use a shared scope embeddable or base with `scope` and `workspace_id`, a check constraint that `workspace_id` is null exactly for Global, a foreign key to `workspaces` and an index, proven by an integration test that rejects invalid combinations.
- AC-2: Scope is explicit in API paths (`/api/global/...`, `/api/workspaces/:workspaceId/...`) and parsed into a validated `ScopeRef` that services receive as an argument.
- AC-3: The admin can list, create, get, rename and delete Workspaces with validated input, unique fixed slugs and the reserved slug `global` refused; delete requires the slug as confirmation and emits `workspace.deleted`.
- AC-4: Login uses `ADMIN_USERNAME`, an argon2id `ADMIN_PASSWORD_HASH` and `SESSION_SECRET` from validated config, sets a signed HttpOnly SameSite=Lax cookie (Secure outside development) with a 7-day expiry, is rate limited per IP, and returns one generic error on failure.
- AC-5: A global guard rejects every route outside the public allowlist without a valid session, and a route-enumeration test proves it.
- AC-6: All access decisions go through `AuthorizationService.assertCan(principal, action, scope)` with `Principal` as a discriminated union, and a missing Workspace and an inaccessible one produce the same 404.
- AC-7: Secrets, password hashes, passwords and session cookies never appear in logs, errors or responses.
- AC-8: The web app proxies `/api/*` to the API, requires login for every page, and shows an app shell with the dark design tokens, a scope switcher with Global first and visually distinct, and the active scope in the URL.
- AC-9: The Overview and Settings pages work for Global and Workspaces, including Workspace create, rename and slug-confirmed delete, with loading, empty, success and failure states.
- AC-10: The README, `.env.example` and `AGENTS.md` section 10 document the admin setup (including generating the password hash), the scope route convention and the authorization point.

## Out of scope

- API keys and Workspace-bound principals (next spec), MCP, Files, Collections, Memories, Tags and Search.
- Multiple users, roles, multi-tenancy, password reset and OAuth.
- Navigation entries for areas that do not exist yet.

## Open questions

None.
