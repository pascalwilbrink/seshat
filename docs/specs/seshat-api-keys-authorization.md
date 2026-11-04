## Goal

Let agents and applications authenticate to Seshat with API keys that belong to one Workspace and carry explicit permissions, including an explicit grant to read Global knowledge. Extend the single authorization point from the scopes spec so every later feature (Files, Memories, Search, MCP) gets correct isolation by calling it, not by writing its own checks.

## Context

- Depends on `seshat-scopes-workspaces-admin`: `ScopeRef`, scope in the path (`/api/global/...`, `/api/workspaces/:workspaceId/...`), `Principal` as a discriminated union with `{ kind: 'admin' }`, a global guard with a public allowlist, and `AuthorizationService.assertCan(principal, action, scope)`.
- `AGENTS.md`: keys belong to a Workspace, never to files, Collections or Memories; a Workspace key cannot access another Workspace; Global access must be explicitly granted; the full key is shown only in the creation response and only a secure representation is stored; do not leak existence of resources a caller cannot access.
- Decision: MCP tools may write, gated by key permissions. The MCP server (a later spec) authenticates with these same keys.
- Single tenant: only the admin manages keys.

## Behaviour

Permission catalog. Permissions are a fixed set of strings defined once in the domain and shared by API, MCP and UI: `files:read`, `files:write`, `files:delete`, `collections:read`, `collections:write`, `memories:read`, `memories:write`, `memories:delete`, `search`, `global:read`. An action catalog maps every operation later specs add (for example `file.upload`, `memory.forget`, `search.query`) to the permission it needs; this spec defines the catalog and its mapping mechanism, and later specs add entries. `global:read` never grants anything alone: reading Global requires `global:read` plus the matching read permission (for example `files:read`), and it never allows writing, deleting or managing anything in Global.

Keys. The admin creates a key inside a Workspace with a name, a non-empty set of permissions and an optional expiry date. The secret has the form `sk_seshat_<8-char prefix>_<at least 32 random base62 chars>` from a cryptographically secure source. The database stores the prefix, an HMAC-SHA-256 of the full key under `API_KEY_PEPPER` (validated config, at least 32 characters), name, permissions, workspace id, created, expires, last used and revoked timestamps. The full key appears only in the create response. The admin can list keys (never the secret; the prefix is shown), edit name and permissions, and revoke (soft, immediate, irreversible). Keys are deleted with their Workspace. Keys cannot create, edit or revoke keys and cannot manage Workspaces.

Authentication. Requests may send `Authorization: Bearer <key>`. The guard looks the key up by prefix, compares the HMAC in constant time, rejects revoked or expired keys with the same generic 401 as an unknown key, and resolves `{ kind: 'apiKey', keyId, workspaceId, permissions }`. `last_used_at` is updated at most once per minute per key. The admin session cookie keeps working; a request with both a cookie and a bearer key is rejected with 400. `GET /api/auth/me` returns the key's Workspace (id, slug, name) and permissions, never the secret.

Authorization rules for keys, all inside `AuthorizationService`:
- Own Workspace: allowed when the action's permission is in the key.
- Global: only read actions, only with `global:read` plus the read permission.
- Any other Workspace: denied, and the response is the same 404 as for a Workspace that does not exist.
- Admin-only actions (Workspaces, keys): denied with 403 for keys.
- A missing permission within an accessible scope returns 403 with a message naming the permission needed, never resource details.

UI. A Workspace has an API Keys page (not shown for Global). It lists name, prefix, permissions, created, last used, expiry and status. Creating a key offers checkboxes per permission, grouped by area, with presets "Agent: read" (`files:read`, `collections:read`, `memories:read`, `search`) and "Agent: read and write" (adds `files:write`, `collections:write`, `memories:write`), and a separate, clearly labelled `global:read` toggle that is off by default. After creation the secret is shown once with a copy button and a warning that it will not be shown again. Revoke asks for confirmation. Loading, empty, success and failure states are covered.

Logging. Keys, HMACs and the pepper never appear in logs, errors or responses; key use may be logged by key id and prefix only.

## Acceptance criteria

- AC-1: A single shared permission catalog and action-to-permission mapping exist in the domain, used by the guard, `AuthorizationService` and the UI.
- AC-2: The admin can create, list, edit and revoke Workspace keys; the full key appears only in the create response, and the database holds only its prefix and an HMAC under `API_KEY_PEPPER`.
- AC-3: Bearer authentication resolves an API key principal with constant-time comparison; unknown, revoked and expired keys get the same generic 401, and sending both a session cookie and a key is rejected.
- AC-4: A key can act in its own Workspace only within its permissions; a missing permission returns 403 naming the permission and no resource details.
- AC-5: A key gets the same 404 for another Workspace as for a Workspace that does not exist, proven by a test that compares both responses byte for byte.
- AC-6: A key reads Global only with `global:read` plus the matching read permission, and can never write, delete or manage anything in Global.
- AC-7: Keys cannot manage Workspaces or keys, and are deleted when their Workspace is deleted.
- AC-8: A table-driven test covers every permission against every action in the catalog for own Workspace, other Workspace and Global, plus revoked and expired keys.
- AC-9: The Workspace API Keys page lists keys, creates them with grouped permissions, presets and a separate off-by-default Global toggle, shows the secret once with a warning, and revokes with confirmation.
- AC-10: Keys, HMACs and the pepper never appear in logs, errors or responses, and the README, `.env.example` and `AGENTS.md` section 10 document keys, permissions and the Global grant.

## Out of scope

- Key rotation as a single operation (create a new key and revoke the old one instead), per-key rate limits and usage analytics.
- Keys for Global itself or account-wide keys.
- The MCP server and the resource endpoints that the permissions protect.

## Open questions

None.
