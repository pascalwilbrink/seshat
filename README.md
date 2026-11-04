# Seshat

Seshat is knowledge and memory infrastructure for AI agents and applications. It is meant to store files and
knowledge, extract and index their content, keep persistent memories, retrieve relevant information through
search, and expose controlled access through an API and MCP.

> **Status: early scaffold.** Only the workspace, a health endpoint, a minimal web page and a development
> database definition exist. Everything described under "Core concepts" and "How Gilde uses Seshat" is planned.
> See [Status](#status).

## Core concepts *(planned)*
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
- A pnpm workspace with `apps/api` (NestJS, only `GET /api/health`, on `PORT` or 4200) and `apps/web`
  (Next.js App Router, one minimal page on port 3000).
- `docker-compose.yml` with a development database (`pgvector/pgvector:pg17`). The apps do not connect to it yet.
- Gilde wiring: `.gilde.json`, `CLAUDE.md` and the skills sync workflow.

Planned (does not exist yet): persistence, the Global/Workspace domain, Files, Collections, Memories, Tags,
API keys, ingestion, search, the MCP server, CI, and a Dockerfile. The target is one application container plus
one Postgres database. There is no single Docker image today.

## Run and develop
Requires Node.js, pnpm (the repo pins `pnpm@10.28.0`) and, for the database, Docker.

```sh
pnpm install   # install dependencies
pnpm test      # unit tests
pnpm build     # build both apps
pnpm dev       # API on :4200 (GET /api/health) and web on :3000
```

Optional: start the development database. The scaffold does not use it yet.

```sh
docker compose up -d db
```

There is no application configuration yet (no auth or database environment variables).

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
