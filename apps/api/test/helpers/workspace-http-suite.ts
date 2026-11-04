import { randomUUID } from 'node:crypto';
import { expect, it, describe } from 'vitest';
import type { AuthorizationService } from '../../src/auth/authorization.service.js';
import { DenyingAuthorization, type WorkspaceApp } from './workspace-app.js';

export interface Harness {
  app: WorkspaceApp;
  /** Makes the next delete transaction fail with this error (undefined = not supported by the harness). */
  failDelete?: (err: unknown) => void;
  countRows(): Promise<number>;
}

/** Shared HTTP-level behaviour, run against an in-memory repository and against real PostgreSQL. */
export function defineWorkspaceHttpSuite(h: { boot(opts?: { authorization?: AuthorizationService }): Promise<Harness> }): void {
  const create = (app: WorkspaceApp, body: unknown) => app.request('POST', '/api/global/workspaces', body);

  it('requires a session on every route', async () => {
    const { app } = await h.boot();
    const id = randomUUID();
    for (const [m, p] of [
      ['GET', '/api/global/workspaces'],
      ['POST', '/api/global/workspaces'],
      ['GET', `/api/workspaces/${id}`],
      ['PATCH', `/api/workspaces/${id}`],
      ['DELETE', `/api/workspaces/${id}`],
      ['GET', '/api/global/overview'],
      ['GET', `/api/workspaces/${id}/overview`],
    ] as const) {
      expect((await app.request(m, p, m === 'GET' ? undefined : {}, { cookie: null })).status, `${m} ${p}`).toBe(401);
    }
  });

  it('runs full CRUD with DTO output', async () => {
    const { app } = await h.boot();
    expect((await app.request('GET', '/api/global/workspaces')).json).toEqual([]);

    const created = await create(app, { name: '  Graphnous  ', description: 'Notes' });
    expect(created.status).toBe(201);
    expect(Object.keys(created.json).sort()).toEqual(['createdAt', 'description', 'id', 'name', 'slug', 'updatedAt']);
    expect(created.json).toMatchObject({ name: 'Graphnous', slug: 'graphnous', description: 'Notes' });
    const id = created.json.id as string;

    expect((await app.request('GET', '/api/global/workspaces')).json).toHaveLength(1);
    expect((await app.request('GET', `/api/workspaces/${id}`)).json).toMatchObject({ id, slug: 'graphnous' });

    const renamed = await app.request('PATCH', `/api/workspaces/${id}`, { name: 'Graph', description: null });
    expect(renamed.status).toBe(200);
    expect(renamed.json).toMatchObject({ id, name: 'Graph', slug: 'graphnous', description: null });

    const ov = await app.request('GET', `/api/workspaces/${id}/overview`);
    expect(ov.json).toEqual({
      scope: 'workspace',
      id,
      name: 'Graph',
      slug: 'graphnous',
      description: null,
      createdAt: created.json.createdAt,
    });
    expect((await app.request('GET', '/api/global/overview')).json).toEqual({ scope: 'global', name: 'Global' });

    const del = await app.request('DELETE', `/api/workspaces/${id}`, { slug: 'graphnous' });
    expect(del.status).toBe(204);
    expect((await app.request('GET', `/api/workspaces/${id}`)).status).toBe(404);
  });

  it('derives and validates slugs', async () => {
    const { app } = await h.boot();
    expect((await create(app, { name: 'Café & Friends -- 2!' })).json.slug).toBe('cafe-friends-2');
    expect((await create(app, { name: 'x', slug: 'custom-slug' })).json.slug).toBe('custom-slug');
    for (const body of [
      { name: 'a', slug: 'global' },
      { name: 'a', slug: 'Upper' },
      { name: 'a', slug: 'a--b' },
      { name: 'a', slug: '-a' },
      { name: 'a', slug: 'x'.repeat(101) },
      { name: '!!!' },
      { name: 'Global' },
    ]) {
      expect((await create(app, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('answers slug collisions with a sanitized 409', async () => {
    const { app } = await h.boot();
    await create(app, { name: 'Dup' });
    const explicit = await create(app, { name: 'Other', slug: 'dup' });
    const derived = await create(app, { name: 'DUP' });
    for (const r of [explicit, derived]) {
      expect(r.status).toBe(409);
      expect(r.json).toEqual({ statusCode: 409, message: 'A Workspace with this slug already exists', error: 'Conflict' });
      expect(r.text).not.toMatch(/SENTINEL|UQ_workspaces|duplicate key/i);
    }
  });

  it('rejects invalid input with sanitized 400s', async () => {
    const { app } = await h.boot();
    const SECRET = 'SENTINEL-body-secret-42';
    const bad = [
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { name: 5 },
      {},
      { name: 'ok', description: 'd'.repeat(2001) },
      { name: 'ok', password: SECRET },
      { name: 'ok', id: SECRET },
    ];
    for (const body of bad) {
      const r = await create(app, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.text).not.toContain(SECRET);
    }
    expect((await app.request('POST', '/api/global/workspaces', '{"name": ' + SECRET)).status).toBe(400);
    const ws = (await create(app, { name: 'Fixed' })).json;
    for (const body of [{}, { slug: 'new-slug' }, { name: ' ' }, { name: 'ok', token: SECRET }, { name: null }]) {
      const r = await app.request('PATCH', `/api/workspaces/${ws.id}`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.text).not.toContain(SECRET);
    }
    expect((await app.request('GET', `/api/workspaces/${ws.id}`)).json.slug).toBe('fixed');
    for (const bad of ['not-a-uuid', 'global', '123', `${ws.id}x`]) {
      for (const [m, suffix] of [['GET', ''], ['PATCH', ''], ['DELETE', ''], ['GET', '/overview']] as const) {
        const r = await app.request(m, `/api/workspaces/${bad}${suffix}`, m === 'GET' ? undefined : { slug: 'x', name: 'x' });
        expect(r.status, `${m} ${bad}${suffix}`).toBe(400);
      }
    }
  });

  it('requires the exact slug to delete and never deletes on failure', async () => {
    const { app, countRows } = await h.boot();
    const events: unknown[] = [];
    app.events.on('workspace.deleted', (e) => events.push(e));
    const ws = (await create(app, { name: 'Keep Me' })).json;
    for (const body of [undefined, {}, { slug: 'keep' }, { slug: 'KEEP-ME' }, { slug: 'keep-me ' }, { slug: 1 }, { slug: 'keep-me', extra: 1 }]) {
      expect((await app.request('DELETE', `/api/workspaces/${ws.id}`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await countRows()).toBe(1);
    expect(events).toEqual([]);
    expect((await app.request('DELETE', `/api/workspaces/${ws.id}`, { slug: 'keep-me' })).status).toBe(204);
    expect(await countRows()).toBe(0);
    expect(events).toEqual([{ id: ws.id }]);
    // deleting again: missing -> 404, no second event
    expect((await app.request('DELETE', `/api/workspaces/${ws.id}`, { slug: 'keep-me' })).status).toBe(404);
    expect(events).toHaveLength(1);
  });

  it('emits nothing and leaks nothing when the delete fails', async () => {
    const harness = await h.boot();
    if (!harness.failDelete) return;
    const { app, countRows } = harness;
    const events: unknown[] = [];
    app.events.on('workspace.deleted', (e) => events.push(e));
    const ws = (await create(app, { name: 'Stays' })).json;
    harness.failDelete(Object.assign(new Error('connection to 10.0.0.9 refused SENTINEL-driver-secret'), { driverError: { code: '08006' } }));
    const r = await app.request('DELETE', `/api/workspaces/${ws.id}`, { slug: 'stays' });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(r.text).not.toContain('SENTINEL');
    expect(app.logs.lines.join('\n')).not.toContain('SENTINEL');
    expect(events).toEqual([]);
    expect(await countRows()).toBe(1);
  });

  describe('missing vs denied Workspace (injected policy refusal)', () => {
    const routes = (id: string) =>
      [
        ['GET', `/api/workspaces/${id}`, undefined],
        ['PATCH', `/api/workspaces/${id}`, { name: 'n' }],
        ['DELETE', `/api/workspaces/${id}`, { slug: 'denied-ws' }],
        ['GET', `/api/workspaces/${id}/overview`, undefined],
      ] as const;

    it('returns byte-identical 404 bodies', async () => {
      // Seed with the allowing policy, then compare against a denying policy in a second app on the same data.
      const allow = await h.boot();
      const ws = (await create(allow.app, { name: 'Denied WS' })).json;
      const missing = randomUUID();
      const missingResponses = await Promise.all(routes(missing).map(([m, p, b]) => allow.app.request(m, p, b)));
      const deny = await h.boot({ authorization: new DenyingAuthorization('all') });
      const deniedResponses = await Promise.all(routes(ws.id).map(([m, p, b]) => deny.app.request(m, p, b)));
      for (let i = 0; i < missingResponses.length; i++) {
        expect(missingResponses[i]!.status).toBe(404);
        expect(deniedResponses[i]!.status).toBe(404);
        expect(deniedResponses[i]!.text).toBe(missingResponses[i]!.text);
      }
      expect(deniedResponses[0]!.json).toEqual({ statusCode: 404, message: 'Not Found', error: 'Not Found' });
    });

    it('denies collection operations under Global with 403 and does not touch data', async () => {
      const deny = await h.boot({ authorization: new DenyingAuthorization(new Set(['workspace:list', 'workspace:create', 'overview:read'])) });
      expect((await deny.app.request('GET', '/api/global/workspaces')).status).toBe(403);
      expect((await create(deny.app, { name: 'Nope' })).status).toBe(403);
      expect((await deny.app.request('GET', '/api/global/overview')).status).toBe(403);
      expect(await deny.countRows()).toBe(0);
    });
  });
}
