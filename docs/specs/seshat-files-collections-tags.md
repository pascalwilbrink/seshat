## Goal

Let the admin and permitted API keys store original files in Global or a Workspace, organize them in optional Collections and label them with flat, scope-specific Tags, with the originals kept on a local volume behind a storage interface. This is the input for the ingestion pipeline that follows.

## Context

- Depends on `seshat-scopes-workspaces-admin` (scope columns, scoped routes, `workspace.deleted` event) and `seshat-api-keys-authorization` (permission catalog, `AuthorizationService`).
- Decisions: originals on a local volume behind a `FileStorage` interface; `@nestjs/event-emitter` for in-process events; pg-boss for durable work (introduced by the ingestion spec).
- `AGENTS.md`: keep originals separate from extracted text, chunks and embeddings; Collections are optional and never security boundaries; Memories are not put in Collections; Tags are flat, scoped to Global or one Workspace, shared by Files and Memories in that scope, and never grant access; file content and metadata are untrusted.

## Behaviour

Storage. A `FileStorage` interface (`put(key, stream)`, `get(key)` as a stream, `delete(key)`, `exists(key)`) with one implementation, `LocalVolumeFileStorage`, rooted at `FILE_STORAGE_DIR` (validated config; the directory must exist and be writable at startup). Storage keys are generated (for example `<scope>/<workspace id or global>/<file uuid>`), never derived from the uploaded file name, and resolved paths are checked to stay inside the root. Writes go to a temporary file and are renamed into place. Callers depend only on the interface.

Files. A scoped `files` table: id, original file name (sanitized for display: no path segments or control characters, at most 255 chars), extension (lowercased), declared MIME type, size in bytes, SHA-256 of the content, storage key, optional Collection id, `ingestion_status` (`pending`, `processing`, `indexed`, `failed`; default `pending`; the ingestion spec drives the transitions), optional `ingestion_error`, created and updated timestamps. Operations under `/api/global/files` and `/api/workspaces/:workspaceId/files`:
- Upload (multipart, `files:write`): enforces `MAX_UPLOAD_BYTES` (default 50 MB) while streaming and returns 413 above it; optional Collection id and tag names; computes size and SHA-256; stores the original; creates the row; after commit emits `file.uploaded` with id and scope.
- List (`files:read`): cursor pagination, filters by Collection, tag, ingestion status and name substring, sorted by newest first.
- Get metadata and download the original (`files:read`): downloads are always `Content-Disposition: attachment` with a safe file name, `X-Content-Type-Options: nosniff`, and never rendered inline.
- Update (`files:write`): rename the display name, set or clear the Collection, replace tags.
- Delete (`files:delete`): deletes the row and emits `file.deleted` after commit; the original is removed from storage by a listener, and a missing storage object is not an error.

Collections. A scoped `collections` table: id, name (1–100 chars, unique per scope, case-insensitive), optional description, timestamps. List and get (`collections:read`), create, rename and delete (`collections:write`). Deleting a Collection keeps its files and clears their Collection id. A file and its Collection must be in the same scope; a mismatch is a 400 that does not reveal whether the other Collection exists.

Tags. A scoped `tags` table: id, name normalized to lowercase and trimmed (1–50 chars, letters, digits, `-`, `_`, `.`, `:` and `/`), unique per scope, and a `file_tags` join table. Assigning tag names to a file creates missing tags in the file's scope. Tags can be listed (with `files:read` or `memories:read`), renamed and deleted (`files:write` or `memories:write`); deleting a tag detaches it everywhere. The model is shaped so the Memories spec adds a `memory_tags` join on the same `tags` table.

Isolation. Every query is constrained by the resolved `ScopeRef`. Ids from another scope behave exactly like ids that do not exist (404). Global reads by keys follow the Global grant rules from the API key spec. New actions are added to the action catalog.

Workspace deletion. A `workspace.deleted` listener removes the Workspace's files, Collections and tags and their stored originals; failures are logged by id and retried, never leaving rows that point at a deleted Workspace.

UI. Files page for Global and each Workspace: upload with drag and drop and multiple files, upload progress, a table with name, size, Collection, tags, ingestion status and upload time, filters (Collection, tag, status, name), download, delete with confirmation, and a detail panel to rename, move between Collections and edit tags. Collections page: list with file counts, create, rename and delete (stating that files are kept). Navigation shows Files and Collections. Loading, empty, success and failure states are covered.

Tests. Storage path traversal attempts, temporary-write-then-rename, size limit (413 without a partial row or stored object), SHA-256 and size recorded, download headers, Collection scope mismatch, tag normalization and uniqueness per scope, delete removing the original, Workspace deletion cleanup, and isolation tests for every endpoint (other Workspace, Global with and without the grant, missing permission).

## Acceptance criteria

- AC-1: A `FileStorage` interface with a `LocalVolumeFileStorage` implementation stores originals under `FILE_STORAGE_DIR` with generated keys, atomic writes and a path check that rejects anything outside the root.
- AC-2: Files can be uploaded, listed with cursor pagination and filters, read, downloaded, updated and deleted in Global and in a Workspace, each operation gated by its permission through `AuthorizationService`.
- AC-3: Uploads above `MAX_UPLOAD_BYTES` return 413 and leave no row and no stored object; successful uploads record sanitized name, extension, MIME type, size and SHA-256, and emit `file.uploaded` after commit.
- AC-4: Downloads are always attachments with a safe file name and `nosniff`, never rendered inline.
- AC-5: Deleting a file removes its row, emits `file.deleted`, and removes the stored original, tolerating an already missing object.
- AC-6: Collections are optional, unique by name per scope, never grant access, and deleting one keeps its files; a file cannot join a Collection in another scope.
- AC-7: Tags are flat, normalized, unique per scope, auto-created on assignment in the file's scope, and deletable everywhere at once; the table shape allows Memories to share them.
- AC-8: Resources from another Workspace, and Global resources without the grant, behave exactly like missing resources, proven by isolation tests for every endpoint.
- AC-9: Deleting a Workspace removes its files, Collections, tags and stored originals.
- AC-10: The Files and Collections pages work for Global and Workspaces with upload, filters, download, edit, delete and all loading, empty, success and failure states, and the README, `.env.example` and `AGENTS.md` section 10 are updated.

## Out of scope

- Text extraction, chunking, embeddings and ingestion status transitions (next spec).
- Search, Memories and MCP tools.
- Storage backends other than the local volume, file versioning and duplicate detection.

## Open questions

None.
