# Seshat

Seshat is a document RAG service. It stores documents in Postgres with pgvector and exposes them to AI agents
as a read-only MCP server. Humans upload and manage documents through a web UI and API.

> **Status: planned.** This repo currently only contains guidance and Gilde wiring. The application described
> below is built by later jobs; sections marked *(planned)* do not exist yet.

## Architecture *(planned)*
- One repo, one Docker container. A pnpm workspace with `apps/api` (NestJS: MCP server and upload/ingestion
  API) and `apps/web` (Next.js App Router: upload and browse). One Dockerfile builds both and runs them together.
- Postgres with the pgvector extension; TypeORM for entities and migrations.
- Uploaded files go through a pluggable ingestion layer (below) that turns them into documents.
- MCP over Streamable HTTP with a bearer token. Tools are read-only: search a collection, get a document, list
  collections. Upload, delete and re-index exist only in the API/UI, never in MCP.

## Run and develop *(planned)*
- Requires Docker and Postgres with the pgvector extension (for example the `pgvector/pgvector` image).
- Run everything in one container with Docker; for development use `pnpm install` and `pnpm dev`.
- Configuration (database URL, MCP bearer token) comes from environment variables; exact names follow with the scaffold.

## How Gilde uses Seshat
Gilde attaches Seshat as a project MCP server. Agents get the read-only tools only (search a collection, get a
document, list collections) and authenticate with a bearer token. Agents cannot change documents.

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
by `.github/workflows/sync-skills.yaml`.
