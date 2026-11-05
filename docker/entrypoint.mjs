#!/usr/bin/env node
// Container entrypoint (runs beneath tini): starts the API and the Next standalone web server.
//
// Runtime conventions for the image:
//   APP_ROOT (default /app) holds the build output
//   API:  cwd $APP_ROOT/apps/api, command `node dist/main.js`, PORT=4200
//   Web:  cwd $APP_ROOT/apps/web, command `node server.js` (Next standalone, monorepo layout), PORT=3000, HOSTNAME=0.0.0.0
// The two processes get independent PORT settings: the web PORT never reaches the API.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supervise } from './supervisor.mjs';

export function buildChildren(env = process.env, execPath = process.execPath) {
  const root = env.APP_ROOT || '/app';
  const apiPort = env.API_PORT || '4200';
  const webPort = env.WEB_PORT || '3000';
  const webHost = env.WEB_HOSTNAME || '0.0.0.0';
  // Supervisor-only settings are not passed on; PORT/HOSTNAME are set per child.
  const { PORT: _port, HOSTNAME: _host, API_PORT: _a, WEB_PORT: _w, WEB_HOSTNAME: _h, ...base } = env;
  return [
    { name: 'api', command: execPath, args: ['dist/main.js'], cwd: path.join(root, 'apps/api'), env: { ...base, PORT: apiPort } },
    {
      name: 'web',
      command: execPath,
      args: ['server.js'],
      cwd: path.join(root, 'apps/web'),
      env: { ...base, PORT: webPort, HOSTNAME: webHost },
    },
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const timeout = Number(process.env.SHUTDOWN_TIMEOUT_MS);
  const code = await supervise({
    children: buildChildren(),
    signals: process,
    ...(Number.isFinite(timeout) && timeout > 0 ? { shutdownTimeoutMs: timeout } : {}),
  });
  process.exit(code);
}
