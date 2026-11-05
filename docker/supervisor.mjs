// Dependency-free two-process supervisor. It runs beneath tini in the container image.
// It never logs commands, arguments or environment values: only child names, exit codes and signals.
import { spawn as nodeSpawn } from 'node:child_process';

const SIGNAL_NUMBERS = { SIGINT: 2, SIGTERM: 15 };

/**
 * @param {object} options
 * @param {{name: string, command: string, args?: string[], cwd?: string, env?: NodeJS.ProcessEnv}[]} options.children
 * @param {{on(sig: string, fn: () => void): unknown, off(sig: string, fn: () => void): unknown}} [options.signals]
 * @param {number} [options.shutdownTimeoutMs] time children get to exit after SIGTERM before SIGKILL
 * @param {number} [options.killGraceMs] time to wait for reaping after SIGKILL before giving up
 * @param {(line: string) => void} [options.log]
 * @param {typeof nodeSpawn} [options.spawn]
 * @returns {Promise<number>} the exit code of the supervisor (non-zero whenever a child stopped)
 */
export function supervise({
  children,
  signals,
  shutdownTimeoutMs = 10_000,
  killGraceMs = 2_000,
  log = (line) => console.error(line),
  spawn = nodeSpawn,
}) {
  return new Promise((resolve) => {
    const running = new Map(); // name -> ChildProcess
    let stopping = false;
    let exitCode = null;
    let killTimer;
    let giveUpTimer;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      clearTimeout(giveUpTimer);
      for (const sig of Object.keys(SIGNAL_NUMBERS)) signals?.off(sig, handlers[sig]);
      resolve(exitCode && exitCode !== 0 ? exitCode : 1);
    };

    const signalAll = (sig) => {
      for (const child of running.values()) {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    };

    const maybeDone = () => {
      if (running.size === 0) finish();
    };

    const stop = (code, sig = 'SIGTERM') => {
      if (exitCode === null) exitCode = code;
      if (stopping) return;
      stopping = true;
      if (running.size === 0) return finish();
      signalAll(sig);
      killTimer = setTimeout(() => {
        log(`supervisor: shutdown timed out after ${shutdownTimeoutMs}ms, killing remaining children`);
        signalAll('SIGKILL');
        giveUpTimer = setTimeout(() => {
          log('supervisor: children did not exit after SIGKILL, giving up');
          finish();
        }, killGraceMs);
        giveUpTimer.unref?.();
      }, shutdownTimeoutMs);
      killTimer.unref?.();
    };

    const handlers = {};
    for (const sig of Object.keys(SIGNAL_NUMBERS)) {
      handlers[sig] = () => {
        log(`supervisor: received ${sig}, stopping children`);
        stop(128 + SIGNAL_NUMBERS[sig], sig);
      };
      signals?.on(sig, handlers[sig]);
    }

    for (const spec of children) {
      if (stopping) break;
      let child;
      try {
        child = spawn(spec.command, spec.args ?? [], { cwd: spec.cwd, env: spec.env, stdio: 'inherit' });
      } catch {
        log(`supervisor: failed to start ${spec.name}`);
        stop(1);
        break;
      }
      running.set(spec.name, child);
      let settled = false;
      const onGone = (code, signal, spawnFailed) => {
        if (settled) return;
        settled = true;
        running.delete(spec.name);
        if (spawnFailed) log(`supervisor: failed to start ${spec.name}`);
        else if (!stopping) log(`supervisor: ${spec.name} exited (${signal ? `signal ${signal}` : `code ${code}`}), stopping the other process`);
        // The first child to stop decides the status; a clean exit still counts as a failure.
        const status = spawnFailed ? 1 : signal ? 128 + (SIGNAL_NUMBERS[signal] ?? 1) : code || 1;
        stop(status);
        maybeDone();
      };
      child.once('error', () => onGone(null, null, true));
      child.once('exit', (code, signal) => onGone(code, signal, false));
    }
    // A spawn failure may be reported asynchronously; children already listed above are cleaned up by stop().
    if (running.size === 0 && !stopping) finish();
  });
}
