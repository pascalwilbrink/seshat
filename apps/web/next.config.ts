import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { apiRewrites } from './lib/api-target';

const config: NextConfig = {
  // Only used by the proxy smoke test so it does not clobber a developer's .next directory.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Self-contained server (`.next/standalone/apps/web/server.js`) for the container image. `next dev`, `next build` and
  // `next start` behave as before.
  output: 'standalone',
  // Trace from the monorepo root so the standalone output includes the workspace package @seshat/domain.
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  async rewrites() {
    // Evaluated at build time: the standalone server proxies to the API_URL present during `next build`.
    return apiRewrites();
  },
};

export default config;
