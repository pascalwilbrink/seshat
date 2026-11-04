# 0001. Foundation decisions

- Status: accepted
- Date: 2026-11-04

## Context

Seshat started as a read-only document RAG service. It is now meant to be knowledge and memory infrastructure for AI agents: Global and Workspaces, Files, Collections, Memories, Tags, Workspace API keys and MCP access (see `AGENTS.md`).

The repository today is a scaffold: a pnpm workspace with a NestJS API that only serves `GET /api/health`, a minimal Next.js page, and a Compose `db` service using `pgvector/pgvector:pg17`. Persistence, the domain, ingestion, MCP, CI and a Dockerfile do not exist yet. This record fixes the foundation choices the product owner has made so later work builds on them; it does not claim any of them is implemented.

## Decision

1. **Single tenant.** One implicit account and one admin who logs in to the UI with credentials taken from the environment. There is no user management.
2. **Permission-gated MCP writes.** MCP tools may write (upload, remember, update, forget, delete). Every call is gated by the permissions of the calling Workspace API key. The earlier rule that MCP is read-only is dropped.
3. **Local-volume file storage behind `FileStorage`.** Original files are stored on a local volume behind a `FileStorage` interface, so another backend can be added later without touching callers.
4. **Embeddings through the Vercel AI SDK.** Embeddings use `ai` with the `@ai-sdk/openai` provider. The model name and the vector dimension come from configuration and are never hard-coded in domain code.
5. **pg-boss for durable jobs.** Ingestion, re-indexing and cleanup after deletes run as pg-boss jobs on the same Postgres.
6. **`@nestjs/event-emitter` for in-process events.** Domain events such as "file uploaded" or "workspace deleted" use `@nestjs/event-emitter`. Listeners that do slow or retryable work enqueue a pg-boss job instead of doing the work inline.
7. **Postgres with pgvector through TypeORM.** Relational data and vectors live in one Postgres database, accessed through TypeORM.

## Consequences

- The target deployment stays one application container plus one database; no separate queue, broker or vector store is needed.
- With a single tenant there is no account or user model to design now; authorization rests on the admin login for the UI and on Workspace API key permissions for agents. Moving to multiple tenants later would be a new decision.
- Because MCP can write, the server must check key permissions on every tool call and must not leak unauthorized information in errors. Tests for authorization and Workspace isolation matter more than they did under a read-only design.
- Behind `FileStorage`, callers do not depend on where bytes live. A local volume must be persisted and backed up by the operator, and it ties the app to a node with that volume until another backend exists.
- Choosing the embedding model and dimension by configuration means changing either requires re-embedding existing content, which is a re-index job.
- pg-boss ties background work to Postgres availability and adds its own tables in that database. Work started by event listeners survives restarts because it is enqueued, not run in memory.
- Adding `ai`, `@ai-sdk/openai`, `pg-boss`, `@nestjs/event-emitter` and TypeORM are dependency changes that belong to the jobs that implement them.
- None of this exists in the code yet; the scaffold is not connected to the database.
