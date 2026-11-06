# syntax=docker/dockerfile:1
# One image running the API (4200) and the Next.js web server (3000) under tini and docker/entrypoint.mjs.
# Build: docker build -t seshat .   No secrets are needed or accepted at build time.

ARG NODE_VERSION=22

# ---- build: frozen install, the existing recursive build, production closure of the API ----
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /repo
# The pnpm version comes from "packageManager" in package.json (corepack).
RUN corepack enable
ENV NEXT_TELEMETRY_DISABLED=1 \
    CI=true
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
# Next.js captures rewrites at build time, so the web server's proxy target is fixed here (not a build secret). Both
# processes run in the same container; there is no runtime override for it.
ARG API_URL=http://127.0.0.1:4200
ENV API_URL=${API_URL}
# Public MCP address shown on the Workspace MCP page; inlined into the web bundle at build time (not a secret).
ARG NEXT_PUBLIC_SESHAT_MCP_URL=http://localhost:4200/mcp
ENV NEXT_PUBLIC_SESHAT_MCP_URL=${NEXT_PUBLIC_SESHAT_MCP_URL}
RUN pnpm build \
 && mkdir -p apps/web/public
# Production dependency closure of the API (workspace package @seshat/domain included, no dev tooling) plus its build output.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @seshat/api deploy --prod --legacy /out/api \
 && rm -rf /out/api/dist && cp -r apps/api/dist /out/api/dist \
 && rm -rf /out/api/src /out/api/test /out/api/scripts /out/api/vitest.config.ts /out/api/tsconfig.json

# ---- runtime ----
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    APP_ROOT=/app \
    DB_MIGRATE_ON_START=true \
    FILE_STORAGE_DIR=/data/files \
    API_URL=http://127.0.0.1:4200
WORKDIR /app
COPY --from=build --chown=root:root /out/api/ apps/api/
COPY --from=build --chown=root:root /repo/apps/web/.next/standalone/ ./
COPY --from=build --chown=root:root /repo/apps/web/.next/static apps/web/.next/static
COPY --from=build --chown=root:root /repo/apps/web/public apps/web/public
COPY --chown=root:root docker/entrypoint.mjs docker/supervisor.mjs docker/
# Application files are root-owned and read-only for the runtime user; only the data directory is writable.
RUN mkdir -p /data/files && chown -R node:node /data
USER node
VOLUME ["/data/files"]
EXPOSE 3000 4200
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4200/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/docker/entrypoint.mjs"]
