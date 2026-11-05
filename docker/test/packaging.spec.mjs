// Static checks of the packaging files (no Docker daemon needed). Runtime checks: `pnpm test:container`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');
const dockerfile = read('Dockerfile');
const ignore = read('.dockerignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

describe('Dockerfile', () => {
  it('is multi-stage, frozen-lockfile, with tini and a non-root runtime user', () => {
    assert.ok((dockerfile.match(/^FROM /gm) || []).length >= 2);
    assert.match(dockerfile, /pnpm install --frozen-lockfile/);
    assert.match(dockerfile, /apt-get install[^\n]*tini/);
    assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/tini", "--", "node", "\/app\/docker\/entrypoint\.mjs"\]/);
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('AS runtime'));
    assert.match(runtime, /^USER node$/m);
    assert.ok(runtime.indexOf('USER node') < runtime.indexOf('ENTRYPOINT'));
  });
  it('sets production defaults, ports, an owned volume and a bounded health check', () => {
    for (const e of ['NODE_ENV=production', 'DB_MIGRATE_ON_START=true', 'FILE_STORAGE_DIR=/data/files', 'API_URL=http://127.0.0.1:4200']) assert.ok(dockerfile.includes(e), e);
    assert.match(dockerfile, /EXPOSE 3000 4200/);
    assert.ok(dockerfile.indexOf('chown -R node:node /data') < dockerfile.indexOf('VOLUME ["/data/files"]'));
    assert.match(dockerfile, /HEALTHCHECK --interval=\S+ --timeout=\S+/);
    assert.match(dockerfile, /127\.0\.0\.1:4200\/api\/health/);
    assert.match(dockerfile, /AbortSignal\.timeout/);
  });
  it('ships the production closure, not the builder tree or sources, and takes no secrets', () => {
    assert.match(dockerfile, /pnpm --filter @seshat\/api deploy --prod/);
    assert.ok(!/COPY --from=build [^\n]*node_modules/.test(dockerfile.replace(/\/out\/api\//g, '')));
    assert.ok(!/ARG [A-Z_]*(SECRET|PASSWORD|HASH|PEPPER|KEY|TOKEN)/.test(dockerfile));
    assert.ok(!/ENV [^\n]*(SECRET|PASSWORD|HASH|PEPPER)/.test(dockerfile));
  });
});

describe('.dockerignore', () => {
  it('excludes recursive node_modules, build output, env files (nested variants) and .git', () => {
    for (const p of ['.git', '**/node_modules', '**/dist', '**/.next', '**/.env', '**/.env.*']) assert.ok(ignore.includes(p), p);
    assert.ok(ignore.includes('!**/.env.example'));
  });
  it('keeps what the build needs', () => {
    for (const p of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'docker/entrypoint.mjs']) {
      assert.ok(!ignore.some((i) => i === p || i === `${p}/`), `${p} is ignored`);
    }
    assert.ok(!ignore.includes('docker') && !ignore.includes('apps') && !ignore.includes('packages'));
  });
});

describe('web standalone output', () => {
  it('is enabled with monorepo tracing and the rewrites stay build-time', () => {
    const cfg = read('apps/web/next.config.ts');
    assert.match(cfg, /output: 'standalone'/);
    assert.match(cfg, /outputFileTracingRoot/);
    assert.match(cfg, /apiRewrites\(\)/);
  });
});
