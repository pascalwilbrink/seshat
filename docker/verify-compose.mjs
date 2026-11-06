#!/usr/bin/env node
// Runnable verification of docker-compose.yml (needs a Docker daemon and Compose >= 2.24). Run: pnpm test:compose
// Uses an isolated project name and a temporary project directory holding a copy of the compose file and a `.env`
// derived from .env.example with throwaway generated secrets. Never touches the developer's `.env` or volumes, never
// prints resolved configuration or environment values; failures show only sanitized log excerpts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PROJECT = `seshat-compose-verify-${process.pid}`;
const DIR = mkdtempSync(path.join(os.tmpdir(), 'seshat-compose-'));
const rand = (n = 24) => randomBytes(n).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const compose = (args, opts = {}) =>
  spawnSync('docker', ['compose', '-p', PROJECT, '-f', 'docker-compose.yml', '-f', 'override.yml', ...args], { cwd: DIR, encoding: 'utf8', ...opts });
const ok = (r, what) => assert.equal(r.status, 0, `${what} failed: ${(r.stderr || '').replace(/\s+/g, ' ').slice(-400)}`);
const http = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); return { status: r.status, text: await r.text() }; } catch { return { status: 0, text: '' }; } };
async function waitFor(fn, ms, what) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(1000); } throw new Error(`timed out: ${what}`); }
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(true); console.log(`ok   ${name}`); } catch (e) { results.push(false); console.log(`FAIL ${name}: ${String(e.message).split('\n')[0]}`); }
}

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$' + Buffer.from(rand(16)).toString('base64').replace(/=/g, '') + '$' + Buffer.from(rand(32)).toString('base64').replace(/=/g, '');
const webPort = await freePort();
const apiPort = await freePort();
const dbPort = await freePort();
copyFileSync(path.join(REPO, 'docker-compose.yml'), path.join(DIR, 'docker-compose.yml'));
writeFileSync(path.join(DIR, 'override.yml'), `services:\n  app:\n    build:\n      context: ${JSON.stringify(REPO)}\n`);
// Derive .env from the checked-in template: replace the placeholder lines, keep everything else.
const dbPassword = rand(16);
const secrets = {
  ADMIN_PASSWORD_HASH: `'${HASH}'`, SESSION_SECRET: rand(), API_KEY_PEPPER: rand(), OPENAI_API_KEY: `throwaway-${rand(8)}`,
};
let env = readFileSync(path.join(REPO, '.env.example'), 'utf8');
for (const [k, v] of Object.entries(secrets)) env = env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`);
env += `\nPOSTGRES_PASSWORD=${dbPassword}\nSESHAT_WEB_PORT=${webPort}\nSESHAT_API_PORT=${apiPort}\nDB_HOST_PORT=${dbPort}\n`;

const files = (cmd) => compose(['exec', '-T', 'app', 'sh', '-c', cmd]);
const cleanup = () => { compose(['--profile', 'app', 'down', '-v', '--remove-orphans', '--rmi', 'local']); rmSync(DIR, { recursive: true, force: true }); };
process.on('exit', () => { try { cleanup(); } catch { /* best effort */ } });

try {
  await check('db-only: config valid with no .env, only db defined, app profile adds app', async () => {
    ok(compose(['config', '--quiet']), 'config');
    assert.equal(compose(['config', '--services']).stdout.trim(), 'db');
    ok(compose(['--profile', 'app', 'config', '--quiet']), 'config --profile app');
    assert.deepEqual(compose(['--profile', 'app', 'config', '--services']).stdout.trim().split('\n').sort(), ['app', 'db']);
  });
  await check('db-only: up -d db becomes healthy and starts no app', async () => {
    ok(compose(['up', '-d', '--wait', '--wait-timeout', '90', 'db']), 'up db');
    assert.equal(compose(['ps', '--services']).stdout.trim(), 'db');
  });

  writeFileSync(path.join(DIR, '.env'), env, { mode: 0o600 });
  const up = compose(['--profile', 'app', 'up', '-d', '--build']);
  await check('app profile: builds and starts after db is healthy', async () => ok(up, 'up --profile app'));
  await check('app: container healthy', async () => {
    await waitFor(() => compose(['ps', 'app', '--format', '{{.Health}}']).stdout.trim() === 'healthy', 150000, 'app healthy');
  });
  await check('app: API health reports db ok on the published port', async () => {
    const r = await http(`http://127.0.0.1:${apiPort}/api/health`);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).db, 'ok');
  });
  await check('app: UI login page on the published port', async () => {
    const r = await http(`http://127.0.0.1:${webPort}/login`);
    assert.equal(r.status, 200);
    assert.match(r.text, /<html/i);
  });
  await check('app: DATABASE_URL targets the compose host, not localhost (checked without printing it)', async () => {
    const r = files('node -e "const u=new URL(process.env.DATABASE_URL);process.exit(u.hostname===\'db\'?0:1)"');
    assert.equal(r.status, 0);
  });
  await check('app: dollar-containing hash arrives unchanged (compared by SHA-256, not printed)', async () => {
    const r = files('printf %s "$ADMIN_PASSWORD_HASH" | sha256sum');
    const want = spawnSync('sha256sum', { input: HASH, encoding: 'utf8' }).stdout.split(' ')[0];
    assert.equal(r.stdout.split(' ')[0], want);
  });
  await check('app: files volume is writable by the non-root user and survives recreation', async () => {
    assert.notEqual(files('id -u').stdout.trim(), '0');
    ok(files('echo persisted > /data/files/.verify-marker'), 'write marker');
    ok(compose(['--profile', 'app', 'up', '-d', '--force-recreate', '--no-deps', 'app']), 'recreate');
    await waitFor(() => compose(['ps', 'app', '--format', '{{.Health}}']).stdout.trim() === 'healthy', 150000, 'app healthy again');
    assert.equal(files('cat /data/files/.verify-marker').stdout.trim(), 'persisted');
  });
  await check('app: secrets are not in the image', async () => {
    const r = spawnSync('docker', ['image', 'inspect', 'seshat:local', '--format', '{{json .Config.Env}}'], { encoding: 'utf8' });
    for (const v of [secrets.SESSION_SECRET, secrets.API_KEY_PEPPER, dbPassword]) assert.ok(!r.stdout.includes(v));
  });
} finally {
  cleanup();
}
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} check(s) failed` : 'all compose checks passed');
process.exit(failed ? 1 : 0);
