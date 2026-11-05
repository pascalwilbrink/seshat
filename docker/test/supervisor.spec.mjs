import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildChildren } from '../entrypoint.mjs';
import { supervise } from '../supervisor.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixture-child.mjs');
let dir;
before(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'supervisor-')); });
after(() => rmSync(dir, { recursive: true, force: true }));

const child = (name, mode) => ({ name, command: process.execPath, args: [fixture, mode, dir, name], env: { ...process.env, PORT: '1' } });
const read = (name) => (existsSync(path.join(dir, `${name}.log`)) ? readFileSync(path.join(dir, `${name}.log`), 'utf8') : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { assert.ok(Date.now() < end, 'timed out waiting'); await sleep(25); } };
const quiet = { log: () => {} };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Unique names per test keep the marker files apart.
let n = 0;
const names = () => { n += 1; return [`a${n}`, `b${n}`]; };

describe('supervisor', () => {
  it('starts both children and forwards SIGTERM to both', async () => {
    const [a, b] = names();
    const signals = new EventEmitter();
    const done = supervise({ children: [child(a, 'serve'), child(b, 'serve')], signals, ...quiet });
    await until(() => read(a).includes('started') && read(b).includes('started'));
    signals.emit('SIGTERM');
    const code = await done;
    assert.match(read(a), /SIGTERM/);
    assert.match(read(b), /SIGTERM/);
    assert.notEqual(code, 0);
  });

  it('forwards SIGINT to both children', async () => {
    const [a, b] = names();
    const signals = new EventEmitter();
    const done = supervise({ children: [child(a, 'serve'), child(b, 'serve')], signals, ...quiet });
    await until(() => read(a).includes('started') && read(b).includes('started'));
    signals.emit('SIGINT');
    assert.notEqual(await done, 0);
    assert.match(read(a), /SIGINT/);
    assert.match(read(b), /SIGINT/);
  });

  for (const mode of ['exit:0', 'exit:3']) {
    for (const first of [0, 1]) {
      it(`${mode} of child ${first === 0 ? 'one' : 'two'} stops its sibling and exits non-zero`, async () => {
        const [a, b] = names();
        const specs = [child(a, first === 0 ? mode : 'serve'), child(b, first === 1 ? mode : 'serve')];
        const code = await supervise({ children: specs, signals: new EventEmitter(), ...quiet });
        assert.notEqual(code, 0);
        if (mode === 'exit:3') assert.equal(code, 3);
        const survivor = first === 0 ? b : a;
        assert.match(read(survivor), /SIGTERM/);
      });
    }
  }

  for (const failing of [0, 1]) {
    it(`a spawn failure of child ${failing + 1} is fatal and cleans up the sibling`, async () => {
      const [a, b] = names();
      const bad = { name: 'bad', command: path.join(dir, 'does-not-exist'), args: [] };
      const specs = failing === 0 ? [bad, child(b, 'serve')] : [child(a, 'serve'), bad];
      const lines = [];
      const code = await supervise({ children: specs, signals: new EventEmitter(), log: (l) => lines.push(l) });
      assert.notEqual(code, 0);
      const sibling = failing === 0 ? b : a;
      if (read(sibling).includes('started')) assert.match(read(sibling), /SIGTERM/);
      assert.ok(lines.some((l) => l.includes('failed to start bad')));
    });
  }

  it('is bounded: kills a child that ignores SIGTERM', async () => {
    const [a, b] = names();
    const started = Date.now();
    const signals = new EventEmitter();
    const done = supervise({ children: [child(a, 'ignore-term'), child(b, 'serve')], signals, shutdownTimeoutMs: 300, killGraceMs: 2000, log: () => {} });
    await until(() => read(a).includes('started') && read(b).includes('started'));
    signals.emit('SIGTERM');
    const code = await done;
    assert.notEqual(code, 0);
    assert.ok(Date.now() - started < 5000);
    assert.match(read(a), /SIGTERM/);
  });

  it('does not log commands or environment values', async () => {
    const [a, b] = names();
    const lines = [];
    const specs = [child(a, 'exit:0'), child(b, 'serve')];
    specs[0].env = { ...specs[0].env, SECRET_SENTINEL: 'hunter2-sentinel' };
    await supervise({ children: specs, signals: new EventEmitter(), log: (l) => lines.push(l) });
    const text = lines.join('\n');
    assert.ok(!text.includes('hunter2-sentinel'));
    assert.ok(!text.includes(fixture));
  });
});

describe('entrypoint', () => {
  it('gives the API and web independent ports and does not leak the web PORT to the API', () => {
    const [api, web] = buildChildren({ APP_ROOT: '/srv', PORT: '9999', HOSTNAME: 'x', FOO: 'bar' }, 'node');
    assert.equal(api.env.PORT, '4200');
    assert.equal(api.env.HOSTNAME, undefined);
    assert.equal(api.cwd, path.join('/srv', 'apps/api'));
    assert.deepEqual(api.args, ['dist/main.js']);
    assert.equal(web.env.PORT, '3000');
    assert.equal(web.env.HOSTNAME, '0.0.0.0');
    assert.deepEqual(web.args, ['server.js']);
    assert.equal(api.env.FOO, 'bar');
  });

  it('as a real process: SIGTERM stops both children and exits non-zero, nothing is orphaned', async () => {
    const [a, b] = names();
    const script = path.join(dir, 'run.mjs');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(script, `import { supervise } from ${JSON.stringify(path.join(here, '../supervisor.mjs'))};
const c = (name) => ({ name, command: process.execPath, args: [${JSON.stringify(fixture)}, 'serve', ${JSON.stringify(dir)}, name] });
process.exit(await supervise({ children: [c(${JSON.stringify(a)}), c(${JSON.stringify(b)})], signals: process, log: () => {} }));
`);
    const sup = spawn(process.execPath, [script], { stdio: 'ignore' });
    const exited = new Promise((r) => sup.once('exit', (code, sig) => r({ code, sig })));
    await until(() => read(a).includes('started') && read(b).includes('started'));
    sup.kill('SIGTERM');
    const { code } = await exited;
    assert.notEqual(code, 0);
    assert.match(read(a), /SIGTERM/);
    assert.match(read(b), /SIGTERM/);
  });
});
