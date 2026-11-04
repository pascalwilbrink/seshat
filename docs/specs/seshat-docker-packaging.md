## Goal

Ship Seshat as one Docker image that runs the NestJS API (including MCP and the ingestion workers) and the Next.js UI together, needs only Postgres with pgvector and a volume for files, and is easy to run locally and on a server.

## Context

- Depends on the earlier Seshat specs for the configuration it packages: validated env config, migrations with `DB_MIGRATE_ON_START`, `FILE_STORAGE_DIR`, admin and API key secrets, OpenAI embedding config, pg-boss on the same database, `/api/health`, and MCP at `/mcp`.
- The web app proxies `/api/*` to the API through `API_URL`. MCP over Streamable HTTP streams responses, so MCP clients connect to the API port directly rather than through the Next.js proxy.
- `docker-compose.yml` currently runs only the `pgvector/pgvector:pg17` database for development. CI (from the persistence spec) runs install, build and tests.

## Behaviour

Image. A multi-stage `Dockerfile` at the repository root: a build stage installs with `pnpm install --frozen-lockfile` and builds both apps (Next.js with standalone output); the runtime stage is a slim Node image with only production dependencies and build output, runs as a non-root user, and uses `tini` as PID 1. A small entrypoint starts the API (port 4200) and the web server (port 3000), forwards SIGTERM to both, and exits with an error when either process exits, so the container restarts instead of running half. The web server's `API_URL` defaults to `http://127.0.0.1:4200`. Both ports are exposed: 3000 for the UI and 4200 for the API and MCP. `FILE_STORAGE_DIR` defaults to `/data/files`, declared as a volume and owned by the runtime user. A `HEALTHCHECK` calls `/api/health`. `.dockerignore` keeps `node_modules`, build output, `.env` files and `.git` out of the context.

Startup. With `DB_MIGRATE_ON_START=true` (the default in the image) the API runs pending migrations before listening; a failed migration stops the container with a clear message. Missing or invalid configuration stops it with the variable name, never the value.

Compose. `docker-compose.yml` keeps the `db` service for development and adds an `app` service under a profile (`docker compose --profile app up`) that builds the image, depends on a healthy `db`, mounts a named volume at `/data/files`, reads secrets from an `.env` file, and publishes 3000 and 4200.

CI. The CI workflow also builds the image on pull requests and on `main` (no push), and runs a smoke test: start the `app` profile against the compose database with test secrets and a fake or dummy embedding configuration, wait for the health check, verify `/api/health` reports `db: 'ok'`, that the UI login page loads on 3000, and that `/mcp` answers 401 without a key.

Docs. The README gets a "Run with Docker" section (required variables, generating the admin password hash and secrets, volumes, ports, upgrading with migrations, backing up the database and the files volume) and a short note on putting both ports behind a reverse proxy with TLS, with `/mcp` routed to the API port without response buffering. `AGENTS.md` section 10 is updated.

## Acceptance criteria

- AC-1: A multi-stage `Dockerfile` builds one image with both apps, runs as a non-root user with `tini`, exposes 3000 and 4200, declares `/data/files` as a volume, and has a health check on `/api/health`.
- AC-2: The entrypoint runs the API and the web server together, forwards SIGTERM to both and exits non-zero when either exits.
- AC-3: With `DB_MIGRATE_ON_START=true` migrations run before the API listens; failed migrations and invalid configuration stop the container with a clear message that never prints secret values.
- AC-4: `docker compose --profile app up` builds and runs Seshat against the compose database with a named files volume and secrets from `.env`.
- AC-5: `.dockerignore` excludes `node_modules`, build output, `.env` files and `.git`.
- AC-6: CI builds the image and a smoke test confirms a healthy database check, the login page on 3000 and a 401 from `/mcp` without a key.
- AC-7: The README documents running with Docker, required configuration, secrets generation, volumes, ports, upgrades, backups and reverse-proxy setup for `/mcp`, and `AGENTS.md` section 10 is updated.

## Out of scope

- Publishing images to a registry, Kubernetes manifests and hosted deployment.
- Splitting the API and UI into separate images.
- TLS termination inside the container.

## Open questions

None.
