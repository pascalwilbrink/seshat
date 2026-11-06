// Static checks of docker-compose.yml and .env.example (no Docker daemon needed). Runtime: `pnpm test:compose`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');
const compose = read('docker-compose.yml');
const example = read('.env.example');
const config = read('apps/api/src/config/app-config.ts');

describe('docker-compose.yml', () => {
  it('keeps the db service, pgdata volume and adds a health check', () => {
    assert.match(compose, /image: pgvector\/pgvector:pg17/);
    assert.match(compose, /pgdata:\/var\/lib\/postgresql\/data/);
    assert.match(compose, /pg_isready/);
  });
  it('runs the app only under the app profile, after a healthy db, with a files volume', () => {
    assert.match(compose, /profiles: \['app'\]/);
    assert.match(compose, /condition: service_healthy/);
    assert.match(compose, /files:\/data\/files/);
    assert.match(compose, /:3000'/);
    assert.match(compose, /:4200'/);
  });
  it('points DATABASE_URL at the db host and reads secrets from an optional root .env', () => {
    assert.match(compose, /DATABASE_URL: postgres:\/\/[^\n]*@db:5432\//);
    assert.ok(!/localhost/.test(compose.split('\n').filter((l) => /^\s*DATABASE_URL:/.test(l)).join('\n')));
    assert.match(compose, /path: \.env\n\s+required: false/);
  });
  it('does not contain secrets', () => {
    assert.ok(!/(SESSION_SECRET|API_KEY_PEPPER|ADMIN_PASSWORD_HASH|OPENAI_API_KEY)/.test(compose));
  });
});

describe('.env.example', () => {
  it('single-quotes the hash placeholder', () => {
    assert.match(example, /^ADMIN_PASSWORD_HASH='[^'$]*'$/m);
  });
  it('mentions every variable the API validates (except PORT, DATABASE_URL and the test-only ones)', () => {
    const names = new Set([...config.matchAll(/get\('([A-Z_]+)'\)/g)].map((m) => m[1]));
    for (const n of ['EMBEDDING_MODEL', 'EMBEDDING_DIMENSION']) names.add(n);
    for (const n of ['PORT', 'DATABASE_URL', 'NODE_ENV']) names.delete(n);
    assert.ok(names.size > 8);
    for (const n of names) assert.match(example, new RegExp(`^#? ?${n}=`, 'm'), n);
  });
  it('has placeholders only, no real-looking secrets', () => {
    assert.ok(!/\$argon2id\$/.test(example));
    assert.match(example, /^OPENAI_API_KEY=replace-me$/m);
  });
});
