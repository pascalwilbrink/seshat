// In-memory stand-in for the Seshat API, used only by the browser harness (e2e/run.mjs).
// It serves fixture data (no real credentials or Workspace data) and has a tiny control
// endpoint (/__stub/mode) so the harness can force loading, empty and error states.
import { createServer } from 'node:http';

export const FIXTURE_USER = 'admin';
export const FIXTURE_PASSWORD = 'fixture-password-not-a-secret';
export const LONG_NAME = 'Quarterly-Research-Archive-With-An-Exceptionally-Long-Workspace-Name-That-Must-Never-Widen-The-Page';
export const LONG_SLUG = 'quarterly-research-archive-with-an-exceptionally-long-workspace-name-that-must-never-widen-the-page';

const seed = () => [
  { id: 'ws-acme', name: 'Acme', slug: 'acme', description: 'Fixture Workspace', createdAt: '2026-03-02T10:00:00.000Z', updatedAt: '2026-03-02T10:00:00.000Z' },
  { id: 'ws-beta', name: 'beta labs', slug: 'beta-labs', description: null, createdAt: '2026-04-02T10:00:00.000Z', updatedAt: '2026-04-02T10:00:00.000Z' },
  { id: 'ws-long', name: LONG_NAME, slug: LONG_SLUG, description: 'D'.repeat(300), createdAt: '2026-05-02T10:00:00.000Z', updatedAt: '2026-05-02T10:00:00.000Z' },
];

export function startStub(listenPort = 0) {
  let workspaces = seed();
  let mode = { workspaces: 'ok', overview: 'ok', delayMs: 0 };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || 'null') : null;
    const p = url.pathname;
    if (p === '/__stub/mode') {
      if (req.method === 'POST') {
        mode = { workspaces: 'ok', overview: 'ok', delayMs: 0, ...body };
        if (body?.reset) workspaces = seed();
        if (body?.empty) workspaces = [];
      }
      return send(res, 200, mode);
    }
    const authed = /(^|;\s*)seshat_session=fixture/.test(req.headers.cookie ?? '');
    if (p === '/api/auth/login' && req.method === 'POST') {
      if (body?.username === FIXTURE_USER && body?.password === FIXTURE_PASSWORD) return send(res, 200, { username: FIXTURE_USER }, { 'set-cookie': 'seshat_session=fixture; HttpOnly; Path=/; SameSite=Lax' });
      return send(res, 401, { message: 'Invalid credentials' });
    }
    if (p === '/api/auth/logout') return send(res, 204, undefined, { 'set-cookie': 'seshat_session=; Max-Age=0; Path=/' });
    if (!authed) return send(res, 401, { message: 'Unauthorized' });
    if (p === '/api/auth/me') return send(res, 200, { kind: 'admin', username: FIXTURE_USER });
    if (mode.delayMs) await new Promise((r) => setTimeout(r, mode.delayMs));
    if (p === '/api/global/workspaces') {
      if (mode.workspaces === 'error') return send(res, 500, { message: 'boom' });
      if (req.method === 'POST') {
        const ws = { id: `ws-${body.slug}`, name: body.name, slug: body.slug, description: body.description ?? null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        workspaces.push(ws);
        return send(res, 201, ws);
      }
      return send(res, 200, workspaces);
    }
    if (p === '/api/global/overview') {
      if (mode.overview === 'error') return send(res, 500, { message: 'boom' });
      return send(res, 200, { scope: 'global', name: 'Global' });
    }
    const m = p.match(/^\/api\/workspaces\/([^/]+)(\/overview)?$/);
    if (m) {
      const ws = workspaces.find((w) => w.id === decodeURIComponent(m[1]));
      if (!ws) return send(res, 404, { message: 'Not found' });
      if (m[2]) {
        if (mode.overview === 'error') return send(res, 500, { message: 'boom' });
        return send(res, 200, { scope: 'workspace', id: ws.id, name: ws.name, slug: ws.slug, description: ws.description, createdAt: ws.createdAt });
      }
      if (req.method === 'PUT') {
        Object.assign(ws, { name: body.name, description: body.description || null });
        return send(res, 200, ws);
      }
      if (req.method === 'DELETE') {
        workspaces = workspaces.filter((w) => w !== ws);
        return send(res, 204);
      }
      return send(res, 200, ws);
    }
    return send(res, 404, { message: 'Not found' });
  });
  return new Promise((resolve) => server.listen(listenPort, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
