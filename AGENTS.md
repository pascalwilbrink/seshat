# Seshat — agent guide

Seshat is a RAG service: it stores documents in Postgres with pgvector and exposes them to AI agents as a
read-only MCP server (Gilde attaches it as a project MCP server). Humans upload and manage documents through
the API and web UI.

> **Status: planned.** The repo currently holds only guidance and Gilde wiring (`AGENTS.md`, `CLAUDE.md`,
> `README.md`, `.gilde.json`, `.github/workflows/sync-skills.yaml`, `.gitignore`). Everything marked
> *(planned)* below does not exist yet and is created by later jobs (first the scaffold job). Don't assume it
> exists; verify before relying on it, and update this file when it lands.

## Repository layout
pnpm workspace (`pnpm-workspace.yaml`: `apps/*`, `packages/*`) *(planned)*.

- `apps/api/` — NestJS API *(planned)*: MCP server, upload/ingestion API, TypeORM entities and migrations
- `apps/web/` — Next.js App Router UI *(planned)*: upload and browse documents
- `Dockerfile` *(planned)* — one image builds both apps and runs them in one container
- `.gilde.json` — Gilde manifest (present): stacks, test commands, gildeboek skills for this repo
- `.github/workflows/sync-skills.yaml` — syncs gildeboek skills into `.claude/skills/` by PR (present)

## Commands
*(planned; created by the scaffold job. `TODO(verify)`: run and confirm each once they exist)*
- Install: `pnpm install`
- Test: `pnpm test` (the `.gilde.json` test command)
- Build: `pnpm build`
- Dev: `pnpm dev` — `TODO(verify)`: ports and the Postgres + pgvector setup

## Architecture
Planned, one repo and one Docker container running the NestJS API and the Next.js UI.

- Storage: Postgres with the `pgvector` extension; TypeORM for entities and migrations. Postgres only, no SQLite.
- Upload: files are uploaded through the UI/API and handed to the ingestion layer.
- Ingestion is pluggable:
  - `FileIngestor` is an interface with `forFileExtensions(): string[]` and a method that ingests a file and
    returns `Document[]`.
  - `FileIngestorProvider` gets all `FileIngestor` implementations injected (a Nest multi-provider with an
    injection token). It receives an uploaded file, picks the ingestor whose `forFileExtensions()` contains the
    file's extension (case-insensitive) and lets it ingest. An unsupported extension is a clear error.
  - `Document` has `content` (string) and `metadata` (a record with at least source file name, extension and
    position/chunk info).
  - First implementation: a plain-text ingestor for `txt` and `md`.
  - To support a new format, add a `FileIngestor` and register it in the multi-provider; don't change the provider.
- MCP: Streamable HTTP with a bearer token. Read-only tools for agents: search a collection, get a document,
  list collections.
- **MCP is read-only.** Writing (upload, delete, re-index) happens only through the API/UI for humans, never
  through an MCP tool.

## Routes / interfaces
*(planned)* `TODO(verify)`: global prefix, versioning, auth and the MCP endpoint path once the scaffold exists.

## Conventions
- One NestJS module per domain; each has `*.entity.ts`, `*.dto.ts`, `*.mapper.ts`, `*.service.ts`, `*.controller.ts`, `*.module.ts`.
- `TODO(verify)`: ESM or CommonJS is decided by the scaffold job; once decided, state it here (with ESM: relative imports end in `.js`).
- DTOs are zod schemas; types via `z.infer`. Validate with a `ZodValidationPipe`. Import zod-inferred types with `import type`; import injected classes normally (DI needs the runtime reference).
- Services return DTOs via a mapper, never entities, except methods documented as internal. Controllers only validate and delegate.
- Throw Nest HTTP exceptions (`NotFoundException`, `ConflictException`, …); never let ORM errors leak to clients.
- Entity column types must work on Postgres; Postgres only, no SQLite. Entity changes need a migration.
- Entities follow the `typeorm-snake-case-columns` skill (once synced into `.claude/skills/`): snake_case tables and columns, camelCase TypeScript fields.
- Unit tests next to the code as `*.spec.ts`; e2e tests in `test/`.
- Web: Next.js App Router; pages stay thin and render a view from `components/`. `TODO(verify)`: further web conventions after the scaffold.

## Rules for agents
- Make the smallest change that satisfies the task and its acceptance criteria.
- If the task conflicts with existing code or is ambiguous, don't guess: report it as `blocked` and explain.
- Add or update tests for behaviour you change.
- Run the test command before opening a PR; don't open a PR with failing tests unless the task is impossible (then report `blocked`).
- Do not modify `.github/`, `.claude/`, `AGENTS.md`, `CLAUDE.md`, or existing database migrations unless the task says so.
- Skills in `.claude/skills/` are synced from Gilde-dev/gildeboek; never edit them in this repo.
- Do not add dependencies unless the task needs them; mention any new one in the PR.
- Never commit secrets, tokens or `.env` files.
