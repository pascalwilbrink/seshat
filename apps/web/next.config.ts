import type { NextConfig } from 'next';
import { apiRewrites } from './lib/api-target';

const config: NextConfig = {
  // Only used by the proxy smoke test so it does not clobber a developer's .next directory.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  async rewrites() {
    return apiRewrites();
  },
};

export default config;
