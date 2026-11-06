#!/usr/bin/env node
// Bounded smoke test of the real app profile (API + web + database) built from this checkout. Needs Docker with
// Compose >= 2.24. Run: pnpm test:smoke   (CI runs it after building the image; nothing is pushed to a registry.)
//
// Isolated from any other database: a unique Compose project, random free host ports, a temporary project directory
// with a copy of docker-compose.yml, and a `.env` with throwaway secrets (mode 0600, removed on exit). Never prints
// resolved configuration or environment values; failure diagnostics are log tails with every secret redacted.
//
// It asserts, with no skips and no stand-in routes:
//   - the container becomes healthy within a bounded time
//   - API GET /api/health -> 200 with db exactly 'ok'
//   - web GET /login -> 200 HTML
//   - web GET /api/health (same-origin Next rewrite) reaches the API -> same body as the API
//   - API GET /mcp without a key -> 401 + `WWW-Authenticate: Bearer` from the real MCP transport (while an unknown
//     path on the same port is a 404, so the 401 is not a catch-all), also with an invalid Bearer key.
// SMOKE_PROJECT and SMOKE_DIR may be set so an outer always-run cleanup step can find the resources.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PROJECT = process.env.SMOKE_PROJECT || `seshat-smoke-${process.pid}`;
const DIR = process.env.SMOKE_DIR || path.join(os.tmpdir(), `seshat-smoke-${process.pid}`);
const HEALTHY_TIMEOUT_MS = Number(process.env.SMOKE_HEALTHY_TIMEOUT_MS || 180000);
const rand = (n = 24) => randomBytes(n).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const compose = (args) => spawnSync('docker', ['compose', '-p', PROJECT, '-f', 'docker-compose.yml', '-f', 'override.yml', ...args], { cwd: DIR, encoding: 'utf8' });
async function request(url, headers = {}) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000), redirect: 'manual' });
    return { status: r.status, headers: r.headers, text: await r.text() };
  } catch { return { status: 0, headers: new Headers(), text: '' }; }
}
async function waitFor(fn, ms, what) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(1000); } throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`); }

// Throwaway secrets. The hash has the argon2id shape (checked by shape only at startup; nobody logs in here) and is
// single-quoted in the env file so Compose does not expand its `$`.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$' + Buffer.from(rand(16)).toString('base64').replace(/=/g, '') + '$' + Buffer.from(rand(32)).toString('base64').replace(/=/g, '');
const secrets = { dbPassword: rand(16), session: rand(), pepper: rand(), openai: `throwaway-${rand(8)}`, mcpKey: `sk_seshat_${rand(4)}_${rand(16)}` };
const redact = (text) => [...Object.values(secrets), HASH].reduce((t, s) => t.split(s).join('***'), text);

function cleanup() {
  compose(['--profile', 'app', 'down', '-v', '--remove-orphans', '--rmi', 'local']);
  rmSync(DIR, { recursive: true, force: true });
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(true); console.log(`ok   ${name}`); }
  catch (e) { results.push(false); console.log(`FAIL ${name}: ${redact(String(e.message)).split('\n')[0]}`); }
}

let fatal;
try {
  const webPort = await freePort();
  const apiPort = await freePort();
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  copyFileSync(path.join(REPO, 'docker-compose.yml'), path.join(DIR, 'docker-compose.yml'));
  // Build from this checkout; the db service publishes no host port (override), so an existing database on 5432 is untouched.
  writeFileSync(path.join(DIR, 'override.yml'), `services:\n  app:\n    build:\n      context: ${JSON.stringify(REPO)}\n  db:\n    ports: !reset []\n`);
  let env = readFileSync(path.join(REPO, '.env.example'), 'utf8');
  const values = { ADMIN_PASSWORD_HASH: `'${HASH}'`, SESSION_SECRET: secrets.session, API_KEY_PEPPER: secrets.pepper, OPENAI_API_KEY: secrets.openai };
  for (const [k, v] of Object.entries(values)) env = env.replace(new RegExp(`^${k}=.*$`, 'm'), () => `${k}=${v}`);
  env += `\nPOSTGRES_PASSWORD=${secrets.dbPassword}\nSESHAT_WEB_PORT=${webPort}\nSESHAT_API_PORT=${apiPort}\n`;
  writeFileSync(path.join(DIR, '.env'), env, { mode: 0o600 });

  const up = compose(['--profile', 'app', 'up', '-d', '--build']);
  assert.equal(up.status, 0, `compose up failed: ${redact(up.stderr || '').replace(/\s+/g, ' ').slice(-600)}`);

  await waitFor(() => {
    const h = compose(['ps', 'app', '--format', '{{.Health}}']).stdout.trim();
    const s = compose(['ps', 'app', '--format', '{{.State}}']).stdout.trim();
    if (s && s !== 'running' && s !== 'restarting') throw new Error(`app container is ${s}`);
    return h === 'healthy';
  }, HEALTHY_TIMEOUT_MS, 'the app container to become healthy');
  console.log('ok   container healthy');

  const api = `http://127.0.0.1:${apiPort}`;
  const web = `http://127.0.0.1:${webPort}`;
  await check('API /api/health is 200 with db exactly "ok"', async () => {
    const r = await request(`${api}/api/health`);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).db, 'ok');
  });
  await check('web /login serves the login page HTML', async () => {
    const r = await request(`${web}/login`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    assert.match(r.text, /<html/i);
  });
  await check('web same-origin /api/health proxy reaches the API', async () => {
    const direct = await request(`${api}/api/health`);
    const proxied = await request(`${web}/api/health`);
    assert.equal(proxied.status, 200);
    assert.deepEqual(JSON.parse(proxied.text), JSON.parse(direct.text));
    assert.equal(JSON.parse(proxied.text).db, 'ok');
  });
  await check('API /mcp answers 401 without a key (real transport, not a catch-all)', async () => {
    const missing = await request(`${api}/mcp`);
    assert.equal(missing.status, 401);
    assert.match(missing.headers.get('www-authenticate') || '', /^Bearer/i);
    const bogus = await request(`${api}/mcp`, { Authorization: `Bearer ${secrets.mcpKey}` });
    assert.equal(bogus.status, 401);
    assert.equal(bogus.text.includes(secrets.mcpKey), false, 'response echoes the key');
    // An unknown path must not be a 401: proves 401 comes from the MCP route's own authentication.
    const unknown = await request(`${api}/definitely-not-a-route-${rand(4)}`, { Authorization: `Bearer ${secrets.mcpKey}` });
    assert.notEqual(unknown.status, 401);
  });
  await check('/mcp is not served through the web UI rewrite', async () => {
    const r = await request(`${web}/mcp`);
    assert.notEqual(r.status, 401);
  });
} catch (e) {
  fatal = e;
  console.log(`aborted: ${redact(String(e.message)).split('\n')[0]}`);
  const logs = compose(['--profile', 'app', 'logs', '--no-color', '--tail', '60']);
  console.log('--- sanitized logs (last 60 lines per service) ---');
  console.log(redact(`${logs.stdout}${logs.stderr}`));
} finally {
  cleanup();
}
const failed = results.filter((r) => !r).length;
console.log(fatal || failed ? `smoke failed (${failed} check(s) failed${fatal ? ', aborted' : ''})` : `smoke passed (${results.length} checks + container health)`);
process.exit(fatal || failed ? 1 : 0);
