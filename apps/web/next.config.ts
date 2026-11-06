import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { apiRewrites } from './lib/api-target';

// Uploads go through the `/api/*` rewrite, which buffers request bodies up to `proxyClientMaxBodySize` (Next.js default:
// 10 MB, larger bodies are cut off and the proxied request fails). Allow the API's upload limit plus multipart overhead.
// Evaluated at build time like the rewrites: set MAX_UPLOAD_BYTES during `next build` if the API uses a non-default limit.
const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const configuredUpload = Number(process.env.MAX_UPLOAD_BYTES);
const maxUploadBytes = Number.isSafeInteger(configuredUpload) && configuredUpload > 0 ? configuredUpload : DEFAULT_MAX_UPLOAD_BYTES;

const config: NextConfig = {
  experimental: {
    proxyClientMaxBodySize: maxUploadBytes + MULTIPART_OVERHEAD_BYTES,
  },
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
