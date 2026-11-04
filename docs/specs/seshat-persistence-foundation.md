## Goal

Give Seshat a working persistence and configuration foundation that every later feature builds on: Postgres with pgvector through TypeORM, versioned migrations, validated environment configuration, a database-aware health check, and a CI pipeline that proves build and tests on every pull request.

## Context

- `apps/api` is NestJS 12 (ESM, `"type": "module"`, `module: NodeNext`, `.js` import suffixes), compiled with `tsc` (TypeScript 7), tests with Vitest 5. `tsconfig.json` already enables `experimentalDecorators` and `emitDecoratorMetadata`; Vitest transpiles without emitting decorator metadata, so entities and injectable classes must not depend on reflected types in tests (explicit column types; explicit `@Inject` tokens where reflection would be needed), or the test setup must add a transform that emits metadata.
- `docker-compose.yml` runs `pgvector/pgvector:pg17` with user, password and database `seshat` on port 5432.
- There is no CI workflow; only the skills sync workflow exists.
- Decisions (see `docs/adr/0001-foundation-decisions.md` once the guidance spec lands): Postgres only, TypeORM for entities and migrations, pg-boss later on the same database, `@nestjs/event-emitter` for in-process events.
- `GET /api/health` currently returns `{ status: 'ok' }` without checking anything.

## Behaviour

Configuration. A config module loads and validates environment variables at startup with a schema (for example zod). Invalid or missing required values stop the API with one clear message naming the variable, never its value. Initial variables: `DATABASE_URL` (required), `PORT` (default 4200), `NODE_ENV`. A committed `apps/api/.env.example` lists every variable with a safe example value and a one-line comment. Later specs add their variables to the same schema and example file. Domain code receives typed config through injection, not `process.env`.

Database. TypeORM is wired through `@nestjs/typeorm` with `synchronize` off in every environment. A data source file serves both the app and the TypeORM CLI. Migrations live in `apps/api/src/migrations` and run through package scripts (`migration:run`, `migration:revert`, `migration:generate`, `migration:create`). The first migration enables the `vector` extension (`CREATE EXTENSION IF NOT EXISTS vector`) and nothing else. The API runs pending migrations on startup only when `DB_MIGRATE_ON_START=true` (default true in development, documented); otherwise operators run the script. No domain entities are added in this job.

pgvector support. A small, tested helper maps between `number[]` and the pgvector column representation for TypeORM (a column transformer or custom type), so later entities can declare a `vector(<dimension>)` column with the dimension from config. A test proves a round trip through a real database.

Domain events. `@nestjs/event-emitter` is registered globally so later features can emit and listen without further wiring. No events are defined yet.

Health. `GET /api/health` stays public and checks the database with a cheap query: `200 { status: 'ok', db: 'ok' }` when reachable, `503 { status: 'error', db: 'unreachable' }` otherwise, without error details or connection strings in the response or logs.

Tests. Unit tests run with plain `pnpm test` and need no database. Integration tests (migrations, the vector helper, health against a live database) use `TEST_DATABASE_URL`; when it is not set they are skipped with a visible skip reason, so `pnpm test` still passes on a machine without Postgres. Integration tests run against a fresh schema and clean up after themselves.

CI. A GitHub Actions workflow runs on pull requests and on pushes to `main`: pnpm (version from `packageManager`) with caching, `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm test` with a `pgvector/pgvector:pg17` service container and `TEST_DATABASE_URL` set, so integration tests are not skipped in CI.

Docs. The README run section and `AGENTS.md` section 10 (current status) are updated: how to start the database, configure `.env`, run migrations and run integration tests locally.

## Acceptance criteria

- AC-1: The API validates its environment at startup; a missing or invalid `DATABASE_URL` stops it with a message that names the variable and never prints its value, and `apps/api/.env.example` documents every variable.
- AC-2: TypeORM is configured with `synchronize` disabled, one data source shared by the app and the CLI, and package scripts to run, revert, generate and create migrations.
- AC-3: The first migration enables the `vector` extension, can be reverted, and running migrations twice is a no-op.
- AC-4: A pgvector column helper stores and reads `number[]` values with a configurable dimension, proven by an integration test round trip.
- AC-5: `GET /api/health` returns 200 with `db: 'ok'` when the database is reachable and 503 with `db: 'unreachable'` when not, with no connection details in the response or logs.
- AC-6: `@nestjs/event-emitter` is registered globally in the API module.
- AC-7: `pnpm test` passes without a database, with integration tests visibly skipped, and runs those integration tests when `TEST_DATABASE_URL` is set.
- AC-8: A CI workflow runs install with a frozen lockfile, build and tests with a pgvector service container on pull requests and pushes to `main`, and integration tests are not skipped there.
- AC-9: The README and `AGENTS.md` section 10 describe the database setup, configuration, migrations and how to run integration tests.

## Out of scope

- Domain entities (Workspaces, Files, Memories and so on), pg-boss, embeddings and the AI SDK.
- Authentication and authorization.
- The production Dockerfile.

## Open questions

None.
