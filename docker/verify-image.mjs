#!/usr/bin/env node
// Runnable verification of the production image. Needs a Docker daemon; builds the image unless IMAGE is given.
//   node docker/verify-image.mjs            (or: pnpm test:container)
// Uses throwaway generated secrets and an isolated network/containers (prefix "seshat-verify-"). Never prints resolved
// environments; failures show only sanitized log excerpts. Production code has no hooks for this: it only uses
// documented environment variables.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';

const IMAGE = process.env.IMAGE || 'seshat-verify:local';
const RUN = `seshat-verify-${process.pid}`;
const NET = `${RUN}-net`;
const SENTINEL = `SENTINEL-${randomBytes(6).toString('hex')}`;
const sh = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', ...opts });
const ok = (r, what) => assert.equal(r.status, 0, `${what} failed: ${(r.stderr || r.stdout || '').slice(0, 400)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n = 24) => randomBytes(n).toString('hex');
const results = [];
async function check(name, fn) {
  try { await fn(); results.push([name, true]); console.log(`ok   ${name}`); }
  catch (e) { results.push([name, false]); console.log(`FAIL ${name}: ${String(e.message).split('\n')[0]}`); }
}
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
async function http(url, ms = 3000) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'manual' }); return { status: r.status, text: await r.text() }; }
  catch { return { status: 0, text: '' }; }
}
async function waitFor(fn, ms, what) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(500); } throw new Error(`timed out: ${what}`); }
const exited = (name) => sh(['inspect', '-f', '{{.State.Status}}|{{.State.ExitCode}}', name]).stdout.trim().split('|');
const logs = (name) => { const r = sh(['logs', name]); return `${r.stdout}${r.stderr}`; };
const rm = (name) => sh(['rm', '-f', '-v', name]);

// A real argon2id hash shape (validated by shape only at startup; no login happens here).
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$' + Buffer.from(rand(16)).toString('base64').replace(/=/g, '') + '$' + Buffer.from(rand(32)).toString('base64').replace(/=/g, '');
const baseEnv = (dbUrl) => ({
  DATABASE_URL: dbUrl, ADMIN_USERNAME: 'verify', ADMIN_PASSWORD_HASH: HASH,
  SESSION_SECRET: rand(), API_KEY_PEPPER: rand(), OPENAI_API_KEY: `${SENTINEL}-openai`,
});
const envArgs = (env) => Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
const run = (name, env, extra = []) => sh(['run', '-d', '--name', name, '--network', NET, ...extra, ...envArgs(env), IMAGE]);
const waitExit = (name, ms = 90000) => waitFor(async () => { const [s, c] = exited(name); return s === 'exited' ? Number(c) : null; }, ms, `${name} exit`);
const psql = (sql, db = 'seshat') => sh(['exec', `${RUN}-db`, 'psql', '-U', 'seshat', '-d', db, '-At', '-c', sql]);

async function main() {
  if (sh(['version']).status !== 0) { console.error('Docker daemon not available: cannot verify the image.'); process.exit(2); }
  if (!process.env.IMAGE) ok(sh(['build', '-t', IMAGE, '.'], { stdio: ['ignore', 'ignore', 'inherit'] }), 'docker build');
  ok(sh(['network', 'create', NET]), 'network');
  const dbPass = rand(12);
  ok(sh(['run', '-d', '--name', `${RUN}-db`, '--network', NET, '-e', 'POSTGRES_USER=seshat', '-e', `POSTGRES_PASSWORD=${dbPass}`, '-e', 'POSTGRES_DB=seshat', 'pgvector/pgvector:pg17']), 'db');
  await waitFor(() => psql('select 1').stdout.trim() === '1', 60000, 'database ready');
  const dbUrl = (db = 'seshat', user = 'seshat', pass = dbPass) => `postgres://${user}:${pass}@${RUN}-db:5432/${db}`;

  // --- image inspection ---
  await check('image: non-root user, tini entrypoint, ports, volume, healthcheck, defaults', () => {
    const c = JSON.parse(sh(['image', 'inspect', IMAGE]).stdout)[0].Config;
    assert.ok(c.User && c.User !== 'root' && c.User !== '0', `user is ${c.User}`);
    assert.match(c.Entrypoint.join(' '), /tini/);
    assert.ok('3000/tcp' in c.ExposedPorts && '4200/tcp' in c.ExposedPorts);
    assert.ok('/data/files' in c.Volumes);
    assert.ok(c.Healthcheck && c.Healthcheck.Test.join(' ').includes('/api/health') && c.Healthcheck.Test.join(' ').includes('4200'));
    for (const e of ['NODE_ENV=production', 'DB_MIGRATE_ON_START=true', 'FILE_STORAGE_DIR=/data/files', 'API_URL=http://127.0.0.1:4200']) assert.ok(c.Env.includes(e), `missing ${e}`);
  });
  await check('image contents: no sources, dev tooling, env files or secrets; compiled migrations present', () => {
    const script = [
      'echo uid=$(id -u)',
      'echo apidir=$(ls /app/apps/api | tr "\\n" ",")',
      'echo devtools=$(ls /app/apps/api/node_modules | grep -cE "^(tsx|vitest|typescript)$")',
      'echo envfiles=$(find /app -name ".env*" -not -path "*/node_modules/*" | wc -l)',
      'echo migrations=$(ls /app/apps/api/dist/migrations/*.js | wc -l)',
      'test -f /app/apps/api/node_modules/@seshat/domain/dist/index.js && echo domain=ok',
      'test -d /app/apps/web/.next/static && echo static=ok',
      'test -f /app/apps/web/server.js && echo server=ok',
    ].join('; ');
    const r = sh(['run', '--rm', '--entrypoint', 'sh', IMAGE, '-c', script]);
    ok(r, 'inspect contents');
    const out = Object.fromEntries(r.stdout.trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
    assert.notEqual(out.uid, '0', 'runs as root');
    assert.ok(!/(^|,)(src|test|scripts)(,|$)/.test(out.apidir), `api sources shipped: ${out.apidir}`);
    assert.equal(out.devtools, '0'); assert.equal(out.envfiles, '0');
    assert.ok(Number(out.migrations) > 0);
    assert.equal(out.domain, 'ok'); assert.equal(out.static, 'ok'); assert.equal(out.server, 'ok');
    assert.ok(!r.stdout.includes(SENTINEL));
  });

  // --- startup failures: nonzero exit, named variable/stage, no sentinel, no listen ---
  const failCase = async (label, env, expectRe, extra = []) => check(`startup failure: ${label}`, async () => {
    const name = `${RUN}-f-${label.replace(/\W+/g, '')}`;
    ok(run(name, env, extra), 'run');
    const code = await waitExit(name);
    const out = logs(name);
    assert.notEqual(code, 0, 'exit code is zero');
    assert.match(out, expectRe);
    for (const secret of [SENTINEL, env.SESSION_SECRET, env.API_KEY_PEPPER, env.ADMIN_PASSWORD_HASH, env.DATABASE_URL].filter(Boolean)) {
      assert.ok(!out.includes(secret), 'log leaks a secret value');
    }
    assert.ok(!/successfully started|listening/i.test(out), 'API listened despite failure');
    rm(name);
  });
  const good = baseEnv(dbUrl());
  { const { SESSION_SECRET, ...e } = good; await failCase('missing SESSION_SECRET', e, /SESSION_SECRET/); }
  await failCase('short API_KEY_PEPPER', { ...good, API_KEY_PEPPER: SENTINEL }, /API_KEY_PEPPER/);
  await failCase('invalid ADMIN_PASSWORD_HASH', { ...good, ADMIN_PASSWORD_HASH: `${SENTINEL}-not-a-hash` }, /ADMIN_PASSWORD_HASH/);
  await failCase('invalid DATABASE_URL', { ...good, DATABASE_URL: `not-a-url-${SENTINEL}` }, /DATABASE_URL/);
  await failCase('invalid DB_MIGRATE_ON_START', { ...good, DB_MIGRATE_ON_START: SENTINEL }, /DB_MIGRATE_ON_START/);
  await failCase('unreachable database', { ...good, DATABASE_URL: `postgres://u:${SENTINEL}@127.0.0.1:1/x` }, /Database connection failed/);
  // Deterministic migration failure: a non-superuser owner cannot CREATE EXTENSION vector in a fresh database.
  ok(psql(`create role limited login password '${SENTINEL}-pw'`), 'role');
  ok(psql('create database migfail owner limited'), 'migfail db');
  await failCase('migration failure', { ...good, DATABASE_URL: dbUrl('migfail', 'limited', `${SENTINEL}-pw`) }, /Database migration failed/);

  // --- successful fresh start, health, proxy, volume, repeat start ---
  const apiPort = await freePort(); const webPort = await freePort();
  const app = `${RUN}-app`;
  const compiled = Number(sh(['run', '--rm', '--entrypoint', 'sh', IMAGE, '-c', 'ls /app/apps/api/dist/migrations/*.js | wc -l']).stdout.trim());
  assert.ok(compiled > 0, 'no compiled migrations');
  ok(run(app, good, ['-p', `127.0.0.1:${apiPort}:4200`, '-p', `127.0.0.1:${webPort}:3000`]), 'run app');
  // Poll fast: the first healthy answer must come after every migration is recorded (never listens earlier).
  let premature = false;
  const healthy = await waitFor(async () => {
    const r = await http(`http://127.0.0.1:${apiPort}/api/health`);
    if (r.status === 0) return false;
    if (Number(psql('select count(*) from migrations').stdout.trim() || 0) < compiled) premature = true;
    return r.status === 200 ? r : false;
  }, 120000, 'API health');
  await check('fresh start: API listens only after all compiled migrations ran; health db ok', () => {
    assert.ok(!premature, 'API answered before migrations completed');
    assert.deepEqual(JSON.parse(healthy.text), { status: 'ok', db: 'ok' });
    assert.equal(Number(psql('select count(*) from migrations').stdout.trim()), compiled);
  });
  await check('web: login page and same-origin /api proxy', async () => {
    const login = await waitFor(async () => { const r = await http(`http://127.0.0.1:${webPort}/login`); return r.status === 200 ? r : false; }, 60000, 'login page');
    assert.match(login.text, /<html/i);
    const proxied = await http(`http://127.0.0.1:${webPort}/api/health`);
    assert.equal(proxied.status, 200); assert.deepEqual(JSON.parse(proxied.text), { status: 'ok', db: 'ok' });
  });
  await check('runtime: tini is PID 1, non-root, container health becomes healthy', async () => {
    assert.match(sh(['exec', app, 'sh', '-c', 'cat /proc/1/cmdline | tr "\\0" " "']).stdout, /tini/);
    assert.notEqual(sh(['exec', app, 'id', '-u']).stdout.trim(), '0');
    await waitFor(() => sh(['inspect', '-f', '{{.State.Health.Status}}', app]).stdout.trim() === 'healthy', 90000, 'healthy');
  });
  await check('volume: /data/files is owned by the runtime user and writable', () => {
    const uid = sh(['exec', app, 'id', '-u']).stdout.trim();
    assert.equal(sh(['exec', app, 'stat', '-c', '%u', '/data/files']).stdout.trim(), uid);
    ok(sh(['exec', app, 'sh', '-c', 'echo x > /data/files/.probe && rm /data/files/.probe']), 'write');
  });
  await check('graceful stop: SIGTERM ends the container quickly', () => {
    const t = Date.now(); ok(sh(['stop', '-t', '30', app]), 'stop');
    assert.ok(Date.now() - t < 25000, 'slow shutdown');
    assert.ok(!/Application failed to start/.test(logs(app)));
  });
  await check('repeat start: no pending migrations, still healthy', async () => {
    ok(sh(['start', app]), 'start');
    await waitFor(async () => (await http(`http://127.0.0.1:${apiPort}/api/health`)).status === 200, 120000, 'health after restart');
    assert.equal(Number(psql('select count(*) from migrations').stdout.trim()), compiled);
  });
  rm(app);
}

let fatal;
try { await main(); } catch (e) { fatal = e; console.error(`aborted: ${String(e.message).split('\n')[0]}`); }
finally {
  const ids = sh(['ps', '-aq', '--filter', `name=${RUN}`]).stdout.split('\n').filter(Boolean);
  if (ids.length) sh(['rm', '-f', '-v', ...ids]);
  sh(['network', 'rm', NET]);
}
const failed = results.filter(([, p]) => !p);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(fatal || failed.length ? 1 : 0);
